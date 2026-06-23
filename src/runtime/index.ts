import { createLocalRuntime } from "@agent-api/sdk/local";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const cliName = "agent-tui";
export const cliAuthor = "AgentsWay";
export const cliVersion = "0.2.0";
const legacyCliName = "agent-api-cli";

export const runtime = createLocalRuntime({
  appName: cliName,
  appAuthor: cliAuthor,
});

const legacyRuntime = createLocalRuntime({
  appName: legacyCliName,
  appAuthor: cliAuthor,
});

let migrationPromise: Promise<void> | null = null;

export async function ensureRuntime() {
  migrationPromise ??= migrateLegacyRuntime();
  await migrationPromise;
  await runtime.ensure();
  await splitMonolithicConfig();
  return runtime;
}

async function migrateLegacyRuntime() {
  for (const key of ["config", "data", "cache", "logs"] as const) {
    await moveDirectoryIfNeeded(legacyRuntime.dirs[key], runtime.dirs[key]);
  }
}

async function moveDirectoryIfNeeded(from: string, to: string) {
  if (from === to || !(await isDirectory(from)) || await pathExists(to)) return;
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: false });
    await rm(from, { recursive: true, force: true });
  }
}

async function splitMonolithicConfig() {
  const profilesPath = path.join(runtime.dirs.config, "profiles.json");
  const raw = await readJSONRecord(profilesPath);
  if (!raw) return;

  let changed = false;
  if ("workbench" in raw && !(await pathExists(path.join(runtime.dirs.config, "configuration.json")))) {
    await writeJSON(path.join(runtime.dirs.config, "configuration.json"), { workbench: raw.workbench && typeof raw.workbench === "object" ? raw.workbench : {} });
  }
  if ("workbench" in raw) {
    delete raw.workbench;
    changed = true;
  }

  if ("conversations" in raw && !(await pathExists(path.join(runtime.dirs.config, "conversations.json")))) {
    await writeJSON(path.join(runtime.dirs.config, "conversations.json"), {
      conversations: raw.conversations && typeof raw.conversations === "object" ? raw.conversations : {},
    });
  }
  if ("conversations" in raw) {
    delete raw.conversations;
    changed = true;
  }

  if (changed) {
    await writeJSON(profilesPath, raw);
  }
}

async function readJSONRecord(file: string): Promise<Record<string, any> | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJSON(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(file: string) {
  try {
    await stat(file);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(file: string) {
  try {
    return (await stat(file)).isDirectory();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
