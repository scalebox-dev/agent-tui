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
  copyTextFromRenderModel,
  createWorkbenchInputController,
} from "@agent-api/app-engine/terminal";
import { InkAuthGate, InkWorkbenchScreen } from "./components.js";
import { writeClipboard } from "../clipboard.js";

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
    return () => showTerminalCursor(stdout);
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
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
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
  const inputControllerRef = useRef<ReturnType<typeof createWorkbenchInputController> | null>(null);
  if (!inputControllerRef.current) {
    inputControllerRef.current = createWorkbenchInputController();
  }
  const inputController = inputControllerRef.current;
  const state = useSyncExternalStore(agentEngine.subscribe, agentEngine.snapshot, agentEngine.snapshot);
  const dispatch = agentEngine.dispatch;
  const renderModel = useMemo(
    () => buildWorkbenchRenderModel({
      draft,
      cursor,
      profileName,
      selectionAnchor,
      spinnerFrame,
      state,
      transcriptOffset,
      viewport: {
        rows: terminalSize.rows,
        columns: terminalSize.columns,
      },
      workdirFallback: options.workdir || process.cwd(),
    }),
    [cursor, draft, options.workdir, profileName, selectionAnchor, spinnerFrame, state, terminalSize.columns, terminalSize.rows, transcriptOffset],
  );

  useEffect(() => {
    setTranscriptOffset((offset) => Math.min(offset, renderModel.transcript.maxOffset));
  }, [renderModel.transcript.maxOffset]);

  function scrollTranscript(delta: number) {
    setTranscriptOffset((offset) => Math.max(0, Math.min(renderModel.transcript.maxOffset, offset + delta)));
  }

  function scrollTranscriptToTop() {
    setTranscriptOffset(renderModel.transcript.maxOffset);
  }

  function scrollTranscriptToBottom() {
    setTranscriptOffset(0);
  }

  async function submitInput(input: string) {
    const command = parseWorkbenchCommand(input);
    if (command?.kind === "copy") {
      await copyPanelText(command.target);
      return;
    }
    await agentEngine.submit(input);
  }

  async function copyPanelText(target: "activity" | "page" | "transcript") {
    const text = copyTextFromRenderModel(renderModel, target);
    if (!text) {
      dispatch({ type: "activity.add", level: "warning", text: `Nothing to copy: ${target}` });
      return;
    }
    try {
      const copied = await writeClipboard(text, stdout);
      dispatch({
        type: "activity.add",
        level: copied ? "success" : "warning",
        text: copied ? `Copied ${target} to clipboard` : `Clipboard unavailable for ${target}`,
      });
    } catch (error) {
      dispatch({ type: "activity.add", level: "error", text: `Copy failed: ${userFacingError(error)}` });
    }
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
    const result = inputController.handle(input, key, {
      busy: state.busy,
      cursor,
      draft,
      selectionAnchor,
      viewportColumns: renderModel.input.viewportColumns,
      viewportHeight: renderModel.transcript.viewportHeight,
    });
    if (result.draft !== draft) setDraft(result.draft);
    if (result.cursor !== cursor) setCursor(result.cursor);
    if (result.selectionAnchor !== selectionAnchor) setSelectionAnchor(result.selectionAnchor);
    for (const effect of result.effects) {
      switch (effect.type) {
        case "exit":
          app.exit();
          break;
        case "scroll":
          scrollTranscript(effect.delta);
          break;
        case "scroll_top":
          scrollTranscriptToTop();
          break;
        case "scroll_bottom":
          scrollTranscriptToBottom();
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

  return <InkWorkbenchScreen renderModel={renderModel} spinnerFrame={spinnerFrame} />;
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
