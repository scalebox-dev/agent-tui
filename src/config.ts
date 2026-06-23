import { z } from "zod";
import { ensureRuntime, runtime } from "./runtime/index.js";
import type { ShellIsolationMode, ShellIsolationPreferences } from "./workbench/shell-isolation.js";

export const defaultBaseURL = "https://api.agentsway.dev";
export const configFile = "profiles.json";
export const appConfigurationFile = "configuration.json";
export const conversationsFile = "conversations.json";

export type AuthProfile =
  | {
      type: "api_key";
      apiKey: string;
    }
  | {
      type: "browser";
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: number;
      refreshTokenExpiresAt?: number;
    };

export interface Profile {
  name: string;
  baseURL: string;
  auth: AuthProfile;
  createdAt: number;
  updatedAt: number;
}

export interface CLIConfig {
  activeProfile: string;
  profiles: Record<string, Profile>;
}

export interface ConversationState {
  name: string;
  profile: string;
  previousResponseId?: string;
  updatedAt: number;
}

export interface WorkbenchPreferences {
  defaultPreset?: string | null;
  isolation?: ShellIsolationPreferences;
}

const authProfileSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api_key"),
    apiKey: z.string(),
  }),
  z.object({
    type: z.literal("browser"),
    accessToken: z.string(),
    refreshToken: z.string(),
    accessTokenExpiresAt: z.number(),
    refreshTokenExpiresAt: z.number().optional(),
  }),
]);

const profileSchema = z.object({
  name: z.string(),
  baseURL: z.string(),
  auth: authProfileSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const conversationSchema = z.object({
  name: z.string(),
  profile: z.string(),
  previousResponseId: z.string().optional(),
  updatedAt: z.number(),
});

const workbenchPreferencesSchema = z.object({
  defaultPreset: z.string().nullable().optional(),
  isolation: z.object({
    mode: z.enum(["none", "auto", "required"]).optional(),
    executablePath: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
    sourceURL: z.string().nullable().optional(),
    sha256: z.string().nullable().optional(),
    installSkipped: z.boolean().nullable().optional(),
  }).optional(),
}).default({});

const cliConfigSchema = z.object({
  activeProfile: z.string().default("default"),
  profiles: z.record(z.string(), profileSchema).default({}),
  conversations: z.record(z.string(), conversationSchema).default({}),
});

export interface AppConfiguration {
  workbench: WorkbenchPreferences;
}

export interface ConversationConfiguration {
  conversations: Record<string, ConversationState>;
}

const appConfigurationSchema = z.object({
  workbench: workbenchPreferencesSchema,
});

const conversationConfigurationSchema = z.object({
  conversations: z.record(z.string(), conversationSchema).default({}),
});

export async function loadConfig(): Promise<CLIConfig> {
  await ensureRuntime();
  const loaded = await runtime.config.read<unknown>(configFile, emptyConfig());
  const parsed = cliConfigSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid CLI config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export async function saveConfig(config: CLIConfig): Promise<void> {
  await ensureRuntime();
  await runtime.config.write(configFile, {
    activeProfile: config.activeProfile,
    profiles: config.profiles,
  });
}

export async function loadAppConfiguration(): Promise<AppConfiguration> {
  await ensureRuntime();
  const loaded = await runtime.config.read<unknown>(appConfigurationFile, emptyAppConfiguration());
  const parsed = appConfigurationSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid app configuration: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export async function saveAppConfiguration(config: AppConfiguration): Promise<void> {
  await ensureRuntime();
  await runtime.config.write(appConfigurationFile, config);
}

export async function loadConversationConfiguration(): Promise<ConversationConfiguration> {
  await ensureRuntime();
  const loaded = await runtime.config.read<unknown>(conversationsFile, emptyConversationConfiguration());
  const parsed = conversationConfigurationSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid conversation configuration: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export async function saveConversationConfiguration(config: ConversationConfiguration): Promise<void> {
  await ensureRuntime();
  await runtime.config.write(conversationsFile, config);
}

export async function upsertProfile(profile: Omit<Profile, "createdAt" | "updatedAt">): Promise<Profile> {
  const config = await loadConfig();
  const now = Math.floor(Date.now() / 1000);
  const existing = config.profiles[profile.name];
  const next: Profile = {
    ...profile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  config.profiles[profile.name] = next;
  config.activeProfile = profile.name;
  await saveConfig(config);
  return next;
}

export async function activeProfile(profileName?: string): Promise<Profile> {
  const config = await loadConfig();
  const name = profileName || config.activeProfile || "default";
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Profile not found: ${name}. Run agent-api login first.`);
  }
  return profile;
}

export function emptyConfig(): CLIConfig {
  return { activeProfile: "default", profiles: {} };
}

export function emptyAppConfiguration(): AppConfiguration {
  return { workbench: {} };
}

export function emptyConversationConfiguration(): ConversationConfiguration {
  return { conversations: {} };
}

export async function loadWorkbenchPreferences(): Promise<WorkbenchPreferences> {
  const appConfig = await loadAppConfiguration();
  return appConfig.workbench;
}

export async function updateWorkbenchPreferences(patch: {
  defaultPreset?: string | null | undefined;
  isolation?: {
    mode?: ShellIsolationMode | null | undefined;
    executablePath?: string | null | undefined;
    version?: string | null | undefined;
    sourceURL?: string | null | undefined;
    sha256?: string | null | undefined;
    installSkipped?: boolean | null | undefined;
  };
}): Promise<WorkbenchPreferences> {
  const appConfig = await loadAppConfiguration();
  const next: WorkbenchPreferences = { ...appConfig.workbench };
  if ("defaultPreset" in patch) {
    if (patch.defaultPreset === undefined) {
      delete next.defaultPreset;
    } else if (patch.defaultPreset === null) {
      next.defaultPreset = null;
    } else {
      const value = patch.defaultPreset.trim();
      if (value) {
        next.defaultPreset = value;
      } else {
        delete next.defaultPreset;
      }
    }
  }
  if ("isolation" in patch) {
    next.isolation = updateIsolationPreferences(next.isolation, patch.isolation);
  }
  appConfig.workbench = next;
  await saveAppConfiguration(appConfig);
  return next;
}

function updateIsolationPreferences(
  current: ShellIsolationPreferences | undefined,
  patch: {
    mode?: ShellIsolationMode | null | undefined;
    executablePath?: string | null | undefined;
    version?: string | null | undefined;
    sourceURL?: string | null | undefined;
    sha256?: string | null | undefined;
    installSkipped?: boolean | null | undefined;
  } | undefined,
): ShellIsolationPreferences | undefined {
  const next: ShellIsolationPreferences = { ...(current ?? {}) };
  if (!patch) return Object.keys(next).length > 0 ? next : undefined;
  if ("mode" in patch) {
    if (patch.mode === null || patch.mode === undefined) {
      delete next.mode;
    } else {
      next.mode = patch.mode;
    }
  }
  for (const key of ["executablePath", "version", "sourceURL", "sha256"] as const) {
    if (key in patch) {
      const value = patch[key];
      if (value === undefined || value === null) {
        delete next[key];
      } else {
        const trimmed = value.trim();
        if (trimmed) next[key] = trimmed;
        else delete next[key];
      }
    }
  }
  if ("installSkipped" in patch) {
    if (patch.installSkipped === undefined || patch.installSkipped === null) {
      delete next.installSkipped;
    } else {
      next.installSkipped = patch.installSkipped;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function redactSecret(value: string): string {
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
