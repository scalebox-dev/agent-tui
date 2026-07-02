import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput, useStdout } from "ink";
import {
  createAgentEngine,
  defaultBaseURL,
  type AgentEngineApp,
  type AgentRunOptions,
} from "@agent-api/app-engine/core";
import {
  createWorkbenchAuthController,
  createWorkbenchAuthGateController,
  parseWorkbenchCommand,
  type AuthGateState,
  type WorkbenchAuthController,
  type WorkbenchAuthGateController,
} from "@agent-api/app-engine/workbench";
import {
  buildWorkbenchRenderModel,
  copyTextFromActivitySelection,
  copyTextFromActivities,
  copyTextFromHeaderSelection,
  copyTextFromRenderModel,
  copyTextFromTranscriptSelection,
  copyTextFromTranscriptLines,
  createWorkbenchTerminalController,
  initialWorkbenchTerminalState,
  normalizeTerminalState,
  selectedPanelRange,
  type WorkbenchTerminalKey,
  type WorkbenchTerminalState,
} from "@agent-api/app-engine/terminal";
import { InkAuthGate, InkWorkbenchScreen } from "./components.js";
import {
  detectClipboardCapabilities,
  formatClipboardCapabilities,
  readClipboard,
  writeClipboard,
  type ClipboardCapabilities,
} from "../clipboard.js";
import { disableMouseReporting, parseMouseEvent } from "../mouse.js";

export function ChatApp({ options }: { options: AgentRunOptions }) {
  return <AuthenticatedChatApp options={options} />;
}

function AuthenticatedChatApp({ options }: { options: AgentRunOptions }) {
  const app = useApp();
  const { stdout } = useStdout();
  const busyRef = useRef(false);
  const authControllerRef = useRef<WorkbenchAuthController | null>(null);
  const authGateControllerRef = useRef<WorkbenchAuthGateController | null>(null);
  if (!authControllerRef.current) {
    authControllerRef.current = createWorkbenchAuthController();
  }
  const authController = authControllerRef.current;
  if (!authGateControllerRef.current) {
    authGateControllerRef.current = createWorkbenchAuthGateController({ authController });
  }
  const authGateController = authGateControllerRef.current;
  const [currentProfile, setCurrentProfile] = useState(options.profile || "default");
  const [authCursorVisible, setAuthCursorVisible] = useState(true);
  const [auth, setAuth] = useState<AuthGateState>(() => authGateController.initialState({
    apiKey: process.env.AGENT_API_KEY || "",
    baseURL: process.env.AGENT_API_BASE_URL || defaultBaseURL,
    profile: options.profile || "default",
  }));

  useEffect(() => {
    hideTerminalCursor(stdout);
    disableTerminalMouse(stdout);
    return () => {
      disableTerminalMouse(stdout);
      showTerminalCursor(stdout);
    };
  }, [stdout]);

  useEffect(() => {
    let mounted = true;
    authGateController.check(options.profile)
      .then((result) => {
        if (!mounted) return;
        if (result.profileName) setCurrentProfile(result.profileName);
        setAuth(result.state);
      });
    return () => {
      mounted = false;
    };
  }, [authGateController, options.profile]);

  useEffect(() => {
    if (!isAuthInputStatus(auth.status)) {
      setAuthCursorVisible(true);
      return;
    }
    const interval = setInterval(() => {
      setAuthCursorVisible((visible) => !visible);
    }, 500);
    return () => clearInterval(interval);
  }, [auth.status]);

  useInput((input, key) => {
    if (parseMouseEvent(input)) return;
    const result = authGateController.handleInput(input, key, auth);
    if (result.state !== auth) setAuth(result.state);
    for (const effect of result.effects) {
      switch (effect.type) {
        case "exit":
          app.exit();
          break;
        case "submit":
          void submitAuthField();
          break;
      }
    }
  });

  async function submitAuthField() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const result = await authGateController.submit(auth, {
        onState: setAuth,
      });
      if (result.profileName) setCurrentProfile(result.profileName);
      setAuth(result.state);
    } finally {
      busyRef.current = false;
    }
  }

  if (auth.status === "ready") {
    return (
      <WorkbenchApp
        onLogin={() => {
          setAuth((current) => authGateController.requestLogin(current, currentProfile));
        }}
        onLogout={() => {
          setAuth((current) => authGateController.requestLogout(current, currentProfile));
        }}
        onDeleteProfile={async () => {
          await authController.deleteProfile(currentProfile);
          setAuth((current) => authGateController.deletedProfile(current, currentProfile));
        }}
        onSwitchProfile={(name) => {
          setAuth((current) => authGateController.requestSwitchProfile(current, currentProfile, name));
        }}
        options={{ ...options, profile: currentProfile }}
        profileName={currentProfile}
        authController={authController}
      />
    );
  }

  return <InkAuthGate cursorVisible={authCursorVisible} state={auth} />;
}

