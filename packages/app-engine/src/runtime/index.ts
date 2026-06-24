import { createLocalRuntime } from "@agent-api/sdk/local";
import type { LocalRuntime, LocalRuntimeOptions } from "@agent-api/sdk/local";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFileStorage, type AppEngineStorage } from "../storage/index.js";

export const defaultAppName = "agent-tui";
export const defaultAppAuthor = "AgentsWay";
export const defaultAppVersion = "0.3.1";
const defaultLegacyAppName = "agent-api-cli";

export interface AgentAppRuntimeOptions extends Omit<LocalRuntimeOptions, "appName" | "appAuthor"> {
  appName?: string;
  appAuthor?: string;
  appVersion?: string;
  legacyAppName?: string | null;
  storage?: AppEngineStorage;
}

export interface AgentAppRuntimeContext {
  appName: string;
  appAuthor: string;
  appVersion: string;
  legacyAppName?: string | null;
  runtime: LocalRuntime;
  legacyRuntime?: LocalRuntime;
  storage: AppEngineStorage;
  storageProvided: boolean;
}

let migrationPromise: Promise<void> | null = null;
let runtimeContext = createRuntimeContext();

export let runtime = runtimeContext.runtime;

export function configureAgentAppRuntime(options: AgentAppRuntimeOptions = {}): AgentAppRuntimeContext {
  runtimeContext = createRuntimeContext(options);
  runtime = runtimeContext.runtime;
  migrationPromise = null;
  return runtimeContext;
}

export function currentAgentAppRuntime(): AgentAppRuntimeContext {
  return runtimeContext;
}

export function appVersion() {
  return runtimeContext.appVersion;
}

export async function ensureRuntime() {
  if (!runtimeContext.storageProvided) {
    migrationPromise ??= migrateLegacyRuntime();
    await migrationPromise;
  }
  await runtime.ensure();
  if (!runtimeContext.storageProvided) {
    await splitMonolithicConfig();
  }
  return runtime;
}

async function migrateLegacyRuntime() {
  if (!runtimeContext.legacyRuntime) return;
  await migrateLegacyConfigDirectory(runtimeContext.legacyRuntime);
  for (const key of ["data", "cache", "logs"] as const) {
    await moveDirectoryIfNeeded(runtimeContext.legacyRuntime.dirs[key], runtime.dirs[key]);
  }
}

async function moveDirectoryIfNeeded(from: string, to: string) {
  if (from === to || !(await isDirectory(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  if (await pathExists(to)) {
    await cp(from, to, { recursive: true, errorOnExist: false, force: false });
    await rm(from, { recursive: true, force: true });
    return;
  }
  try {
    await rename(from, to);
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: false });
    await rm(from, { recursive: true, force: true });
  }
}

async function migrateLegacyConfigDirectory(legacyRuntime: LocalRuntime) {
  const from = legacyRuntime.dirs.config;
  const to = runtime.dirs.config;
  if (from === to || !(await isDirectory(from))) return;
  await mkdir(to, { recursive: true });

  const legacyProfilesPath = path.join(from, "profiles.json");
  const profilesPath = path.join(to, "profiles.json");
  const legacyRaw = await readJSONRecord(legacyProfilesPath);
  if (legacyRaw) {
    const nextRaw = await readJSONRecord(profilesPath) ?? {};
    const legacyProfiles = recordValue(legacyRaw.profiles);
    const nextProfiles = recordValue(nextRaw.profiles);
    const mergedProfiles = { ...legacyProfiles, ...nextProfiles };
    const activeProfile = typeof nextRaw.activeProfile === "string"
      ? nextRaw.activeProfile
      : typeof legacyRaw.activeProfile === "string"
        ? legacyRaw.activeProfile
        : "default";
    await writeJSON(profilesPath, { ...nextRaw, activeProfile, profiles: mergedProfiles });

    const configurationPath = path.join(to, "configuration.json");
    if ("workbench" in legacyRaw && !(await pathExists(configurationPath))) {
      await writeJSON(configurationPath, { workbench: recordValue(legacyRaw.workbench) });
    }

    const conversationsPath = path.join(to, "conversations.json");
    if ("conversations" in legacyRaw && !(await pathExists(conversationsPath))) {
      await writeJSON(conversationsPath, { conversations: recordValue(legacyRaw.conversations) });
    }
  }

  await copyFileIfMissing(path.join(from, "configuration.json"), path.join(to, "configuration.json"));
  await copyFileIfMissing(path.join(from, "conversations.json"), path.join(to, "conversations.json"));
  await rm(from, { recursive: true, force: true });
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

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
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

async function copyFileIfMissing(from: string, to: string) {
  if (!(await pathExists(from)) || await pathExists(to)) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { errorOnExist: true, force: false });
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

function createRuntimeContext(options: AgentAppRuntimeOptions = {}): AgentAppRuntimeContext {
  const appName = options.appName || defaultAppName;
  const appAuthor = options.appAuthor || defaultAppAuthor;
  const appVersion = options.appVersion || defaultAppVersion;
  const runtimeOptions = { ...options, appName, appAuthor };
  delete (runtimeOptions as Partial<AgentAppRuntimeOptions>).appVersion;
  delete (runtimeOptions as Partial<AgentAppRuntimeOptions>).legacyAppName;
  delete (runtimeOptions as Partial<AgentAppRuntimeOptions>).storage;
  const legacyAppName = "legacyAppName" in options ? options.legacyAppName : defaultLegacyAppName;
  const localRuntime = createLocalRuntime(runtimeOptions);
  return {
    appName,
    appAuthor,
    appVersion,
    legacyAppName,
    runtime: localRuntime,
    legacyRuntime: legacyAppName ? createLocalRuntime({ ...runtimeOptions, appName: legacyAppName }) : undefined,
    storage: options.storage ?? createFileStorage(localRuntime.config),
    storageProvided: Boolean(options.storage),
  };
}
