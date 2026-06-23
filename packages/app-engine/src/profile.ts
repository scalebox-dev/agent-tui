import { AgentAPI, browserAuthSessionExpiresWithin, type ApprovedDeviceAuth } from "@agent-api/sdk";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import {
  activeProfile,
  defaultBaseURL,
  loadConfig,
  Profile,
  redactSecret,
  saveConfig,
  upsertProfile,
} from "./config.js";

const execFileAsync = promisify(execFile);

export interface RuntimeProfile {
  profile: Profile;
  token: string;
  client: AgentAPI;
}

export interface AuthStatus {
  profile: string;
  baseURL: string;
  authType: Profile["auth"]["type"];
  me?: unknown;
}

export class AuthSessionExpiredError extends Error {
  readonly profile: string;
  readonly baseURL: string;

  constructor(profile: Profile, message = "browser session refresh failed") {
    super([
      "Browser session expired or could not be refreshed.",
      `Run: agent-api auth login --profile ${profile.name} --base-url ${profile.baseURL}`,
      `Details: ${message}`,
    ].join("\n"));
    this.name = "AuthSessionExpiredError";
    this.profile = profile.name;
    this.baseURL = profile.baseURL;
  }
}

export async function loginWithAPIKey(options: { profile: string; baseURL?: string; apiKey: string }) {
  const profile = await upsertProfile({
    name: options.profile,
    baseURL: normalizeBaseURL(options.baseURL),
    auth: { type: "api_key", apiKey: options.apiKey.trim() },
  });
  return profile;
}