function hideTerminalCursor(stdout: NodeJS.WriteStream) {
  if (stdout.isTTY) stdout.write("\x1b[?25l");
}

function showTerminalCursor(stdout: NodeJS.WriteStream) {
  if (stdout.isTTY) stdout.write("\x1b[?25h");
}

function disableTerminalMouse(stdout: NodeJS.WriteStream) {
  if (stdout.isTTY) stdout.write(disableMouseReporting);
}

function isAuthInputStatus(status: AuthGateState["status"]) {
  return status === "api_profile"
    || status === "api_base_url"
    || status === "api_key"
    || status === "browser_profile"
    || status === "browser_base_url";
}

function WorkbenchApp({
  authController,
  onLogin,
  onLogout,
  onDeleteProfile,
  onSwitchProfile,
  options,
  profileName,
}: {
  authController: WorkbenchAuthController;
  onLogin: () => void;
  onLogout: () => void;
  onDeleteProfile: () => Promise<void>;
  onSwitchProfile: (name?: string) => void;
  options: AgentRunOptions;
  profileName: string;
}) {
  const app = useApp();
  const { stdout } = useStdout();
  const terminalSize = useTerminalSize(stdout);
  const [clipboardCapabilities, setClipboardCapabilities] = useState<ClipboardCapabilities | null>(null);
  const [terminalState, setTerminalState] = useState<WorkbenchTerminalState>(() => initialWorkbenchTerminalState());
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const agentEngineRef = useRef<AgentEngineApp | null>(null);
  if (!agentEngineRef.current) {
    agentEngineRef.current = createAgentEngine({
      authController,
      baseOptions: options,
      profileName,
      onDeleteProfile,
      onExit: app.exit,
      onLogin,
      onLogout,
      onSwitchProfile,
    });
  }
  const agentEngine = agentEngineRef.current;
  const terminalControllerRef = useRef<ReturnType<typeof createWorkbenchTerminalController> | null>(null);
  if (!terminalControllerRef.current) {
    terminalControllerRef.current = createWorkbenchTerminalController();
  }
  const terminalController = terminalControllerRef.current;
  const state = useSyncExternalStore(agentEngine.subscribe, agentEngine.snapshot, agentEngine.snapshot);
  const dispatch = agentEngine.dispatch;
  const renderModel = useMemo(
    () => buildWorkbenchRenderModel({
      draft: terminalState.draft,
      cursor: terminalState.cursor,
      profileName,
      selectionAnchor: terminalState.selectionAnchor,
      spinnerFrame,
      state,
      transcriptOffset: terminalState.transcriptOffset,
      viewport: {
        rows: terminalSize.rows,
        columns: terminalSize.columns,
      },
      workdirFallback: options.workdir || process.cwd(),
    }),
    [options.workdir, profileName, spinnerFrame, state, terminalSize.columns, terminalSize.rows, terminalState.cursor, terminalState.draft, terminalState.selectionAnchor, terminalState.transcriptOffset],
  );

  useEffect(() => {
    setTerminalState((current) => {
      const next = normalizeTerminalState(current, renderModel);
      return sameTerminalState(current, next) ? current : next;
    });
  }, [renderModel]);

  async function submitInput(input: string) {
    const command = parseWorkbenchCommand(input);
    if (command?.kind === "copy") {
      await copyPanelText(command.target);
      return;
    }
    await agentEngine.submit(input);
  }

  async function copyPanelText(target: "activity" | "header" | "page" | "transcript") {
    const text = copyTextForTarget(target);
    if (!text) {
      dispatch({ type: "activity.add", level: "warning", text: `Nothing to copy: ${target}` });
      return;
    }
    try {
      const copied = await writeClipboard(text, stdout, clipboardCapabilities);
      dispatch({
        type: "activity.add",
        level: copied.reliable ? "success" : copied.ok ? "warning" : "warning",
        text: copied.reliable
          ? `Copied ${target} to clipboard`
          : copied.ok
            ? `Sent ${target} copy request to terminal clipboard (OSC52); your terminal may block it`
            : `Clipboard unavailable for ${target}`,
      });
    } catch (error) {
      dispatch({ type: "activity.add", level: "error", text: `Copy failed: ${userFacingError(error)}` });
    }
  }

  async function pasteClipboardIntoInput() {
    try {
      const text = await readClipboard(clipboardCapabilities);
      if (!text) {
        dispatch({ type: "activity.add", level: "warning", text: "Clipboard paste unavailable" });
        return;
      }
      setTerminalState((current) => {
        const normalized = normalizeTerminalState({ ...current, focusedPanel: "input" }, renderModel);
        const result = terminalController.handle(text, {}, normalized, {
          busy: state.busy,
          renderModel,
        });
        return result.state;
      });
      dispatch({ type: "activity.add", level: "success", text: "Pasted clipboard into input" });
    } catch (error) {
      dispatch({ type: "activity.add", level: "error", text: `Paste failed: ${userFacingError(error)}` });
    }
  }

  function copyTextForTarget(target: "activity" | "header" | "page" | "transcript") {
    if (target === "transcript" || target === "page") {
      const selection = selectedPanelRange(terminalState.transcriptSelectionAnchor, terminalState.transcriptCursor);
      if (selection) return copyTextFromTranscriptSelection(renderModel.transcript.lines, selection);
    }
    if (target === "header") {
      const selection = selectedPanelRange(terminalState.headerSelectionAnchor, terminalState.headerCursor);
      if (selection) return copyTextFromHeaderSelection(renderModel.header.lines, selection);
    }
    if (target === "activity") {
      const selection = selectedPanelRange(terminalState.activitySelectionAnchor, terminalState.activityCursor);
      if (selection) return copyTextFromActivitySelection(renderModel.visibleActivities, selection);
    }
    return copyTextFromRenderModel(renderModel, target);
  }

  useEffect(() => {
    let mounted = true;
    void agentEngine.maybeCheckForUpdate({ isMounted: () => mounted });
    void agentEngine.loadInitialConversation({ isMounted: () => mounted });
    void agentEngine.loadInitialSettings({ isMounted: () => mounted });
    return () => {
      mounted = false;
    };
  }, [agentEngine]);

  useEffect(() => {
    let mounted = true;
    detectClipboardCapabilities(stdout).then((capabilities) => {
      if (!mounted) return;
      setClipboardCapabilities(capabilities);
      dispatch({ type: "activity.add", text: formatClipboardCapabilities(capabilities) });
    });
    return () => {
      mounted = false;
    };
  }, [dispatch, stdout]);

  useEffect(() => {
    if (!state.contextEnabled || state.workdir) return;
    let mounted = true;
    void agentEngine.loadWorkdir(options.workdir || process.cwd(), { isMounted: () => mounted });
    return () => {
      mounted = false;
    };
  }, [agentEngine, options.workdir, state.contextEnabled, state.workdir]);

  useEffect(() => {
    let mounted = true;
    const refreshIntervalMs = 60_000;
    const refreshAuth = async () => {
      if (mounted) await agentEngine.refreshAuth(options.profile, { isMounted: () => mounted });
    };
    void refreshAuth();
    const interval = setInterval(refreshAuth, refreshIntervalMs);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [agentEngine, options.profile]);

  useInput((input, key) => {
    const mouse = parseMouseEvent(input);
    if (mouse) {
      const result = terminalController.handleMouse(mouse, terminalState, {
        busy: state.busy,
        renderModel,
      });
      if (!sameTerminalState(result.state, terminalState)) setTerminalState(result.state);
      return;
    }
    const result = terminalController.handle(input, key as WorkbenchTerminalKey, terminalState, {
      busy: state.busy,
      renderModel,
    });
    if (!sameTerminalState(result.state, terminalState)) setTerminalState(result.state);
    for (const effect of result.effects) {
      switch (effect.type) {
        case "exit":
          app.exit();
          break;
        case "scroll":
          setTerminalState((current) => normalizeTerminalState({
            ...current,
            transcriptOffset: current.transcriptOffset + effect.delta,
          }, renderModel));
          break;
        case "scroll_top":
          setTerminalState((current) => normalizeTerminalState({
            ...current,
            transcriptOffset: renderModel.transcript.maxOffset,
          }, renderModel));
          break;
        case "scroll_bottom":
          setTerminalState((current) => ({ ...current, transcriptOffset: 0 }));
          break;
        case "abort":
          void agentEngine.abortActiveTurn("Abort requested.");
          break;
        case "submit":
          void submitInput(effect.input);
          break;
        case "ignored_busy":
          dispatch({ type: "message.add", role: "system", text: "Agent turn is running. Use /abort or Esc to cancel it." });
          dispatch({ type: "activity.add", level: "warning", text: "Input ignored while agent is running" });
          break;
        case "copy":
          void copyPanelText(effect.target);
          break;
        case "paste":
          void pasteClipboardIntoInput();
          break;
      }
    }
  });

  useEffect(() => {
    void agentEngine.startInitialPrompt();
  }, [agentEngine, state.busy, state.contextEnabled, state.workdir]);

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
    return () => agentEngine.dispose();
  }, [agentEngine]);

  return (
    <InkWorkbenchScreen
      activityCursor={terminalState.activityCursor}
      activitySelection={selectedPanelRange(terminalState.activitySelectionAnchor, terminalState.activityCursor)}
      focusedPanel={terminalState.focusedPanel}
      headerCursor={terminalState.headerCursor}
      headerSelection={selectedPanelRange(terminalState.headerSelectionAnchor, terminalState.headerCursor)}
      renderModel={renderModel}
      spinnerFrame={spinnerFrame}
      transcriptCursor={terminalState.transcriptCursor}
      transcriptSelection={selectedPanelRange(terminalState.transcriptSelectionAnchor, terminalState.transcriptCursor)}
    />
  );
}

