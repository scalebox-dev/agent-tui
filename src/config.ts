import { z } from "zod";
import { runtime } from "./runtime/index.js";

export const defaultBaseURL = "https://api.agentsway.dev";
export const configFile = "profiles.json";

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
  conversations: Record<string, ConversationState>;
  workbench: WorkbenchPreferences;
}

export interface ConversationState {
  name: string;
  profile: string;
  previousResponseId?: string;
  updatedAt: number;
}

export interface WorkbenchPreferences {
  defaultPreset?: string | null;
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
}).default({});

const cliConfigSchema = z.object({
  activeProfile: z.string().default("default"),
  profiles: z.record(z.string(), profileSchema).default({}),
  conversations: z.record(z.string(), conversationSchema).default({}),
  workbench: workbenchPreferencesSchema,
});

export async function loadConfig(): Promise<CLIConfig> {
  await runtime.ensure();
  const loaded = await runtime.config.read<unknown>(configFile, emptyConfig());
  const parsed = cliConfigSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid CLI config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export async function saveConfig(config: CLIConfig): Promise<void> {
  await runtime.ensure();
  await runtime.config.write(configFile, config);
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
  return { activeProfile: "default", profiles: {}, conversations: {}, workbench: {} };
}

export async function loadWorkbenchPreferences(): Promise<WorkbenchPreferences> {
  const config = await loadConfig();
  return config.workbench;
}

export async function updateWorkbenchPreferences(patch: { defaultPreset?: string | null | undefined }): Promise<WorkbenchPreferences> {
  const config = await loadConfig();
  const next: WorkbenchPreferences = { ...config.workbench };
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
  config.workbench = next;
  await saveConfig(config);
  return next;
}

export function redactSecret(value: string): string {
  if (value.length <= 10) return "***";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
