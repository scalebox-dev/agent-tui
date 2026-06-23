import { defaultBaseURL } from "../config.js";
import {
  createWorkbenchAuthController,
  type WorkbenchAuthController,
} from "./auth-controller.js";

export type AuthMethod = "browser" | "api_key" | "exit";

export type AuthGateState = {
  status: "checking" | "select" | "api_profile" | "api_base_url" | "api_key" | "browser_profile" | "browser_base_url" | "browser_waiting" | "ready";
  selectedMethod: number;
  profile: string;
  baseURL: string;
  apiKey: string;
  message: string;
  error: string;
  browserURL: string;
  browserCode: string;
};

export interface AuthGateInputKey {
  backspace?: boolean;
  ctrl?: boolean;
  delete?: boolean;
  downArrow?: boolean;
  meta?: boolean;
  return?: boolean;
  upArrow?: boolean;
}

export type AuthGateInputEffect =
  | { type: "exit" }
  | { type: "submit" };

export interface AuthGateInputResult {
  state: AuthGateState;
  effects: AuthGateInputEffect[];
}

export interface AuthGateSubmitResult {
  state: AuthGateState;
  profileName?: string;
}

export interface WorkbenchAuthGateController {
  authMethods: typeof authMethods;
  initialState(input: { profile?: string; baseURL?: string; apiKey?: string }): AuthGateState;
  check(profile?: string): Promise<AuthGateSubmitResult>;
  handleInput(input: string, key: AuthGateInputKey, state: AuthGateState): AuthGateInputResult;
  submit(state: AuthGateState, options?: { onState?: (state: AuthGateState) => void }): Promise<AuthGateSubmitResult>;
  requestLogin(state: AuthGateState, profileName: string): AuthGateState;
  requestLogout(state: AuthGateState, profileName: string): AuthGateState;
  requestSwitchProfile(state: AuthGateState, currentProfile: string, nextProfile?: string): AuthGateState;
  deletedProfile(state: AuthGateState, profileName: string): AuthGateState;
}

export interface WorkbenchAuthGateControllerOptions {
  authController?: WorkbenchAuthController;
  formatError?: (error: unknown) => string;
}

export const authMethods: Array<{ method: AuthMethod; label: string; description: string }> = [
  { method: "browser", label: "Browser session", description: "Interactive login with refreshable local session." },
  { method: "api_key", label: "API key", description: "Paste a static API key for shell-only environments." },
  { method: "exit", label: "Exit", description: "Leave without signing in." },
];

export function createWorkbenchAuthGateController(
  options: WorkbenchAuthGateControllerOptions = {},
): WorkbenchAuthGateController {
  const authController = options.authController ?? createWorkbenchAuthController();
  const formatError = options.formatError ?? userFacingError;

  return {
    authMethods,

    initialState(input) {
      return {
        status: "checking",
        selectedMethod: 0,
        profile: input.profile || "default",
        baseURL: input.baseURL || process.env.AGENT_API_BASE_URL || defaultBaseURL,
        apiKey: input.apiKey || process.env.AGENT_API_KEY || "",
        message: "Checking local auth profile...",
        error: "",
        browserURL: "",
        browserCode: "",
      };
    },

    async check(profile) {
      try {
        const result = await authController.check(profile);
        return {
          profileName: result.profileName,
          state: readyState(profile || result.profileName, `Authenticated.`),
        };
      } catch (error) {
        return {
          state: selectState(profile || "default", "Choose an auth method to continue into the workbench.", formatError(error)),
        };
      }
    },

    handleInput(input, key, state) {
      if (key.ctrl && input === "c") return inputResult(state, { type: "exit" });
      if (state.status === "ready" || state.status === "checking" || state.status === "browser_waiting") return inputResult(state);
      if (state.status === "select") return handleSelectInput(key, state);
      if (key.return) return inputResult(state, { type: "submit" });
      if (key.backspace || key.delete) return inputResult(editAuthField(state, (value) => value.slice(0, -1)));
      if (input && !key.ctrl && !key.meta) return inputResult(editAuthField(state, (value) => value + input));
      return inputResult(state);
    },

    async submit(state, submitOptions = {}) {
      const profile = state.profile.trim() || "default";
      const baseURL = state.baseURL.trim() || defaultBaseURL;
      switch (state.status) {
        case "api_profile":
          return { state: { ...state, profile, status: "api_base_url", error: "" } };
        case "api_base_url":
          return { state: { ...state, baseURL, status: "api_key", error: "" } };
        case "api_key":
          return loginWithAPIKey(authController, state, { baseURL, formatError, profile });
        case "browser_profile":
          return { state: { ...state, profile, status: "browser_base_url", error: "" } };
        case "browser_base_url":
          return loginWithBrowser(authController, state, { baseURL, formatError, onState: submitOptions.onState, profile });
        default:
          return { state };
      }
    },

    requestLogin(state, profileName) {
      return {
        ...state,
        profile: profileName,
        status: "select",
        message: "Choose an auth method to continue into the workbench.",
        error: "",
      };
    },

    requestLogout(state, profileName) {
      return {
        ...state,
        profile: profileName,
        status: "select",
        message: `Logged out of profile "${profileName}" for this app session. Choose an auth method to continue.`,
        error: "",
      };
    },

    requestSwitchProfile(state, currentProfile, nextProfile) {
      return {
        ...state,
        profile: nextProfile || currentProfile,
        status: "select",
        message: nextProfile ? `Choose an auth method for profile "${nextProfile}".` : "Choose an auth method for another profile.",
        error: "",
      };
    },

    deletedProfile(state, profileName) {
      return {
        ...state,
        status: "select",
        message: `Deleted profile "${profileName}". Choose an auth method to continue.`,
        error: "",
      };
    },
  };
}