function useTerminalSize(stdout: NodeJS.WriteStream) {
  const [size, setSize] = useState(() => ({
    columns: stdout.columns || process.stdout.columns || 100,
    rows: stdout.rows || process.stdout.rows || 32,
  }));

  useEffect(() => {
    const update = () => {
      setSize((current) => {
        const next = {
          columns: stdout.columns || process.stdout.columns || current.columns,
          rows: stdout.rows || process.stdout.rows || current.rows,
        };
        return next.columns === current.columns && next.rows === current.rows ? current : next;
      });
    };
    update();
    stdout.on("resize", update);
    if (stdout !== process.stdout) process.stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
      if (stdout !== process.stdout) process.stdout.off("resize", update);
    };
  }, [stdout]);

  return size;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sameTerminalState(a: WorkbenchTerminalState, b: WorkbenchTerminalState) {
  return a.activityCursor.line === b.activityCursor.line
    && a.activityCursor.column === b.activityCursor.column
    && samePositionOrNull(a.activitySelectionAnchor, b.activitySelectionAnchor)
    && a.cursor === b.cursor
    && a.draft === b.draft
    && a.focusedPanel === b.focusedPanel
    && a.headerCursor.line === b.headerCursor.line
    && a.headerCursor.column === b.headerCursor.column
    && samePositionOrNull(a.headerSelectionAnchor, b.headerSelectionAnchor)
    && a.mouseDragPanel === b.mouseDragPanel
    && a.selectionAnchor === b.selectionAnchor
    && a.transcriptCursor.line === b.transcriptCursor.line
    && a.transcriptCursor.column === b.transcriptCursor.column
    && a.transcriptOffset === b.transcriptOffset
    && samePositionOrNull(a.transcriptSelectionAnchor, b.transcriptSelectionAnchor);
}

function samePositionOrNull(
  a: WorkbenchTerminalState["activitySelectionAnchor"],
  b: WorkbenchTerminalState["activitySelectionAnchor"],
) {
  if (a === null || b === null) return a === b;
  return a.line === b.line && a.column === b.column;
}
