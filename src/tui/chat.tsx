import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  defaultBaseURL,
  loadWorkbenchPreferences,
  updateWorkbenchPreferences,
  type WorkbenchPreferences,
} from "../config.js";
import {
  conversationSummary,
  clearPresetToolCatalogCache,
  deleteConversation,
  isAvailablePreset,
  listAvailablePresets,
  listConversations,
  resumeAgentAfterLocalApproval,
  runAgentTurn,
  type AgentRunOptions,
  type AgentTurnEvent,
} from "../agent.js";
import {
  openWorkdir,
  type WorkdirService,
} from "../workdir/index.js";
import { createLocalShellToolRegistry, createLocalWorkdirToolRegistry } from "@agent-api/sdk/local";
import {
  activityColor,
  createInputHistory,
  formatBytes,
  type RenderMode,
  type WorkbenchCommand,
  type WorkbenchMessage,
  type WorkbenchState,
} from "./workbench.js";
import { createWorkbenchEngine, type WorkbenchEffect, type WorkbenchEngine } from "../workbench/engine.js";
import {
  deleteProfile,
  formatDeviceUserCode,
  getAuthStatus,
  loginWithAPIKey,
  openBrowserURL,
  refreshActiveProfileIfNeeded,
  resolveRuntimeProfile,
  saveBrowserProfile,
  startBrowserAuthChallenge,
  waitForBrowserAuthChallenge,
} from "../profile.js";
import { checkForUpdate, formatUpdateNotice } from "../update.js";
import { runtime } from "../runtime/index.js";

export function ChatApp({ options }: { options: AgentRunOptions }) {
  return <AuthenticatedChatApp options={options} />;
}

type AuthMethod = "browser" | "api_key" | "exit";

type AuthGateState = {
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

const authMethods: Array<{ method: AuthMethod; label: string; description: string }> = [
  { method: "browser", label: "Browser session", description: "Interactive login with refreshable local session." },
  { method: "api_key", label: "API key", description: "Paste a static API key for shell-only environments." },
  { method: "exit", label: "Exit", description: "Leave without signing in." },
];

function AuthenticatedChatApp({ options }: { options: AgentRunOptions }) {
  const app = useApp();
  const busyRef = useRef(false);
  const [currentProfile, setCurrentProfile] = useState(options.profile || "default");
  const [auth, setAuth] = useState<AuthGateState>({
    status: "checking",
    selectedMethod: 0,
    profile: options.profile || "default",
    baseURL: process.env.AGENT_API_BASE_URL || defaultBaseURL,
    apiKey: process.env.AGENT_API_KEY || "",
    message: "Checking local auth profile...",
    error: "",
    browserURL: "",
    browserCode: "",
  });

  useEffect(() => {
    let mounted = true;
    refreshActiveProfileIfNeeded(options.profile, 5 * 60_000)
      .then((result) => {
        if (!mounted) return;
        setCurrentProfile(result.profile.name);
        setAuth((current) => ({ ...current, status: "ready", message: "Authenticated.", error: "" }));
      })
      .catch((error) => {
        if (!mounted) return;
        setAuth((current) => ({
          ...current,
          status: "select",
          message: "Choose an auth method to continue into the workbench.",
          error: userFacingError(error),
        }));
      });
    return () => {
      mounted = false;
    };
  }, [options.profile]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      app.exit();
      return;
    }
    if (auth.status === "ready" || auth.status === "checking" || auth.status === "browser_waiting") return;
    if (auth.status === "select") {
      if (key.upArrow) {
        setAuth((current) => ({ ...current, selectedMethod: Math.max(0, current.selectedMethod - 1) }));
        return;
      }
      if (key.downArrow) {
        setAuth((current) => ({ ...current, selectedMethod: Math.min(authMethods.length - 1, current.selectedMethod + 1) }));
        return;
      }
      if (key.return) {
        const method = authMethods[auth.selectedMethod]?.method;
        if (method === "exit") {
          app.exit();
          return;
        }
        setAuth((current) => ({
          ...current,
          status: method === "api_key" ? "api_profile" : "browser_profile",
          message: method === "api_key" ? "Save an API key profile." : "Create a browser session profile.",
          error: "",
        }));
        return;
      }
      return;
    }

    if (key.return) {
      void submitAuthField();
      return;
    }
    if (key.backspace || key.delete) {
      editAuthField((value) => value.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      editAuthField((value) => value + input);
    }
  });

  function editAuthField(update: (value: string) => string) {
    setAuth((current) => {
      switch (current.status) {
        case "api_profile":
        case "browser_profile":
          return { ...current, profile: update(current.profile), error: "" };
        case "api_base_url":
        case "browser_base_url":
          return { ...current, baseURL: update(current.baseURL), error: "" };
        case "api_key":
          return { ...current, apiKey: update(current.apiKey), error: "" };
        default:
          return current;
      }
    });
  }

  async function submitAuthField() {
    if (busyRef.current) return;
    const profile = auth.profile.trim() || "default";
    const baseURL = auth.baseURL.trim() || defaultBaseURL;
    switch (auth.status) {
      case "api_profile":
        setAuth((current) => ({ ...current, profile, status: "api_base_url", error: "" }));
        return;
      case "api_base_url":
        setAuth((current) => ({ ...current, baseURL, status: "api_key", error: "" }));
        return;
      case "api_key": {
        const apiKey = auth.apiKey.trim();
        if (!apiKey) {
          setAuth((current) => ({ ...current, error: "API key is required." }));
          return;
        }
        busyRef.current = true;
        setAuth((current) => ({ ...current, message: "Saving API key profile...", error: "" }));
        try {
          const saved = await loginWithAPIKey({ profile, baseURL, apiKey });
          setCurrentProfile(saved.name);
          setAuth((current) => ({ ...current, status: "ready", message: `Signed in as profile "${profile}".`, error: "" }));
        } catch (error) {
          setAuth((current) => ({ ...current, error: userFacingError(error) }));
        } finally {
          busyRef.current = false;
        }
        return;
      }
      case "browser_profile":
        setAuth((current) => ({ ...current, profile, status: "browser_base_url", error: "" }));
        return;
      case "browser_base_url":
        await runBrowserLogin(profile, baseURL);
        return;
      default:
        return;
    }
  }

  async function runBrowserLogin(profile: string, baseURL: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setAuth((current) => ({
      ...current,
      profile,
      baseURL,
      status: "browser_waiting",
      message: "Starting browser auth challenge...",
      error: "",
      browserURL: "",
      browserCode: "",
    }));
    try {
      const challenge = await startBrowserAuthChallenge({ baseURL, clientName: "Agent API TUI" });
      setAuth((current) => ({
        ...current,
        message: "Open the URL to approve this terminal session.",
        browserURL: challenge.verification_uri_complete,
        browserCode: formatDeviceUserCode(challenge.user_code),
      }));
      await openBrowserURL(challenge.verification_uri_complete).catch(() => undefined);
      const session = await waitForBrowserAuthChallenge({
        baseURL,
        challenge,
        on_poll(result) {
          if (result.status && result.status !== "pending") {
            setAuth((current) => ({ ...current, message: `Browser auth status: ${result.status}` }));
          }
        },
      });
      const saved = await saveBrowserProfile(profile, baseURL, session);
      setCurrentProfile(saved.name);
      setAuth((current) => ({ ...current, status: "ready", message: `Signed in as profile "${profile}".`, error: "" }));
    } catch (error) {
      setAuth((current) => ({
        ...current,
        status: "select",
        message: "Browser auth did not complete. Choose an auth method to continue.",
        error: userFacingError(error),
      }));
    } finally {
      busyRef.current = false;
    }
  }

  if (auth.status === "ready") {
    return (
      <WorkbenchApp
        onLogin={() => {
          setAuth((current) => ({
            ...current,
            profile: currentProfile,
            status: "select",
            message: "Choose an auth method to continue into the workbench.",
            error: "",
          }));
        }}
        onLogout={() => {
          setAuth((current) => ({
            ...current,
            profile: currentProfile,
            status: "select",
            message: `Logged out of profile "${currentProfile}" for this app session. Choose an auth method to continue.`,
            error: "",
          }));
        }}
        onDeleteProfile={async () => {
          await deleteProfile(currentProfile);
          setAuth((current) => ({
            ...current,
            status: "select",
            message: `Deleted profile "${currentProfile}". Choose an auth method to continue.`,
            error: "",
          }));
        }}
        onSwitchProfile={(name) => {
          setAuth((current) => ({
            ...current,
            profile: name || currentProfile,
            status: "select",
            message: name ? `Choose an auth method for profile "${name}".` : "Choose an auth method for another profile.",
            error: "",
          }));
        }}
        options={{ ...options, profile: currentProfile }}
        profileName={currentProfile}
      />
    );
  }

  return <AuthGate state={auth} />;
}