export async function loginWithBrowser(options: { profile: string; baseURL?: string; clientName?: string; openBrowser?: boolean }) {
  const baseURL = normalizeBaseURL(options.baseURL);
  const challenge = await startBrowserAuthChallenge({ baseURL, clientName: options.clientName });
  console.log(`Open this URL to authorize the CLI:\n${challenge.verification_uri_complete}\n`);
  console.log(`Code: ${formatDeviceUserCode(challenge.user_code)}\n`);
  if (options.openBrowser !== false) {
    await openBrowserURL(challenge.verification_uri_complete).catch((error) => {
      console.warn(`Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  console.log("Waiting for browser approval...");
  const session = await waitForBrowserAuthChallenge({
    baseURL,
    challenge,
    on_poll(result) {
      if (result.status && result.status !== "pending") {
        console.log(`Status: ${result.status}`);
      }
    },
  });
  const profile = await saveBrowserProfile(options.profile, baseURL, session);
  console.log(`Signed in as profile "${profile.name}".`);
  return profile;
}

export async function startBrowserAuthChallenge(options: { baseURL?: string; clientName?: string }) {
  const baseURL = normalizeBaseURL(options.baseURL);
  const client = new AgentAPI({ baseURL });
  return await client.auth.startDeviceAuth({ client_name: options.clientName || "Agent API CLI" });
}

export async function waitForBrowserAuthChallenge(options: {
  baseURL?: string;
  challenge: Awaited<ReturnType<typeof startBrowserAuthChallenge>>;
  on_poll?: Parameters<AgentAPI["auth"]["waitForDeviceAuth"]>[0]["on_poll"];
}) {
  const baseURL = normalizeBaseURL(options.baseURL);
  const client = new AgentAPI({ baseURL });
  return await client.auth.waitForDeviceAuth({
    device_code: options.challenge.device_code,
    interval_seconds: options.challenge.interval_seconds,
    timeout_ms: Math.max(0, options.challenge.expires_at * 1000 - Date.now()),
    on_poll: options.on_poll,
  });
}

export async function saveBrowserProfile(name: string, baseURL: string, session: ApprovedDeviceAuth) {
  return await upsertProfile({
    name,
    baseURL,
    auth: {
      type: "browser",
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      accessTokenExpiresAt: session.access_token_expires_at,
      refreshTokenExpiresAt: session.refresh_token_expires_at,
    },
  });
}

export async function resolveRuntimeProfile(profileName?: string): Promise<RuntimeProfile> {
  const { profile: fresh } = await refreshActiveProfileIfNeeded(profileName);
  const token = fresh.auth.type === "api_key" ? fresh.auth.apiKey : fresh.auth.accessToken;
  return {
    profile: fresh,
    token,
    client: new AgentAPI({ apiKey: token, baseURL: fresh.baseURL }),
  };
}

export async function getAuthStatus(profileName?: string): Promise<AuthStatus> {
  const runtime = await resolveRuntimeProfile(profileName);
  const response = await fetch(`${runtime.profile.baseURL}/v1/me`, {
    headers: { Authorization: `Bearer ${runtime.token}` },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload) || `whoami failed with ${response.status}`);
  }
  return {
    profile: runtime.profile.name,
    baseURL: runtime.profile.baseURL,
    authType: runtime.profile.auth.type,
    me: payload,
  };
}

export async function refreshActiveProfileIfNeeded(profileName?: string, refreshWindowMs = 60_000): Promise<{ profile: Profile; refreshed: boolean }> {
  const profile = await activeProfile(profileName);
  const shouldRefresh = browserAccessTokenExpiresWithin(profile, refreshWindowMs);
  const fresh = await refreshIfNeeded(profile, refreshWindowMs);
  return { profile: fresh, refreshed: shouldRefresh && profile.auth.type === "browser" };
}

export async function refreshIfNeeded(profile: Profile, refreshWindowMs = 60_000): Promise<Profile> {
  if (profile.auth.type !== "browser") return profile;
  const expiresAtMs = profile.auth.accessTokenExpiresAt * 1000;
  if (expiresAtMs - Date.now() > refreshWindowMs) return profile;
  const refreshed = await refreshBrowserSession(profile);
  const config = await loadConfig();
  config.profiles[profile.name] = refreshed;
  await saveConfig(config);
  return refreshed;
}

export function browserAccessTokenExpiresWithin(profile: Profile, refreshWindowMs: number, now = Date.now()) {
  if (profile.auth.type !== "browser") return false;
  return browserAuthSessionExpiresWithin(
    { access_token_expires_at: profile.auth.accessTokenExpiresAt },
    refreshWindowMs,
    now,
  );
}

export async function refreshBrowserSession(profile: Profile): Promise<Profile> {
  if (profile.auth.type !== "browser") return profile;
  const client = new AgentAPI({ baseURL: profile.baseURL });
  let session: Awaited<ReturnType<typeof client.auth.refreshBrowserSession>>;
  try {
    session = await client.auth.refreshBrowserSession({ refresh_token: profile.auth.refreshToken });
  } catch (error) {
    throw new AuthSessionExpiredError(profile, error instanceof Error ? error.message : String(error));
  }
  return {
    ...profile,
    auth: {
      type: "browser",
      accessToken: session.access_token,
      refreshToken: session.refresh_token || profile.auth.refreshToken,
      accessTokenExpiresAt: session.access_token_expires_at,
      refreshTokenExpiresAt: session.refresh_token_expires_at || profile.auth.refreshTokenExpiresAt,
    },
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

export async function listProfiles() {
  const config = await loadConfig();
  return { active: config.activeProfile, profiles: Object.values(config.profiles).sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function useProfile(name: string) {
  const config = await loadConfig();
  if (!config.profiles[name]) throw new Error(`Profile not found: ${name}`);
  config.activeProfile = name;
  await saveConfig(config);
}

export async function deleteProfile(name: string) {
  const config = await loadConfig();
  delete config.profiles[name];
  if (config.activeProfile === name) {
    config.activeProfile = Object.keys(config.profiles).sort()[0] || "default";
  }
  await saveConfig(config);
}

export function profileSummary(profile: Profile, active = false) {
  const auth = profile.auth.type === "api_key"
    ? `api_key ${redactSecret(profile.auth.apiKey)}`
    : `browser ${redactSecret(profile.auth.accessToken)}`;
  return `${active ? "*" : " "} ${profile.name}\t${profile.baseURL}\t${auth}`;
}

function errorMessageFromPayload(payload: unknown) {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function normalizeBaseURL(baseURL?: string) {
  return (baseURL || process.env.AGENT_API_BASE_URL || defaultBaseURL).replace(/\/+$/, "");
}

export function formatDeviceUserCode(code: string) {
  const normalized = code.replace(/[-\s]/g, "").toUpperCase();
  if (normalized.length <= 4) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export async function openBrowserURL(url: string) {
  const current = platform();
  if (current === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }
  if (current === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }
  await execFileAsync("xdg-open", [url]);
}
