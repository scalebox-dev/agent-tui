import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { runtime } from "../runtime/index.js";

export interface IsolatorInstallConfig {
  sourceURL?: string | null;
  executablePath?: string | null;
  sha256?: string | null;
}

export interface IsolatorInstallResult {
  executablePath: string;
  sourceURL: string;
  bytes: number;
  sha256: string;
  replaced: boolean;
}

export interface IsolatorEnsureResult {
  executablePath: string;
  sourceURL: string;
  sha256?: string | null;
  repaired: boolean;
}

export interface IsolatorInstallOptions {
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
}

export async function installConfiguredIsolator(
  config: IsolatorInstallConfig,
  options: IsolatorInstallOptions = {},
): Promise<IsolatorInstallResult> {
  const sourceURL = normalizeSourceURL(config.sourceURL);
  const executablePath = normalizeInstallPath(config.executablePath);
  const targetDir = path.dirname(executablePath);
  const existing = await existingTargetState(executablePath);
  await mkdir(targetDir, { recursive: true });
  await ensureWritableDirectory(targetDir);

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(sourceURL);
  if (!response.ok) {
    throw new Error(`isolator download failed: HTTP ${response.status}`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length === 0) {
    throw new Error("isolator download failed: empty response body");
  }
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  const expectedSha256 = config.sha256?.trim().toLowerCase();
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(`isolator checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const tempPath = path.join(targetDir, `.${path.basename(executablePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, body, { mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(tempPath, 0o700);
    }
    await probeIsolator(tempPath, options.probeTimeoutMs ?? 10_000);
    await rename(tempPath, executablePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return {
    executablePath,
    sourceURL,
    bytes: body.length,
    sha256: actualSha256,
    replaced: existing === "file",
  };
}

export async function validateInstalledIsolator(executablePath: string, options: Pick<IsolatorInstallOptions, "probeTimeoutMs"> = {}) {
  const normalized = normalizeInstallPath(executablePath);
  const state = await existingTargetState(normalized);
  if (state !== "file") {
    throw new Error(`isolator executable does not exist: ${normalized}`);
  }
  await probeIsolator(normalized, options.probeTimeoutMs ?? 10_000);
  return normalized;
}

export async function validateIsolatorInstallTarget(value: string) {
  const normalized = await normalizeInstallTargetPath(value);
  const targetDir = path.dirname(normalized);
  await mkdir(targetDir, { recursive: true });
  await ensureWritableDirectory(targetDir);
  await existingTargetState(normalized);
  return normalized;
}

export async function ensureConfiguredIsolator(
  config: IsolatorInstallConfig,
  options: IsolatorInstallOptions = {},
): Promise<IsolatorEnsureResult> {
  const sourceURL = normalizeSourceURL(config.sourceURL);
  const executablePath = normalizeInstallPath(config.executablePath);
  try {
    await validateInstalledIsolator(executablePath, options);
    return {
      executablePath,
      sourceURL,
      sha256: config.sha256,
      repaired: false,
    };
  } catch {
    const result = await installConfiguredIsolator({ sourceURL, executablePath, sha256: config.sha256 }, options);
    return {
      executablePath: result.executablePath,
      sourceURL: result.sourceURL,
      sha256: result.sha256,
      repaired: true,
    };
  }
}

export async function relocateInstalledIsolator(
  fromPath: string,
  toPath: string,
  options: Pick<IsolatorInstallOptions, "probeTimeoutMs"> = {},
) {
  const source = await validateInstalledIsolator(fromPath, options);
  const target = normalizeInstallPath(toPath);
  if (source === target) return target;
  const targetDir = path.dirname(target);
  await existingTargetState(target);
  await mkdir(targetDir, { recursive: true });
  await ensureWritableDirectory(targetDir);
  const tempPath = path.join(targetDir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await copyFile(source, tempPath);
    if (process.platform !== "win32") {
      await chmod(tempPath, 0o700);
    }
    await probeIsolator(tempPath, options.probeTimeoutMs ?? 10_000);
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return target;
}

export function defaultIsolatorInstallPath() {
  return path.join(runtime.dirs.data, "bin", process.platform === "win32" ? "agent-isolator.exe" : "agent-isolator");
}

export async function normalizeInstallTargetPath(value: string | null | undefined) {
  const normalized = normalizeInstallPath(value);
  try {
    const info = await stat(normalized);
    if (info.isDirectory()) {
      return path.join(normalized, process.platform === "win32" ? "agent-isolator.exe" : "agent-isolator");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return normalized;
}

export function normalizeSourceURL(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error("isolator sourceURL is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("isolator sourceURL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("isolator sourceURL must use https");
  }
  return url.toString();
}

export function normalizeInstallPath(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error("isolator executablePath is required");
  if (!path.isAbsolute(trimmed)) {
    throw new Error("isolator executablePath must be absolute");
  }
  const normalized = path.normalize(trimmed);
  const root = path.parse(normalized).root;
  if (normalized === root) {
    throw new Error("isolator executablePath cannot be a filesystem root");
  }
  if (path.basename(normalized).startsWith(".")) {
    throw new Error("isolator executablePath must not be a hidden temp-style filename");
  }
  return normalized;
}

async function existingTargetState(file: string): Promise<"missing" | "file"> {
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      throw new Error(`isolator executablePath exists but is not a file: ${file}`);
    }
    return "file";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensureWritableDirectory(dir: string) {
  try {
    await access(dir, fsConstants.W_OK);
  } catch {
    throw new Error(`isolator target directory is not writable: ${dir}`);
  }
}

async function probeIsolator(executablePath: string, timeoutMs: number) {
  const request = JSON.stringify({ id: "status", method: "status", params: {} });
  const child = spawn(executablePath, ["--once", "--driver=auto"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  child.stdin.end(`${request}\n`);

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("isolator probe timed out"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  const stdout = Buffer.concat(chunks).toString("utf8").trim();
  const stderr = Buffer.concat(errors).toString("utf8").trim();
  if (code !== 0) {
    throw new Error(stderr || stdout || `isolator probe failed with exit code ${code}`);
  }
  const line = stdout.split(/\r?\n/).find(Boolean);
  if (!line) throw new Error("isolator probe returned no response");
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("isolator probe returned invalid JSON");
  }
  if (parsed?.error) {
    throw new Error(parsed.error.message || parsed.error.code || "isolator probe failed");
  }
  if (!parsed?.result?.status?.driver) {
    throw new Error("isolator probe response did not include shell isolation status");
  }
}