function WorkbenchApp({
  onLogin,
  onLogout,
  onDeleteProfile,
  onSwitchProfile,
  options,
  profileName,
}: {
  onLogin: () => void;
  onLogout: () => void;
  onDeleteProfile: () => Promise<void>;
  onSwitchProfile: (name?: string) => void;
  options: AgentRunOptions;
  profileName: string;
}) {
  const app = useApp();
  const { stdout } = useStdout();
  const workdirRef = useRef<WorkdirService | null>(null);
  const initialPromptSubmittedRef = useRef(false);
  const authRefreshWarningShownRef = useRef(false);
  const textDeltaBufferRef = useRef<{ id: string; text: string } | null>(null);
  const textDeltaFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const activeResponseIDRef = useRef<string | null>(null);
  const cancelledResponseIDsRef = useRef(new Set<string>());
  const updateNoticeShownRef = useRef(false);
  const inputHistoryRef = useRef(createInputHistory());
  const [draft, setDraft] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const engineRef = useRef<WorkbenchEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createWorkbenchEngine({
      accessMode: options.accessMode,
      conversation: options.conversation,
      contextEnabled: Boolean(options.includeLocalContext || options.workdir),
      model: options.model,
      preset: options.preset,
    });
  }
  const engine = engineRef.current;
  const state = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const dispatch = engine.dispatch;
  const terminalRows = Math.max(18, stdout.rows || process.stdout.rows || 32);
  const terminalColumns = Math.max(80, stdout.columns || process.stdout.columns || 100);
  const viewportHeight = Math.max(6, terminalRows - 9);
  const transcriptWidth = Math.max(36, Math.floor(terminalColumns * 0.72) - 4);
  const transcriptLines = useMemo(
    () =>
      buildTranscriptLines(state.messages, {
        activeAssistantMessageId: state.activeAssistantMessageId,
        busy: state.busy,
        renderMode: state.renderMode,
        spinnerFrame,
        width: transcriptWidth,
      }),
    [state.activeAssistantMessageId, state.busy, state.messages, state.renderMode, spinnerFrame, transcriptWidth],
  );
  const maxTranscriptOffset = Math.max(0, transcriptLines.length - viewportHeight);
  const clampedTranscriptOffset = Math.min(transcriptOffset, maxTranscriptOffset);
  const transcriptStart = Math.max(0, transcriptLines.length - viewportHeight - clampedTranscriptOffset);
  const visibleTranscriptLines = transcriptLines.slice(transcriptStart, transcriptStart + viewportHeight);

  useEffect(() => {
    setTranscriptOffset((offset) => Math.min(offset, Math.max(0, transcriptLines.length - viewportHeight)));
  }, [transcriptLines.length, viewportHeight]);

  function scrollTranscript(delta: number) {
    setTranscriptOffset((offset) => Math.max(0, Math.min(maxTranscriptOffset, offset + delta)));
  }

  function scrollTranscriptToTop() {
    setTranscriptOffset(maxTranscriptOffset);
  }

  function scrollTranscriptToBottom() {
    setTranscriptOffset(0);
  }

  useEffect(() => {
    let mounted = true;
    if (!updateNoticeShownRef.current && process.env.AGENT_TUI_UPDATE_CHECK !== "0") {
      updateNoticeShownRef.current = true;
      checkForUpdate()
        .then((result) => {
          if (!mounted || !result?.updateAvailable) return;
          const notice = formatUpdateNotice(result);
          dispatch({ type: "activity.add", level: "warning", text: `Update available: ${result.latest}` });
          dispatch({ type: "message.add", role: "system", text: notice });
        })
        .catch(() => undefined);
    }
    loadWorkbenchPreferences()
      .then((preferences) => {
        if (!mounted) return;
        dispatch({ type: "settings.set", settings: { defaultPreset: preferences.defaultPreset } });
        if (!options.presetExplicit && !options.modelExplicit) {
          dispatch({ type: "settings.set", settings: { runPreset: effectiveDefaultPreset(preferences, options.preset) } });
        }
      })
      .catch((error) => {
        if (!mounted) return;
        dispatch({ type: "activity.add", level: "warning", text: `Config preferences unavailable: ${userFacingError(error)}` });
      });
    return () => {
      mounted = false;
    };
  }, [dispatch, options.modelExplicit, options.preset, options.presetExplicit]);

  useEffect(() => {
    let mounted = true;
    dispatch({ type: "activity.add", text: "Loading workdir" });
    openWorkdir({ path: options.workdir || process.cwd() })
      .then(async (workdir) => {
        const summary = await workdir.summarize();
        if (!mounted) return;
        workdirRef.current = workdir;
        dispatch({
          type: "workdir.set",
          workdir: {
            root: workdir.root,
            name: workdir.name,
            fileCount: summary.file_count,
            totalBytes: summary.total_bytes,
            scanTruncated: summary.scan_truncated,
          },
        });
      })
      .catch((error) => {
        if (!mounted) return;
        dispatch({
          type: "activity.add",
          level: "error",
          text: `Workdir unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      mounted = false;
    };
  }, [options.workdir]);

  useEffect(() => {
    let mounted = true;
    const refreshWindowMs = 5 * 60_000;
    const refreshIntervalMs = 60_000;
    const refreshAuth = async () => {
      try {
        const result = await refreshActiveProfileIfNeeded(options.profile, refreshWindowMs);
        if (!mounted) return;
        if (result.refreshed) {
          authRefreshWarningShownRef.current = false;
          dispatch({ type: "activity.add", level: "success", text: "Auth session refreshed" });
        }
      } catch (error) {
        if (!mounted || authRefreshWarningShownRef.current) return;
        authRefreshWarningShownRef.current = true;
        dispatch({
          type: "message.add",
          role: "system",
          text: `${userFacingError(error)}\n\nClosing the workbench because authenticated agent conversations are unavailable.`,
        });
        dispatch({ type: "activity.add", level: "error", text: "Auth session needs login; closing" });
        setTimeout(() => {
          if (mounted) app.exit();
        }, 1500);
      }
    };
    void refreshAuth();
    const interval = setInterval(refreshAuth, refreshIntervalMs);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [app, options.profile]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      app.exit();
      return;
    }
    if (key.pageUp || (key.ctrl && input === "u")) {
      scrollTranscript(Math.max(1, Math.floor(viewportHeight / 2)));
      return;
    }
    if (key.pageDown || (key.ctrl && input === "d")) {
      scrollTranscript(-Math.max(1, Math.floor(viewportHeight / 2)));
      return;
    }
    if (key.home) {
      scrollTranscriptToTop();
      return;
    }
    if (key.end) {
      scrollTranscriptToBottom();
      return;
    }
    if (key.upArrow) {
      setDraft((current) => inputHistoryRef.current.previous(current));
      return;
    }
    if (key.downArrow) {
      setDraft((current) => inputHistoryRef.current.next(current));
      return;
    }
    if (state.busy) {
      if (key.escape) {
        void abortActiveTurn("Abort requested.");
        return;
      }
      if (key.return) {
        const command = draft.trim();
        inputHistoryRef.current.record(command);
        setDraft("");
        if (command === "/abort" || command === "/cancel") {
          void abortActiveTurn("Abort requested.");
          return;
        }
        if (command) {
          dispatch({ type: "message.add", role: "system", text: "Agent turn is running. Use /abort or Esc to cancel it." });
          dispatch({ type: "activity.add", level: "warning", text: "Input ignored while agent is running" });
        }
        return;
      }
      if (key.backspace || key.delete) {
        inputHistoryRef.current.reset();
        setDraft((current) => current.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        inputHistoryRef.current.reset();
        setDraft((current) => current + input);
      }
      return;
    }
    if (key.return) {
      const prompt = draft.trim();
      if (!prompt) return;
      inputHistoryRef.current.record(prompt);
      setDraft("");
      void submit(prompt);
      return;
    }
    if (key.backspace || key.delete) {
      inputHistoryRef.current.reset();
      setDraft((current) => current.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      inputHistoryRef.current.reset();
      setDraft((current) => current + input);
    }
  });

  useEffect(() => {
    if (initialPromptSubmittedRef.current || state.busy) return;
    const initialPrompt = options.promptParts.join(" ").trim();
    if (!initialPrompt) return;
    if (!workdirRef.current) return;
    initialPromptSubmittedRef.current = true;
    void send(initialPrompt);
  }, [options.promptParts, state.busy, state.workdir]);

  useEffect(() => {
    if (!state.busy) {
      setSpinnerFrame(0);
      return;
    }
    const interval = setInterval(() => {
      setSpinnerFrame((frame) => frame + 1);
    }, 120);
    return () => clearInterval(interval);
  }, [state.busy]);

  useEffect(() => {
    return () => {
      if (textDeltaFlushTimerRef.current) {
        clearTimeout(textDeltaFlushTimerRef.current);
        textDeltaFlushTimerRef.current = null;
      }
    };
  }, []);

  async function submit(input: string) {
    const submission = engine.submit(input);
    if (submission.kind === "command") {
      await runCommand(submission.command);
      return;
    }
    if (submission.kind === "prompt") {
      await send(submission.prompt);
    }
  }

  async function runCommand(command: WorkbenchCommand) {
    const commandResult = engine.handleCommand(command);
    if (commandResult.handled) {
      await runEffects(commandResult.effects);
      return;
    }
    switch (command.kind) {
      case "abort":
        if (!state.busy) {
          dispatch({ type: "message.add", role: "system", text: "No agent turn is running." });
          return;
        }
        await abortActiveTurn("Abort requested.");
        return;
      case "config":
        await runConfigCommand(command);
        return;
      case "preset":
        await runPresetCommand(command.value);
        return;
      case "summary":
        await showSummary();
        return;
      case "search":
        await searchWorkdir(command.query);
        return;
      case "new_conversation":
        await startNewConversation(command.name);
        return;
      case "switch_conversation":
        switchConversation(command.name);
        return;
      case "list_conversations":
        await showConversations();
        return;
      case "preview":
        showEditPreview();
        return;
      case "apply":
        await applyPendingEdit(false);
        return;
      case "apply_all":
        await applyPendingEdit(true);
        return;
      case "reject":
        rejectPendingEdit();
        return;
    }
  }

  async function runEffects(effects: WorkbenchEffect[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case "exit":
          app.exit();
          break;
        case "login":
          onLogin();
          break;
        case "logout":
          dispatch({ type: "activity.add", text: `Logged out: ${profileName}` });
          onLogout();
          break;
        case "delete_profile":
          dispatch({ type: "activity.add", level: "warning", text: `Deleting profile: ${profileName}` });
          await onDeleteProfile();
          break;
        case "switch_profile":
          onSwitchProfile(effect.name);
          break;
        case "show_auth_status":
          await showAuthStatus();
          break;
        case "export_transcript":
          await exportTranscript(effect);
          break;
        case "clear_preset_tool_catalog_cache":
          clearPresetToolCatalogCache();
          break;
      }
    }
  }

  async function runConfigCommand(command: Extract<WorkbenchCommand, { kind: "config" }>) {
    if (!command.field) {
      dispatch({
        type: "message.add",
        role: "system",
        text: runConfigText({
          profileName,
          runPreset: state.runPreset,
          runModel: state.runModel,
          accessMode: state.accessMode,
          contextEnabled: state.contextEnabled,
          defaultPreset: state.defaultPreset,
          renderMode: state.renderMode,
        }),
      });
      return;
    }

    if (command.field === "preset") {
      if (!command.value) {
        dispatch({
          type: "message.add",
          role: "system",
          text: `Default preset: ${formatDefaultPreset(state.defaultPreset)}. Use /config preset <name>, /config preset none, or /config preset reset.`,
        });
        return;
      }
      const normalized = normalizeDefaultPreset(command.value);
      if (typeof normalized === "string" && !(await validatePresetName(normalized))) {
        return;
      }
      const preferences = await updateWorkbenchPreferences({ defaultPreset: normalized });
      dispatch({ type: "settings.set", settings: { defaultPreset: preferences.defaultPreset } });
      if (!options.presetExplicit && !options.modelExplicit) {
        dispatch({ type: "settings.set", settings: { runPreset: effectiveDefaultPreset(preferences, options.preset) } });
      }
      dispatch({
        type: "message.add",
        role: "system",
        text: `Saved default preset: ${formatDefaultPreset(preferences.defaultPreset)}.`,
      });
      dispatch({ type: "activity.add", level: "success", text: `Default preset saved: ${formatDefaultPreset(preferences.defaultPreset)}` });
    }
  }

  async function runPresetCommand(value?: string) {
    if (!value) {
      dispatch({
        type: "message.add",
        role: "system",
        text: await presetListText(`Preset: ${state.runPreset || "none"}. Use /preset <name> or /preset none.`),
      });
      return;
    }
    const normalized = normalizeOptionalSetting(value, ["none", "off", "clear"]);
    if (normalized && !(await validatePresetName(normalized))) {
      return;
    }
    dispatch({ type: "settings.set", settings: { runPreset: normalized } });
    dispatch({ type: "activity.add", text: `Preset: ${normalized || "none"}` });
  }

  async function validatePresetName(preset: string) {
    try {
      if (await isAvailablePreset(profileName, preset)) return true;
      dispatch({
        type: "message.add",
        role: "system",
        text: await presetListText(`Unknown preset: ${preset}`),
      });
      dispatch({ type: "activity.add", level: "warning", text: `Unknown preset: ${preset}` });
      return false;
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Could not validate preset "${preset}": ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Preset catalog unavailable" });
      return false;
    }
  }

  async function presetListText(prefix: string) {
    try {
      const presets = await listAvailablePresets(profileName);
      return [
        prefix,
        "",
        "Available presets:",
        ...formatPresetList(presets, state.runPreset),
      ].join("\n");
    } catch (error) {
      return [
        prefix,
        "",
        `Available presets could not be loaded: ${userFacingError(error)}`,
      ].join("\n");
    }
  }

  async function showAuthStatus() {
    dispatch({ type: "activity.add", text: "Checking auth status" });
    try {
      const status = await getAuthStatus(profileName);
      dispatch({ type: "message.add", role: "system", text: authStatusText(status) });
      dispatch({ type: "activity.add", level: "success", text: "Auth status ready" });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: userFacingError(error) });
      dispatch({ type: "activity.add", level: "error", text: "Auth status failed" });
    }
  }

  async function exportTranscript(effect: Extract<WorkbenchEffect, { type: "export_transcript" }>) {
    try {
      const file = effect.path?.trim()
        ? path.resolve(process.cwd(), effect.path.trim())
        : defaultTranscriptExportPath(effect.conversation);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, effect.transcript, "utf8");
      dispatch({ type: "message.add", role: "system", text: `Transcript exported:\n${file}` });
      dispatch({ type: "activity.add", level: "success", text: "Transcript exported" });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Transcript export failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Transcript export failed" });
    }
  }

  async function showSummary() {
    const workdir = workdirRef.current;
    if (!workdir) {
      dispatch({ type: "message.add", role: "system", text: "Workdir is still loading." });
      return;
    }
    dispatch({ type: "activity.add", text: "Summarizing workdir" });
    try {
      const summary = await workdir.summarize();
      const previews = summary.text_previews
        .slice(0, 5)
        .map((preview) => `- ${preview.path} (${formatBytes(preview.size)})`)
        .join("\n");
      dispatch({
        type: "message.add",
        role: "system",
        text: [
          `Workdir summary for ${workdir.name}`,
          `Files: ${summary.file_count}`,
          `Size: ${formatBytes(summary.total_bytes)}`,
          previews ? `Previews:\n${previews}` : "No text previews available.",
        ].join("\n"),
      });
      dispatch({ type: "activity.add", level: "success", text: "Workdir summary ready" });
    } catch (error) {
      dispatch({
        type: "activity.add",
        level: "error",
        text: userFacingError(error),
      });
    }
  }

  async function startNewConversation(name?: string) {
    const conversation = name || createConversationName();
    await deleteConversation(conversation, options.profile);
    dispatch({ type: "messages.clear" });
    dispatch({ type: "conversation.set", name: conversation });
    dispatch({
      type: "message.add",
      role: "system",
      text: `Started fresh conversation "${conversation}".`,
    });
  }

  function switchConversation(name: string) {
    dispatch({ type: "messages.clear" });
    dispatch({ type: "conversation.set", name });
    dispatch({
      type: "message.add",
      role: "system",
      text: `Switched to conversation "${name}". Future turns will continue this handle when history exists.`,
    });
  }

  async function showConversations() {
    try {
      const conversations = await listConversations(options.profile);
      dispatch({
        type: "message.add",
        role: "system",
        text: conversations.length === 0
          ? "No saved conversations yet."
          : conversations.map(conversationSummary).join("\n"),
      });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: userFacingError(error) });
    }
  }

  async function searchWorkdir(query: string) {
    const workdir = workdirRef.current;
    if (!query) {
      dispatch({ type: "message.add", role: "system", text: "Usage: /search <query>" });
      return;
    }
    if (!workdir) {
      dispatch({ type: "message.add", role: "system", text: "Workdir is still loading." });
      return;
    }
    dispatch({ type: "activity.add", text: `Searching workdir: ${query}` });
    try {
      const results = await workdir.workdir.grep({ pattern: query, limit: 12 });
      const matches = results.matches
        .map((match: { path: string; line_number: number; line: string }) => `${match.path}:${match.line_number}: ${match.line.trim()}`)
        .join("\n");
      dispatch({
        type: "message.add",
        role: "system",
        text: matches || `No matches for "${query}".`,
      });
      dispatch({
        type: "activity.add",
        level: "success",
        text: `Search complete: ${results.matches.length} matches`,
      });
    } catch (error) {
      dispatch({
        type: "activity.add",
        level: "error",
        text: userFacingError(error),
      });
    }
  }

  function showEditPreview() {
    if (state.pendingLocalTool) {
      dispatch({ type: "message.add", role: "system", text: formatLocalToolApproval(state.pendingLocalTool) });
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending local action." });
  }

  async function applyPendingEdit(allowFutureLocalActions: boolean) {
    const workdir = workdirRef.current;
    if (!workdir) {
      dispatch({ type: "message.add", role: "system", text: "Workdir is still loading." });
      return;
    }
    if (state.pendingLocalTool) {
      dispatch({
        type: "activity.add",
        level: "warning",
        text: `Applying local action: ${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`,
      });
      try {
        const result = await applyLocalToolApproval(workdir, state.pendingLocalTool);
        const nextAccessMode = allowFutureLocalActions ? "full" : state.accessMode;
        if (allowFutureLocalActions) {
          dispatch({ type: "access.set", mode: "full" });
        }
        dispatch({
          type: "message.add",
          role: "system",
          text: [
            allowFutureLocalActions
              ? "Applied local action. Future local actions in this workbench conversation are now allowed."
              : "Applied local action once. Future local actions still require approval.",
            "Continuing agent turn with the local result.",
            "Result:",
            JSON.stringify(result, null, 2),
          ].join("\n"),
        });
        dispatch({ type: "activity.add", level: "success", text: "Local action applied" });
        const approval = state.pendingLocalTool;
        dispatch({ type: "local_tool.pending.clear" });
        const assistantId = `assistant-${Date.now()}`;
        dispatch({ type: "busy.set", busy: true });
        dispatch({ type: "message.add", role: "assistant", text: "", id: assistantId });
        dispatch({ type: "assistant.active", id: assistantId });
        dispatch({ type: "activity.add", text: "Continuing agent turn" });
        const abortController = new AbortController();
        activeAbortControllerRef.current = abortController;
        activeResponseIDRef.current = null;
        const continuation = await resumeAgentAfterLocalApproval(
          {
            ...options,
            preset: state.runPreset,
            model: state.runModel,
            stream: true,
            file: undefined,
            stdin: false,
            conversation: state.currentConversation,
            includeLocalContext: state.contextEnabled,
            accessMode: nextAccessMode,
            restartConversation: false,
            abortSignal: abortController.signal,
          },
          approval,
          result,
          (event) => handleAgentEvent(event, assistantId),
        );
        dispatch({
          type: "activity.add",
          level: "success",
          text: continuation.responseID ? `Agent turn continued: ${continuation.responseID}` : "Agent turn continued",
        });
      } catch (error) {
        handleTurnError(error);
      } finally {
        flushTextDeltaBuffer();
        activeAbortControllerRef.current = null;
        activeResponseIDRef.current = null;
        dispatch({ type: "busy.set", busy: false });
        dispatch({ type: "assistant.active", id: null });
      }
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending local action." });
  }

  function rejectPendingEdit() {
    if (state.pendingLocalTool) {
      dispatch({
        type: "activity.add",
        text: `Rejected local action: ${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`,
      });
      dispatch({ type: "local_tool.pending.clear" });
      return;
    }
    dispatch({ type: "message.add", role: "system", text: "No pending local action." });
  }

  async function send(prompt: string) {
    const assistantId = `assistant-${Date.now()}`;
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    activeResponseIDRef.current = null;
    dispatch({ type: "busy.set", busy: true });
    dispatch({ type: "message.add", role: "user", text: prompt });
    dispatch({ type: "message.add", role: "assistant", text: "", id: assistantId });
    dispatch({ type: "assistant.active", id: assistantId });
    dispatch({ type: "activity.add", text: "Agent turn started" });
    try {
      const result = await runAgentTurn(
        {
          ...options,
          preset: state.runPreset,
          model: state.runModel,
          promptParts: [prompt],
          stream: true,
          file: undefined,
          stdin: false,
          conversation: state.currentConversation,
          includeLocalContext: state.contextEnabled,
          accessMode: state.accessMode,
          restartConversation: false,
          abortSignal: abortController.signal,
        },
        (event) => handleAgentEvent(event, assistantId),
      );
      dispatch({
        type: "activity.add",
        level: "success",
        text: result.responseID ? `Agent turn completed: ${result.responseID}` : "Agent turn completed",
      });
    } catch (error) {
      handleTurnError(error);
    } finally {
      flushTextDeltaBuffer();
      if (activeAbortControllerRef.current === abortController) {
        activeAbortControllerRef.current = null;
      }
      activeResponseIDRef.current = null;
      dispatch({ type: "busy.set", busy: false });
      dispatch({ type: "assistant.active", id: null });
    }
  }

  function handleAgentEvent(event: AgentTurnEvent, assistantId: string) {
    switch (event.type) {
      case "text.delta":
        appendTextDeltaBuffered(assistantId, event.delta);
        return;
      case "response.started":
        if (event.responseID) activeResponseIDRef.current = event.responseID;
        dispatch({ type: "activity.add", text: event.responseID ? `Response started: ${event.responseID}` : "Response started" });
        return;
      case "response.completed":
        flushTextDeltaBuffer();
        dispatch({ type: "activity.add", level: "success", text: event.responseID ? `Response completed: ${event.responseID}` : "Response completed" });
        return;
      case "response.failed":
        flushTextDeltaBuffer();
        dispatch({ type: "activity.add", level: "error", text: event.message });
        return;
      case "reasoning.started":
        dispatch({ type: "activity.add", text: "Reasoning started" });
        return;
      case "reasoning.stopped":
        dispatch({ type: "activity.add", text: event.thought ? `Reasoning stopped: ${event.thought}` : "Reasoning stopped" });
        return;
      case "reasoning.search_queries":
        dispatch({ type: "activity.add", text: `Search queries: ${event.queries.join(", ") || "none"}` });
        return;
      case "reasoning.search_results":
        dispatch({ type: "activity.add", text: `Search results: ${event.count}` });
        return;
      case "reasoning.fetch_url_queries":
        dispatch({ type: "activity.add", text: `Fetch URLs: ${event.urls.join(", ") || "none"}` });
        return;
      case "reasoning.fetch_url_results":
        dispatch({ type: "activity.add", text: `Fetched URL results: ${event.count}` });
        return;
      case "tool.completed":
        dispatch({ type: "activity.add", level: event.status === "failed" ? "error" : "success", text: `Tool completed: ${event.name}${event.status ? ` (${event.status})` : ""}` });
        return;
      case "local_tool.completed":
        dispatch({
          type: "activity.add",
          level: event.requiresApproval ? "warning" : "success",
          text: `Local tool: ${event.name}${event.action ? `.${event.action}` : ""}${event.requiresApproval ? " (approval required)" : ""}`,
        });
        return;
      case "local_tool.approval_requested":
        dispatch({
          type: "local_tool.pending.set",
          approval: {
            name: event.name,
            action: event.action,
            arguments: event.arguments,
            preview: event.preview,
            callID: event.callID,
            responseID: event.responseID,
          },
        });
        dispatch({ type: "message.add", role: "system", text: formatLocalToolApproval(event) });
        return;
      case "model.requested":
        dispatch({ type: "activity.add", text: `Model requested: ${modelLabel(event.model, event.provider)}` });
        return;
      case "model.completed":
        dispatch({ type: "activity.add", level: "success", text: `Model completed: ${modelLabel(event.model, event.provider)}` });
        return;
      case "model.failed":
        dispatch({ type: "activity.add", level: "error", text: `Model failed: ${modelLabel(event.model, event.provider)}` });
        return;
      case "step.completed":
        dispatch({ type: "activity.add", level: "success", text: `Step completed: ${event.stepType || "step"}` });
        return;
      case "step.failed":
        dispatch({ type: "activity.add", level: "error", text: `Step failed: ${event.stepType || "step"}` });
        return;
      case "raw":
        return;
    }
  }

  async function abortActiveTurn(reason: string) {
    const controller = activeAbortControllerRef.current;
    const responseID = activeResponseIDRef.current;
    if (!state.busy && !controller && !responseID) {
      dispatch({ type: "message.add", role: "system", text: "No agent turn is running." });
      return;
    }
    controller?.abort();
    dispatch({ type: "activity.add", level: "warning", text: reason });
    if (!responseID) {
      dispatch({ type: "message.add", role: "system", text: "Abort requested. No remote response ID is available yet." });
      return;
    }
    if (cancelledResponseIDsRef.current.has(responseID)) return;
    cancelledResponseIDsRef.current.add(responseID);
    try {
      const runtimeProfile = await resolveRuntimeProfile(options.profile);
      const result = await runtimeProfile.client.responses.cancel(responseID);
      dispatch({
        type: "message.add",
        role: "system",
        text: result.interrupted
          ? `Abort requested for response ${responseID}.`
          : `Abort requested locally. Remote response ${responseID} was not actively interrupted.`,
      });
      dispatch({
        type: "activity.add",
        level: result.interrupted ? "success" : "warning",
        text: result.interrupted ? `Response cancel requested: ${responseID}` : `Response was not active: ${responseID}`,
      });
    } catch (error) {
      dispatch({ type: "message.add", role: "system", text: `Abort requested locally, but remote cancel failed: ${userFacingError(error)}` });
      dispatch({ type: "activity.add", level: "error", text: "Remote response cancel failed" });
    }
  }

  function handleTurnError(error: unknown) {
    const message = userFacingError(error);
    const aborted = /aborted/i.test(message);
    dispatch({
      type: "message.add",
      role: "system",
      text: aborted ? "Agent turn aborted." : message,
    });
    dispatch({
      type: "activity.add",
      level: aborted ? "warning" : "error",
      text: aborted ? "Agent turn aborted" : message,
    });
  }

  function appendTextDeltaBuffered(id: string, delta: string) {
    if (!delta) return;
    const current = textDeltaBufferRef.current;
    if (!current || current.id !== id) {
      flushTextDeltaBuffer();
      textDeltaBufferRef.current = { id, text: delta };
    } else {
      current.text += delta;
    }
    if (textDeltaFlushTimerRef.current) return;
    textDeltaFlushTimerRef.current = setTimeout(() => {
      textDeltaFlushTimerRef.current = null;
      flushTextDeltaBuffer();
    }, 80);
  }

  function flushTextDeltaBuffer() {
    if (textDeltaFlushTimerRef.current) {
      clearTimeout(textDeltaFlushTimerRef.current);
      textDeltaFlushTimerRef.current = null;
    }
    const buffered = textDeltaBufferRef.current;
    if (!buffered || !buffered.text) return;
    textDeltaBufferRef.current = null;
    dispatch({ type: "message.append", id: buffered.id, delta: buffered.text });
  }

  return (
    <Box flexDirection="column">
      <Header
        contextEnabled={state.contextEnabled}
        conversation={state.currentConversation}
        model={state.runModel || "auto"}
        accessMode={state.accessMode}
        pendingLocalLabel={pendingLocalLabel(state)}
        preset={state.runPreset || "none"}
        profile={profileName}
        renderMode={state.renderMode}
        workdir={state.workdir?.root || options.workdir || process.cwd()}
      />
      <Box marginTop={1} height={viewportHeight}>
        <Box flexDirection="column" width="72%" paddingRight={1}>
          {visibleTranscriptLines.map((line) => (
            <Text bold={line.bold} color={line.color} inverse={line.inverse} key={line.id}>
              {line.text || " "}
            </Text>
          ))}
          {visibleTranscriptLines.length === 0 && <Text color="gray">No transcript lines.</Text>}
        </Box>
        <Box flexDirection="column" width="28%" height={viewportHeight} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Activity</Text>
          {state.activities.slice(-Math.max(1, viewportHeight - 2)).map((activity) => (
            <Text color={activityColor(activity.level)} key={activity.id}>
              {new Date(activity.timestamp).toLocaleTimeString()} {activity.text}
            </Text>
          ))}
        </Box>
      </Box>
      <Box borderStyle="single" borderColor={state.busy ? "yellow" : "green"} paddingX={1}>
        {state.accessMode === "full" && (
          <Text color="red" bold inverse>
            FULL ACCESS
          </Text>
        )}
        {state.accessMode === "full" && <Text> </Text>}
        <Text color={state.busy ? "yellow" : "green"}>{state.busy ? "working" : "you"} </Text>
        {state.busy ? (
          <Text>
            <Text color="yellow">{spinnerGlyph(spinnerFrame)}</Text> waiting for agent {elapsedDots(spinnerFrame)}
          </Text>
        ) : (
          <Text>
            {draft}
            <Cursor visible />
          </Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color="gray">
          PgUp/PgDn scroll · End live · /export save · /transcript preview
          {clampedTranscriptOffset > 0 ? ` · ${clampedTranscriptOffset} rows from latest` : " · live"}
        </Text>
      </Box>
    </Box>
  );
}

function AuthGate({ state }: { state: AuthGateState }) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold>Agent API Workbench</Text>
        <Text color="gray">Authentication required before starting the conversation UI.</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={state.error ? "red" : "gray"}>{state.error || state.message}</Text>
        {state.status === "checking" && <Text color="yellow">Checking...</Text>}
        {state.status === "select" && (
          <Box flexDirection="column" marginTop={1}>
            {authMethods.map((method, index) => (
              <Text color={index === state.selectedMethod ? "green" : "gray"} key={method.method}>
                {index === state.selectedMethod ? "›" : " "} {method.label} - {method.description}
              </Text>
            ))}
            <Text color="gray">Use ↑/↓ and Enter.</Text>
          </Box>
        )}
        {state.status === "api_profile" && <AuthPrompt label="Profile" value={state.profile} />}
        {state.status === "api_base_url" && <AuthPrompt label="Base URL" value={state.baseURL} />}
        {state.status === "api_key" && <AuthPrompt label="API key" value={state.apiKey ? "•".repeat(Math.min(state.apiKey.length, 32)) : ""} />}
        {state.status === "browser_profile" && <AuthPrompt label="Profile" value={state.profile} />}
        {state.status === "browser_base_url" && <AuthPrompt label="Base URL" value={state.baseURL} />}
        {state.status === "browser_waiting" && (
          <Box flexDirection="column" marginTop={1}>
            {state.browserURL && <Text>URL: {state.browserURL}</Text>}
            {state.browserCode && <Text>Code: {state.browserCode}</Text>}
            <Text color="yellow">Waiting for browser approval...</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function AuthPrompt({ label, value }: { label: string; value: string }) {
  return (
    <Box borderStyle="single" borderColor="green" paddingX={1} marginTop={1}>
      <Text color="green">{label}: </Text>
      <Text>{value}</Text>
    </Box>
  );
}

function Header({
  contextEnabled,
  conversation,
  accessMode,
  model,
  pendingLocalLabel,
  preset,
  profile,
  renderMode,
  workdir,
}: {
  contextEnabled: boolean;
  conversation: string;
  accessMode: string;
  model: string;
  pendingLocalLabel: string;
  preset: string;
  profile: string;
  renderMode: RenderMode;
  workdir: string;
}) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold>Agent API Workbench</Text>
      <Text color="gray">
        profile={profile} conversation={conversation} preset={preset} model={model}
      </Text>
      <Text color="gray">
        workdir={workdir} access={accessMode} local_tools={contextEnabled ? "on" : "off"} render={renderMode} pending={pendingLocalLabel}
      </Text>
    </Box>
  );
}

type TranscriptLine = {
  id: string;
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
};

function buildTranscriptLines(
  messages: WorkbenchMessage[],
  options: {
    activeAssistantMessageId: string | null;
    busy: boolean;
    renderMode: RenderMode;
    spinnerFrame: number;
    width: number;
  },
) {
  const lines: TranscriptLine[] = [];
  for (const message of messages) {
    const waiting = message.role === "assistant" && options.busy && message.id === options.activeAssistantMessageId && !message.text;
    lines.push({
      id: `${message.id}:role`,
      text: roleLabel(message.role),
      color: roleColor(message.role),
    });
    const content = message.text || (waiting ? `${spinnerGlyph(options.spinnerFrame)} thinking ${elapsedDots(options.spinnerFrame)}` : "");
    const rendered = options.renderMode === "raw"
      ? rawTranscriptLines(content, options.width)
      : markdownTranscriptLines(content, options.width);
    rendered.forEach((line, index) => {
      lines.push({
        ...line,
        id: `${message.id}:line:${index}`,
      });
    });
    if (message.role !== "system") {
      lines.push({ id: `${message.id}:space`, text: "" });
    }
  }
  return lines;
}

function rawTranscriptLines(text: string, width: number): Omit<TranscriptLine, "id">[] {
  const source = text ? text.split(/\r?\n/) : [""];
  return source.flatMap((line) => wrapTranscriptText(line, width).map((text) => ({ text })));
}

function markdownTranscriptLines(text: string, width: number): Omit<TranscriptLine, "id">[] {
  const source = text ? text.split(/\r?\n/) : [""];
  const lines: Omit<TranscriptLine, "id">[] = [];
  let inCode = false;
  for (const sourceLine of source) {
    if (/^\s*```/.test(sourceLine)) {
      inCode = !inCode;
      lines.push(...wrapTranscriptText(sourceLine, width).map((line) => ({ text: line, color: "gray" })));
      continue;
    }
    lines.push(...markdownTranscriptLine(sourceLine, { code: inCode, width }));
  }
  return lines;
}

function markdownTranscriptLine(line: string, options: { code: boolean; width: number }): Omit<TranscriptLine, "id">[] {
  if (line === "") return [{ text: "" }];
  if (options.code) return wrapTranscriptText(line, options.width).map((text) => ({ text, color: "gray" }));
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const color = heading[1].length <= 2 ? "cyan" : "blue";
    return wrapTranscriptText(heading[2], options.width).map((text) => ({ text, bold: true, color }));
  }
  if (/^\s*---+\s*$/.test(line)) return [{ text: "─".repeat(Math.min(48, options.width)), color: "gray" }];
  const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);
  if (bullet) return wrapTranscriptText(`${bullet[1]}• ${bullet[2]}`, options.width).map((text) => ({ text }));
  const numbered = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
  if (numbered) return wrapTranscriptText(`${numbered[1]}${numbered[2]} ${numbered[3]}`, options.width).map((text) => ({ text }));
  const quote = /^\s*>\s?(.+)$/.exec(line);
  if (quote) return wrapTranscriptText(`│ ${quote[1]}`, options.width).map((text) => ({ text, color: "gray" }));
  return wrapTranscriptText(line, options.width).map((text) => ({ text }));
}

function wrapTranscriptText(text: string, width: number): string[] {
  const max = Math.max(12, width);
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const hard = rest.slice(0, max);
    const softBreak = Math.max(hard.lastIndexOf(" "), hard.lastIndexOf("\t"));
    const index = softBreak > Math.floor(max * 0.45) ? softBreak : max;
    lines.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  lines.push(rest);
  return lines;
}

function roleLabel(role: WorkbenchMessage["role"]) {
  if (role === "user") return "You";
  if (role === "assistant") return "Agent";
  return "System";
}

function roleColor(role: WorkbenchMessage["role"]) {
  if (role === "user") return "green";
  if (role === "assistant") return "cyan";
  return "gray";
}

function modelLabel(model?: string, provider?: string) {
  if (model && provider) return `${provider}/${model}`;
  return model || provider || "unknown";
}

function Cursor({ visible }: { visible: boolean }) {
  return visible ? <Text inverse> </Text> : <Text> </Text>;
}

function spinnerGlyph(frame: number) {
  return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame % 10];
}

function elapsedDots(frame: number) {
  return ".".repeat((Math.floor(frame / 4) % 3) + 1);
}

function defaultTranscriptExportPath(conversation: string) {
  const safeConversation = conversation.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "conversation";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(runtime.dirs.data, "transcripts", `${safeConversation}-${stamp}.txt`);
}

function createConversationName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `thread-${stamp}`;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeOptionalSetting(value: string, clearValues: string[]) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return clearValues.includes(trimmed.toLowerCase()) ? undefined : trimmed;
}

function runConfigText({
  accessMode,
  contextEnabled,
  defaultPreset,
  profileName,
  runModel,
  runPreset,
  renderMode,
}: {
  accessMode: string;
  contextEnabled: boolean;
  defaultPreset?: string | null;
  profileName: string;
  runModel?: string;
  runPreset?: string;
  renderMode: RenderMode;
}) {
  return [
    `Profile: ${profileName}`,
    `Preset: ${runPreset || "none"}`,
    `Default preset: ${formatDefaultPreset(defaultPreset)}`,
    `Model: ${runModel || "auto"}`,
    `Render mode: ${renderMode}`,
    `local_workdir tool: ${contextEnabled ? "on" : "off"}`,
    `local_shell tool: ${contextEnabled ? "on" : "off"}`,
    `Local access: ${accessMode}`,
  ].join("\n");
}

function normalizeDefaultPreset(value: string) {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed || lowered === "reset" || lowered === "default" || lowered === "builtin") return undefined;
  if (["none", "off", "disable", "disabled"].includes(lowered)) return null;
  return trimmed;
}

