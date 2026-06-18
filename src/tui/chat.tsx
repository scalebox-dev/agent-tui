import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { createLocalWorkspaceToolRegistry } from "@agent-api/sdk/local";
import { defaultBaseURL } from "../config.js";
import {
  conversationSummary,
  clearPresetToolCatalogCache,
  deleteConversation,
  listConversations,
  resumeAgentAfterLocalApproval,
  runAgentTurn,
  type AgentRunOptions,
  type AgentTurnEvent,
} from "../agent.js";
import {
  openWorkspace,
  type WorkspaceService,
} from "../workspace/index.js";
import {
  activityColor,
  createInitialWorkbenchState,
  formatBytes,
  helpText,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  workbenchReducer,
  workspaceText,
  type WorkbenchMessage,
} from "./workbench.js";
import {
  deleteProfile,
  formatDeviceUserCode,
  loginWithAPIKey,
  openBrowserURL,
  refreshActiveProfileIfNeeded,
  saveBrowserProfile,
  startBrowserAuthChallenge,
  waitForBrowserAuthChallenge,
} from "../profile.js";

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
            status: "select",
            message: "Choose an auth method to continue into the workbench.",
            error: "",
          }));
        }}
        onLogout={async () => {
          await deleteProfile(currentProfile);
          setAuth((current) => ({
            ...current,
            status: "select",
            message: `Signed out profile "${currentProfile}". Choose an auth method to continue.`,
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
  options,
  profileName,
}: {
  onLogin: () => void;
  onLogout: () => Promise<void>;
  options: AgentRunOptions;
  profileName: string;
}) {
  const app = useApp();
  const workspaceRef = useRef<WorkspaceService | null>(null);
  const initialPromptSubmittedRef = useRef(false);
  const pendingApprovalInvalidInputsRef = useRef(0);
  const authRefreshWarningShownRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [runPreset, setRunPreset] = useState(options.preset);
  const [runModel, setRunModel] = useState(options.model);
  const [state, dispatch] = useReducer(
    workbenchReducer,
    {
      accessMode: options.accessMode,
      conversation: options.conversation,
      contextEnabled: Boolean(options.includeLocalContext || options.workspace),
    },
    createInitialWorkbenchState,
  );

  useEffect(() => {
    let mounted = true;
    dispatch({ type: "activity.add", text: "Loading workspace" });
    openWorkspace({ path: options.workspace || process.cwd() })
      .then(async (workspace) => {
        const summary = await workspace.summarize();
        if (!mounted) return;
        workspaceRef.current = workspace;
        dispatch({
          type: "workspace.set",
          workspace: {
            root: workspace.root,
            name: workspace.name,
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
          text: `Workspace unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      mounted = false;
    };
  }, [options.workspace]);

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
    if (state.busy) return;
    if (key.return) {
      const prompt = draft.trim();
      if (!prompt) return;
      setDraft("");
      void submit(prompt);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((current) => current.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft((current) => current + input);
    }
  });

  useEffect(() => {
    if (initialPromptSubmittedRef.current || state.busy) return;
    const initialPrompt = options.promptParts.join(" ").trim();
    if (!initialPrompt) return;
    if (!workspaceRef.current) return;
    initialPromptSubmittedRef.current = true;
    void send(initialPrompt);
  }, [options.promptParts, state.busy, state.workspace]);

  useEffect(() => {
    pendingApprovalInvalidInputsRef.current = 0;
  }, [state.pendingLocalTool?.id]);

  async function submit(input: string) {
    if (state.pendingLocalTool) {
      const pendingApprovalCommand = parsePendingApprovalCommand(input);
      if (pendingApprovalCommand) {
        pendingApprovalInvalidInputsRef.current = 0;
        await runCommand(pendingApprovalCommand);
        return;
      }
      handleInvalidPendingApprovalInput();
      return;
    }
    const command = parseWorkbenchCommand(input);
    if (command) {
      await runCommand(command);
      return;
    }
    await send(input);
  }

  function handleInvalidPendingApprovalInput() {
    pendingApprovalInvalidInputsRef.current += 1;
    const attempts = pendingApprovalInvalidInputsRef.current;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      dispatch({
        type: "message.add",
        role: "system",
        text: "Local approval aborted after too many invalid inputs. The pending action was not executed.",
      });
      dispatch({ type: "activity.add", level: "warning", text: "Local approval aborted" });
      dispatch({ type: "local_tool.pending.clear" });
      pendingApprovalInvalidInputsRef.current = 0;
      return;
    }
    dispatch({
      type: "message.add",
      role: "system",
      text: `Local approval is pending. Enter /apply or /yes to execute once, /apply-all or /yes-all to allow future local actions, or /reject or /no to discard. Invalid input ${attempts}/${maxAttempts}.`,
    });
    dispatch({ type: "activity.add", level: "warning", text: "Waiting for local approval command" });
  }

  async function runCommand(command: NonNullable<ReturnType<typeof parseWorkbenchCommand>>) {
    switch (command.kind) {
      case "exit":
        app.exit();
        return;
      case "help":
        dispatch({ type: "message.add", role: "system", text: helpText() });
        return;
      case "clear":
        dispatch({ type: "messages.clear" });
        return;
      case "login":
        onLogin();
        return;
      case "logout":
        dispatch({ type: "activity.add", text: `Signing out profile: ${profileName}` });
        await onLogout();
        return;
      case "auth_status":
        dispatch({ type: "message.add", role: "system", text: `Authenticated profile: ${profileName}` });
        return;
      case "config":
        dispatch({ type: "message.add", role: "system", text: runConfigText({ profileName, runPreset, runModel, accessMode: state.accessMode, contextEnabled: state.contextEnabled }) });
        return;
      case "context":
        dispatch({ type: "context.toggle" });
        return;
      case "access":
        if (!command.mode) {
          dispatch({ type: "message.add", role: "system", text: `Workspace access: ${state.accessMode}. Use /access approval or /access full.` });
          return;
        }
        dispatch({ type: "access.set", mode: command.mode });
        return;
      case "preset":
        if (!command.value) {
          dispatch({ type: "message.add", role: "system", text: `Preset: ${runPreset || "none"}. Use /preset <name> or /preset none.` });
          return;
        }
        setRunPreset(normalizeOptionalSetting(command.value, ["none", "off", "clear"]));
        dispatch({ type: "activity.add", text: `Preset: ${normalizeOptionalSetting(command.value, ["none", "off", "clear"]) || "none"}` });
        return;
      case "model":
        if (!command.value) {
          dispatch({ type: "message.add", role: "system", text: `Model: ${runModel || "auto"}. Use /model <name> or /model auto.` });
          return;
        }
        setRunModel(normalizeOptionalSetting(command.value, ["auto", "none", "off", "clear"]));
        dispatch({ type: "activity.add", text: `Model: ${normalizeOptionalSetting(command.value, ["auto", "none", "off", "clear"]) || "auto"}` });
        return;
      case "workspace":
        dispatch({ type: "message.add", role: "system", text: workspaceText(state.workspace) });
        return;
      case "summary":
        await showSummary();
        return;
      case "search":
        await searchWorkspace(command.query);
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
      case "refresh_catalog":
        clearPresetToolCatalogCache();
        dispatch({ type: "activity.add", level: "success", text: "Preset and tool catalogs refreshed" });
        dispatch({ type: "message.add", role: "system", text: "Cleared cached preset and server tool catalogs. The next agent turn will fetch fresh platform configuration." });
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

  async function showSummary() {
    const workspace = workspaceRef.current;
    if (!workspace) {
      dispatch({ type: "message.add", role: "system", text: "Workspace is still loading." });
      return;
    }
    dispatch({ type: "activity.add", text: "Summarizing workspace" });
    try {
      const summary = await workspace.summarize();
      const previews = summary.text_previews
        .slice(0, 5)
        .map((preview) => `- ${preview.path} (${formatBytes(preview.size)})`)
        .join("\n");
      dispatch({
        type: "message.add",
        role: "system",
        text: [
          `Workspace summary for ${workspace.name}`,
          `Files: ${summary.file_count}`,
          `Size: ${formatBytes(summary.total_bytes)}`,
          previews ? `Previews:\n${previews}` : "No text previews available.",
        ].join("\n"),
      });
      dispatch({ type: "activity.add", level: "success", text: "Workspace summary ready" });
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

  async function searchWorkspace(query: string) {
    const workspace = workspaceRef.current;
    if (!query) {
      dispatch({ type: "message.add", role: "system", text: "Usage: /search <query>" });
      return;
    }
    if (!workspace) {
      dispatch({ type: "message.add", role: "system", text: "Workspace is still loading." });
      return;
    }
    dispatch({ type: "activity.add", text: `Searching workspace: ${query}` });
    try {
      const results = await workspace.workspace.grep({ pattern: query, limit: 12 });
      const matches = results.matches
        .map((match) => `${match.path}:${match.line_number}: ${match.line.trim()}`)
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
    const workspace = workspaceRef.current;
    if (!workspace) {
      dispatch({ type: "message.add", role: "system", text: "Workspace is still loading." });
      return;
    }
    if (state.pendingLocalTool) {
      dispatch({
        type: "activity.add",
        level: "warning",
        text: `Applying local action: ${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`,
      });
      try {
        const result = await applyLocalToolApproval(workspace, state.pendingLocalTool);
        const nextAccessMode = allowFutureLocalActions ? "full" : state.accessMode;
        if (allowFutureLocalActions) {
          dispatch({ type: "access.set", mode: "full" });
        }
        dispatch({
          type: "message.add",
          role: "system",
          text: [
            allowFutureLocalActions
              ? "Applied local action. Future local workspace actions in this workbench conversation are now allowed."
              : "Applied local action once. Future local workspace actions still require approval.",
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
        const continuation = await resumeAgentAfterLocalApproval(
          {
            ...options,
            preset: runPreset,
            model: runModel,
            stream: true,
            file: undefined,
            stdin: false,
            conversation: state.currentConversation,
            includeLocalContext: state.contextEnabled,
            accessMode: nextAccessMode,
            restartConversation: false,
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
        dispatch({
          type: "message.add",
          role: "system",
          text: userFacingError(error),
        });
        dispatch({
          type: "activity.add",
          level: "error",
          text: userFacingError(error),
        });
      } finally {
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
    dispatch({ type: "busy.set", busy: true });
    dispatch({ type: "message.add", role: "user", text: prompt });
    dispatch({ type: "message.add", role: "assistant", text: "", id: assistantId });
    dispatch({ type: "assistant.active", id: assistantId });
    dispatch({ type: "activity.add", text: "Agent turn started" });
    try {
      const result = await runAgentTurn(
        {
          ...options,
          preset: runPreset,
          model: runModel,
          promptParts: [prompt],
          stream: true,
          file: undefined,
          stdin: false,
          conversation: state.currentConversation,
          includeLocalContext: state.contextEnabled,
          accessMode: state.accessMode,
          restartConversation: false,
        },
        (event) => handleAgentEvent(event, assistantId),
      );
      dispatch({
        type: "activity.add",
        level: "success",
        text: result.responseID ? `Agent turn completed: ${result.responseID}` : "Agent turn completed",
      });
    } catch (error) {
      dispatch({
        type: "message.add",
        role: "system",
        text: userFacingError(error),
      });
      dispatch({
        type: "activity.add",
        level: "error",
        text: userFacingError(error),
      });
    } finally {
      dispatch({ type: "busy.set", busy: false });
      dispatch({ type: "assistant.active", id: null });
    }
  }

  function handleAgentEvent(event: AgentTurnEvent, assistantId: string) {
    switch (event.type) {
      case "text.delta":
        dispatch({ type: "message.append", id: assistantId, delta: event.delta });
        return;
      case "response.started":
        dispatch({ type: "activity.add", text: event.responseID ? `Response started: ${event.responseID}` : "Response started" });
        return;
      case "response.completed":
        dispatch({ type: "activity.add", level: "success", text: event.responseID ? `Response completed: ${event.responseID}` : "Response completed" });
        return;
      case "response.failed":
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

  return (
    <Box flexDirection="column">
      <Header
        contextEnabled={state.contextEnabled}
        conversation={state.currentConversation}
        model={runModel || "auto"}
        accessMode={state.accessMode}
        pendingLocalLabel={pendingLocalLabel(state)}
        preset={runPreset || "none"}
        profile={profileName}
        workspace={state.workspace?.root || options.workspace || process.cwd()}
      />
      <Box marginTop={1}>
        <Box flexDirection="column" width="72%" paddingRight={1}>
          {state.messages.map((message) => (
            <MessageBlock busy={state.busy} key={message.id} message={message} />
          ))}
        </Box>
        <Box flexDirection="column" width="28%" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Activity</Text>
          {state.activities.slice(-8).map((activity) => (
            <Text color={activityColor(activity.level)} key={activity.id}>
              {new Date(activity.timestamp).toLocaleTimeString()} {activity.text}
            </Text>
          ))}
        </Box>
      </Box>
      <Box borderStyle="single" borderColor={state.busy ? "yellow" : "green"} paddingX={1}>
        <Text color={state.busy ? "yellow" : "green"}>{state.busy ? "working" : "you"} </Text>
        <Text>{state.busy ? "waiting for agent..." : draft}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color="gray">/help /auth /login /logout /config /preset /model /access /context /new /switch /workspace /apply /reject /exit</Text>
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
  workspace,
}: {
  contextEnabled: boolean;
  conversation: string;
  accessMode: string;
  model: string;
  pendingLocalLabel: string;
  preset: string;
  profile: string;
  workspace: string;
}) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold>Agent API Workbench</Text>
      <Text color="gray">
        profile={profile} conversation={conversation} preset={preset} model={model}
      </Text>
      <Text color="gray">
        workspace={workspace} access={accessMode} context={contextEnabled ? "on" : "off"} pending={pendingLocalLabel}
      </Text>
    </Box>
  );
}

function MessageBlock({ busy, message }: { busy: boolean; message: WorkbenchMessage }) {
  return (
    <Box flexDirection="column" marginBottom={message.role === "system" ? 0 : 1}>
      <Text color={roleColor(message.role)}>{roleLabel(message.role)}</Text>
      <Text>{message.text || (message.role === "assistant" && busy ? "..." : "")}</Text>
    </Box>
  );
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
  profileName,
  runModel,
  runPreset,
}: {
  accessMode: string;
  contextEnabled: boolean;
  profileName: string;
  runModel?: string;
  runPreset?: string;
}) {
  return [
    `Profile: ${profileName}`,
    `Preset: ${runPreset || "none"}`,
    `Model: ${runModel || "auto"}`,
    `Local workspace context/tools: ${contextEnabled ? "on" : "off"}`,
    `Local workspace access: ${accessMode}`,
  ].join("\n");
}

async function applyLocalToolApproval(
  workspace: WorkspaceService,
  approval: NonNullable<ReturnType<typeof createInitialWorkbenchState>["pendingLocalTool"]>,
) {
  const registry = createLocalWorkspaceToolRegistry(workspace.workspace, { accessMode: "full" });
  return await registry.execute(approval.name, approval.arguments);
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

function pendingLocalLabel(state: ReturnType<typeof createInitialWorkbenchState>) {
  if (state.pendingLocalTool) {
    return `${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`;
  }
  return "none";
}
