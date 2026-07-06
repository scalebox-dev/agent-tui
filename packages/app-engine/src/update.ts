import { appVersion } from "./runtime/index.js";
import { spawn } from "node:child_process";

export interface UpdateCheckResult {
  current: string;
  latest: string;
  packageName: string;
  updateAvailable: boolean;
}

export interface UpdateCheckOptions {
  currentVersion?: string;
  packageName?: string;
  registryURL?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UpdateInstallResult {
  command: string;
  output: string;
}

export interface UpdateNoticeOptions {
  installPlan?: UpdateInstallPlan;
}

export interface UpdateInstallOptions {
  installPlan?: UpdateInstallPlan;
}

export interface UpdateInstallPlan {
  command: string;
  args: string[];
  cwd?: string;
  scope: "global" | "local";
}

const defaultPackageName = "@agent-api/cli";
const defaultRegistryURL = "https://registry.npmjs.org";
const defaultUpdateTimeoutMs = 15_000;

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult | null> {
  const packageName = options.packageName || process.env.AGENT_TUI_UPDATE_PACKAGE || defaultPackageName;
  const current = options.currentVersion || appVersion();
  const registryURL = (options.registryURL || process.env.AGENT_TUI_NPM_REGISTRY || defaultRegistryURL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? positiveInt(process.env.AGENT_TUI_UPDATE_TIMEOUT_MS, defaultUpdateTimeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = combineSignals(options.signal, controller.signal);
  try {
    const response = await fetch(`${registryURL}/${encodeURIComponent(packageName).replace(/^%40/, "@")}/latest`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => undefined) as { version?: unknown } | undefined;
    const latest = typeof payload?.version === "string" ? payload.version : "";
    if (!latest) return null;
    return {
      current,
      latest,
      packageName,
      updateAvailable: compareVersions(latest, current) > 0,
    };
  } catch {
  return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatUpdateNotice(result: UpdateCheckResult, options: UpdateNoticeOptions = {}): string {
  const plan = options.installPlan ?? globalUpdateInstallPlan(result);
  return `Update available: ${result.packageName} ${result.current} -> ${result.latest}. Run: ${formatInstallPlan(plan)}`;
}

export async function installUpdate(result: UpdateCheckResult, options: UpdateInstallOptions = {}): Promise<UpdateInstallResult> {
  const plan = options.installPlan ?? globalUpdateInstallPlan(result);
  const output = await runCommand(plan.command, plan.args, { cwd: plan.cwd });
  return {
    command: formatInstallPlan(plan),
    output,
  };
}

export function globalUpdateInstallPlan(result: Pick<UpdateCheckResult, "packageName">): UpdateInstallPlan {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return { command: executable, args: ["install", "-g", `${result.packageName}@latest`], scope: "global" };
}

export function localUpdateInstallPlan(result: Pick<UpdateCheckResult, "packageName">, cwd: string): UpdateInstallPlan {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return { command: executable, args: ["install", `${result.packageName}@latest`], cwd, scope: "local" };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function positiveInt(value: string | number | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function runCommand(command: string, args: string[], options: { cwd?: string } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
        return;
      }
      reject(new Error(formatCommandFailure(command, args, code, output)));
    });
  });
}

function formatInstallPlan(plan: UpdateInstallPlan): string {
  const rendered = `${plan.command} ${plan.args.join(" ")}`;
  return plan.cwd ? `${rendered} --prefix ${plan.cwd}` : rendered;
}

function formatCommandFailure(command: string, args: string[], code: number | null, output: string): string {
  const commandText = `${command} ${args.join(" ")}`;
  const trimmed = output.trim();
  if (/\bEACCES\b|permission denied/i.test(trimmed)) {
    return [
      `${commandText} failed because the npm install location is not writable by the current user.`,
      "Use a user-owned npm prefix, run the matching install command manually with the required privileges, or reinstall agent-tui without sudo.",
      trimmed,
    ].filter(Boolean).join("\n");
  }
  return `${commandText} failed with exit code ${code}${trimmed ? `\n${trimmed}` : ""}`;
}