function formatDefaultPreset(value: string | null | undefined) {
  if (value === undefined) return "built-in (pro-search)";
  return value ?? "none";
}

function effectiveDefaultPreset(preferences: WorkbenchPreferences, builtInPreset?: string) {
  if ("defaultPreset" in preferences) return preferences.defaultPreset ?? undefined;
  return builtInPreset;
}

export function formatPresetList(presets: Awaited<ReturnType<typeof listAvailablePresets>>, currentPreset?: string) {
  if (presets.length === 0) return ["- none returned by this endpoint"];
  return presets.map((preset) => {
    const description = preset.description ? ` - ${preset.description}` : "";
    const current = currentPreset && preset.preset === currentPreset;
    return `${current ? "*" : "-"} ${preset.preset}${current ? " (current)" : ""}${description}`;
  });
}

function authStatusText(status: Awaited<ReturnType<typeof getAuthStatus>>) {
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

async function applyLocalToolApproval(
  workdir: WorkdirService,
  approval: NonNullable<WorkbenchState["pendingLocalTool"]>,
) {
  const workdirRegistry = createLocalWorkdirToolRegistry(workdir.workdir, { accessMode: "full" });
  const shellRegistry = createLocalShellToolRegistry({ workdir: workdir.workdir, accessMode: "full" });
  if (approval.name === workdirRegistry.toolName) {
    return await workdirRegistry.execute(approval.name, approval.arguments);
  }
  if (approval.name === shellRegistry.toolName) {
    return await shellRegistry.execute(approval.name, approval.arguments);
  }
  throw new Error(`no local handler registered for function ${approval.name}`);
}

function formatLocalToolApproval(approval: {
  name: string;
  action?: string;
  arguments: Record<string, unknown>;
  preview?: unknown;
}) {
  return [
    `Local approval requested: ${approval.name}${approval.action ? `.${approval.action}` : ""}`,
    "Arguments:",
    JSON.stringify(approval.arguments, null, 2),
    approval.preview ? ["Preview:", JSON.stringify(approval.preview, null, 2)].join("\n") : "",
    "",
    "Use /apply to execute this action once, /apply-all to allow future local actions, or /reject to discard it.",
  ].filter(Boolean).join("\n");
}

function pendingLocalLabel(state: WorkbenchState) {
  if (state.pendingLocalTool) {
    return `${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`;
  }
  return "none";
}
