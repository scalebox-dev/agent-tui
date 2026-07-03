import {
  AgentAPI,
  APIConnectionError,
  APIError,
  AuthenticationError,
  browserAuthSessionExpiresWithin,
  isRetryableStatus,
  type ApprovedDeviceAuth,
} from "@agent-api/sdk";
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

export interface CurrentWorkspaceIdentity {
  apiKeyId?: string;
  authMethod?: string;
  scopes: string[];
  userId: string;
  userStatus?: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRole: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug?: string;
  role: string;
  status: string;
  membershipStatus: string;
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

export class AuthSessionUnavailableError extends Error {
  readonly profile: string;
  readonly baseURL: string;

  constructor(profile: Profile, message = "browser session refresh unavailable") {
    super([
      "Browser session could not be refreshed because the API is temporarily unavailable.",
      "The existing local session will be kept and refresh will be retried later.",
      `Details: ${message}`,
    ].join("\n"));
    this.name = "AuthSessionUnavailableError";
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
  const apiKeyProvider = async () => {
    const { profile: latest } = await refreshActiveProfileIfNeeded(profileName);
    return latest.auth.type === "api_key" ? latest.auth.apiKey : latest.auth.accessToken;
  };
  return {
    profile: fresh,
    token,
    client: new AgentAPI({ apiKey: token, apiKeyProvider, baseURL: fresh.baseURL }),
  };
}

export async function getAuthStatus(profileName?: string): Promise<AuthStatus> {
  const runtime = await resolveRuntimeProfile(profileName);
  const payload = await fetchJSON(`${runtime.profile.baseURL}/v1/me`, runtime.token, "whoami");
  return {
    profile: runtime.profile.name,
    baseURL: runtime.profile.baseURL,
    authType: runtime.profile.auth.type,
    me: payload,
  };
}

export async function getCurrentWorkspaceIdentity(profileName?: string): Promise<CurrentWorkspaceIdentity> {
  const runtime = await resolveRuntimeProfile(profileName);
  const payload = await fetchJSON(`${runtime.profile.baseURL}/v1/me`, runtime.token, "current identity");
  return currentWorkspaceIdentityFromPayload(payload);
}

export async function listProfileWorkspaces(profileName?: string): Promise<WorkspaceInfo[]> {
  const runtime = await resolveRuntimeProfile(profileName);
  const payload = await fetchJSON(`${runtime.profile.baseURL}/v1/workspaces`, runtime.token, "list workspaces");
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map(workspaceInfoFromPayload).filter((workspace): workspace is WorkspaceInfo => Boolean(workspace));
}

export async function switchBrowserWorkspace(profileName: string | undefined, workspaceId: string): Promise<CurrentWorkspaceIdentity> {
  const runtime = await resolveRuntimeProfile(profileName);
  if (runtime.profile.auth.type !== "browser") {
    throw new Error("Workspace switching requires browser auth. API key profiles are bound to their key workspace.");
  }
  const id = workspaceId.trim();
  if (!id) throw new Error("workspace_id is required");
  const payload = await fetchJSON(`${runtime.profile.baseURL}/v1/workspaces/${encodeURIComponent(id)}/switch`, runtime.token, "switch workspace", {
    method: "POST",
  });
  await saveBrowserProfile(runtime.profile.name, runtime.profile.baseURL, {
    access_token: stringPayload(payload?.access_token),
    refresh_token: stringPayload(payload?.refresh_token),
    access_token_expires_at: numberPayload(payload?.access_token_expires_at),
    refresh_token_expires_at: numberPayload(payload?.refresh_token_expires_at),
    scopes: stringArrayPayload(payload?.scopes),
    status: "approved",
    user_id: stringPayload(payload?.user_id),
    workspace_id: stringPayload(payload?.workspace_id),
    workspace_role: stringPayload(payload?.workspace_role),
  });
  return {
    apiKeyId: undefined,
    authMethod: "jwt",
    scopes: stringArrayPayload(payload?.scopes),
    userId: stringPayload(payload?.user_id),
    userStatus: undefined,
    workspaceId: stringPayload(payload?.workspace_id),
    workspaceName: stringPayload(payload?.workspace_name),
    workspaceRole: stringPayload(payload?.workspace_role),
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
    if (isTransientAuthRefreshError(error)) {
      throw new AuthSessionUnavailableError(profile, error instanceof Error ? error.message : String(error));
    }
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

function isTransientAuthRefreshError(error: unknown) {
  if (error instanceof APIConnectionError) return true;
  if (error instanceof AuthenticationError) return false;
  if (error instanceof APIError && error.status !== undefined) {
    return isRetryableStatus(error.status);
  }
  return false;
}

async function fetchJSON(url: string, token: string, label: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload) || `${label} failed with ${response.status}`);
  }
  return payload as Record<string, unknown>;
}

function currentWorkspaceIdentityFromPayload(payload: Record<string, unknown> | undefined): CurrentWorkspaceIdentity {
  return {
    apiKeyId: optionalStringPayload(payload?.api_key_id),
    authMethod: optionalStringPayload(payload?.auth_method),
    scopes: stringArrayPayload(payload?.scopes),
    userId: stringPayload(payload?.user_id),
    userStatus: optionalStringPayload(payload?.user_status),
    workspaceId: stringPayload(payload?.workspace_id),
    workspaceName: stringPayload(payload?.workspace_name),
    workspaceRole: stringPayload(payload?.workspace_role),
  };
}

function workspaceInfoFromPayload(value: unknown): WorkspaceInfo | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const id = stringPayload(payload.workspace_id);
  if (!id) return null;
  return {
    id,
    name: stringPayload(payload.name) || id,
    slug: optionalStringPayload(payload.slug),
    role: stringPayload(payload.role),
    status: stringPayload(payload.status),
    membershipStatus: stringPayload(payload.membership_status),
  };
}

function stringPayload(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalStringPayload(value: unknown) {
  const text = stringPayload(value);
  return text || undefined;
}

function numberPayload(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function stringArrayPayload(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
