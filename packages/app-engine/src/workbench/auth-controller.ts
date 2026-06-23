import {
  deleteProfile,
  formatDeviceUserCode,
  getAuthStatus,
  loginWithAPIKey,
  openBrowserURL,
  refreshActiveProfileIfNeeded,
  saveBrowserProfile,
  startBrowserAuthChallenge,
  waitForBrowserAuthChallenge,
  type AuthStatus,
} from "../profile.js";

export interface WorkbenchAuthController {
  check(profile?: string, refreshWindowMs?: number): Promise<{ profileName: string; refreshed: boolean }>;
  loginAPIKey(input: { profile: string; baseURL: string; apiKey: string }): Promise<{ profileName: string }>;
  loginBrowser(input: {
    profile: string;
    baseURL: string;
    clientName?: string;
    onChallenge?: (challenge: { url: string; code: string }) => void;
    onStatus?: (status: string) => void;
  }): Promise<{ profileName: string }>;
  deleteProfile(name: string): Promise<void>;
  statusText(profile?: string): Promise<string>;
  refresh(profile?: string, refreshWindowMs?: number): Promise<{ refreshed: boolean }>;
}

export interface WorkbenchAuthControllerOptions {
  refreshActiveProfileIfNeededImpl?: typeof refreshActiveProfileIfNeeded;
  loginWithAPIKeyImpl?: typeof loginWithAPIKey;
  startBrowserAuthChallengeImpl?: typeof startBrowserAuthChallenge;
  openBrowserURLImpl?: typeof openBrowserURL;
  waitForBrowserAuthChallengeImpl?: typeof waitForBrowserAuthChallenge;
  saveBrowserProfileImpl?: typeof saveBrowserProfile;
  deleteProfileImpl?: typeof deleteProfile;
  getAuthStatusImpl?: typeof getAuthStatus;
}

export function createWorkbenchAuthController(options: WorkbenchAuthControllerOptions = {}): WorkbenchAuthController {
  const refreshActiveProfileIfNeededImpl = options.refreshActiveProfileIfNeededImpl ?? refreshActiveProfileIfNeeded;
  const loginWithAPIKeyImpl = options.loginWithAPIKeyImpl ?? loginWithAPIKey;
  const startBrowserAuthChallengeImpl = options.startBrowserAuthChallengeImpl ?? startBrowserAuthChallenge;
  const openBrowserURLImpl = options.openBrowserURLImpl ?? openBrowserURL;
  const waitForBrowserAuthChallengeImpl = options.waitForBrowserAuthChallengeImpl ?? waitForBrowserAuthChallenge;
  const saveBrowserProfileImpl = options.saveBrowserProfileImpl ?? saveBrowserProfile;
  const deleteProfileImpl = options.deleteProfileImpl ?? deleteProfile;
  const getAuthStatusImpl = options.getAuthStatusImpl ?? getAuthStatus;

  return {
    async check(profile, refreshWindowMs = 5 * 60_000) {
      const result = await refreshActiveProfileIfNeededImpl(profile, refreshWindowMs);
      return { profileName: result.profile.name, refreshed: result.refreshed };
    },

    async loginAPIKey(input) {
      const saved = await loginWithAPIKeyImpl(input);
      return { profileName: saved.name };
    },

    async loginBrowser(input) {
      const challenge = await startBrowserAuthChallengeImpl({
        baseURL: input.baseURL,
        clientName: input.clientName || "Agent API TUI",
      });
      input.onChallenge?.({
        url: challenge.verification_uri_complete,
        code: formatDeviceUserCode(challenge.user_code),
      });
      await openBrowserURLImpl(challenge.verification_uri_complete).catch(() => undefined);
      const session = await waitForBrowserAuthChallengeImpl({
        baseURL: input.baseURL,
        challenge,
        on_poll(result) {
          if (result.status && result.status !== "pending") {
            input.onStatus?.(result.status);
          }
        },
      });
      const saved = await saveBrowserProfileImpl(input.profile, input.baseURL, session);
      return { profileName: saved.name };
    },

    async deleteProfile(name) {
      await deleteProfileImpl(name);
    },

    async statusText(profile) {
      return authStatusText(await getAuthStatusImpl(profile));
    },

    async refresh(profile, refreshWindowMs = 5 * 60_000) {
      const result = await refreshActiveProfileIfNeededImpl(profile, refreshWindowMs);
      return { refreshed: result.refreshed };
    },
  };
}

export function authStatusText(status: AuthStatus) {
  return [
    `Profile: ${status.profile}`,
    `Endpoint: ${status.baseURL}`,
    `Auth: ${status.authType === "api_key" ? "API key" : "Browser session"}`,
    `Account: ${summarizeMe(status.me)}`,
  ].join("\n");
}

function summarizeMe(me: unknown) {
  if (!me || typeof me !== "object") return "available";
  const obj = me as Record<string, unknown>;
  const candidates = [
    obj.email,
    obj.name,
    obj.username,
    obj.user_id,
    obj.id,
    nestedString(obj.user, "email"),
    nestedString(obj.user, "name"),
    nestedString(obj.user, "id"),
  ];
  const picked = candidates.find((value): value is string => typeof value === "string" && value.trim() !== "");
  return picked || "available";
}

function nestedString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}