function handleSelectInput(key: AuthGateInputKey, state: AuthGateState): AuthGateInputResult {
  if (key.upArrow) {
    return inputResult({ ...state, selectedMethod: Math.max(0, state.selectedMethod - 1) });
  }
  if (key.downArrow) {
    return inputResult({ ...state, selectedMethod: Math.min(authMethods.length - 1, state.selectedMethod + 1) });
  }
  if (key.return) {
    const method = authMethods[state.selectedMethod]?.method;
    if (method === "exit") return inputResult(state, { type: "exit" });
    return inputResult({
      ...state,
      status: method === "api_key" ? "api_profile" : "browser_profile",
      message: method === "api_key" ? "Save an API key profile." : "Create a browser session profile.",
      error: "",
    });
  }
  return inputResult(state);
}

async function loginWithAPIKey(
  authController: WorkbenchAuthController,
  state: AuthGateState,
  input: { baseURL: string; formatError: (error: unknown) => string; profile: string },
): Promise<AuthGateSubmitResult> {
  const apiKey = state.apiKey.trim();
  if (!apiKey) return { state: { ...state, error: "API key is required." } };
  const saving = { ...state, message: "Saving API key profile...", error: "" };
  try {
    const saved = await authController.loginAPIKey({ profile: input.profile, baseURL: input.baseURL, apiKey });
    return {
      profileName: saved.profileName,
      state: { ...saving, status: "ready", message: `Signed in as profile "${input.profile}".`, error: "" },
    };
  } catch (error) {
    return { state: { ...saving, error: input.formatError(error) } };
  }
}

async function loginWithBrowser(
  authController: WorkbenchAuthController,
  state: AuthGateState,
  input: {
    baseURL: string;
    formatError: (error: unknown) => string;
    onState?: (state: AuthGateState) => void;
    profile: string;
  },
): Promise<AuthGateSubmitResult> {
  const waiting: AuthGateState = {
    ...state,
    profile: input.profile,
    baseURL: input.baseURL,
    status: "browser_waiting",
    message: "Starting browser auth challenge...",
    error: "",
    browserURL: "",
    browserCode: "",
  };
  input.onState?.(waiting);
  try {
    const saved = await authController.loginBrowser({
      profile: input.profile,
      baseURL: input.baseURL,
      onChallenge(challenge) {
        input.onState?.({
          ...waiting,
          message: "Open the URL to approve this terminal session.",
          browserURL: challenge.url,
          browserCode: challenge.code,
        });
      },
      onStatus(status) {
        input.onState?.({ ...waiting, message: `Browser auth status: ${status}` });
      },
    });
    return {
      profileName: saved.profileName,
      state: { ...waiting, status: "ready", message: `Signed in as profile "${input.profile}".`, error: "" },
    };
  } catch (error) {
    return {
      state: {
        ...waiting,
        status: "select",
        message: "Browser auth did not complete. Choose an auth method to continue.",
        error: input.formatError(error),
      },
    };
  }
}

function editAuthField(state: AuthGateState, update: (value: string) => string): AuthGateState {
  switch (state.status) {
    case "api_profile":
    case "browser_profile":
      return { ...state, profile: update(state.profile), error: "" };
    case "api_base_url":
    case "browser_base_url":
      return { ...state, baseURL: update(state.baseURL), error: "" };
    case "api_key":
      return { ...state, apiKey: update(state.apiKey), error: "" };
    default:
      return state;
  }
}

function readyState(profile: string, message: string): AuthGateState {
  return {
    status: "ready",
    selectedMethod: 0,
    profile,
    baseURL: process.env.AGENT_API_BASE_URL || defaultBaseURL,
    apiKey: process.env.AGENT_API_KEY || "",
    message,
    error: "",
    browserURL: "",
    browserCode: "",
  };
}

function selectState(profile: string, message: string, error = ""): AuthGateState {
  return {
    ...readyState(profile, message),
    status: "select",
    error,
  };
}

function inputResult(state: AuthGateState, ...effects: AuthGateInputEffect[]): AuthGateInputResult {
  return { state, effects };
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
