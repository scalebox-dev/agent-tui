import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { defaultBaseURL } from "../config.js";
import { type AgentRunOptions } from "../agent.js";
import {
  activityColor,
  type RenderMode,
  type WorkbenchState,
} from "./workbench.js";
import { type WorkbenchRuntimeEffect } from "../workbench/engine.js";
import { createWorkbenchAuthController, type WorkbenchAuthController } from "../workbench/auth-controller.js";
import {
  authMethods,
  createWorkbenchAuthGateController,
  type AuthGateState,
  type WorkbenchAuthGateController,
} from "../workbench/auth-gate-controller.js";
import {
  type WorkbenchLifecycleEffect,
} from "../workbench/lifecycle-controller.js";
import { createWorkbenchCommandController } from "../workbench/command-controller.js";
import { createWorkbenchSession, type WorkbenchSession } from "../workbench/session.js";
import {
  buildTranscriptViewModel,
  elapsedDots,
  spinnerGlyph,
} from "../workbench/view-model.js";

export function ChatApp({ options }: { options: AgentRunOptions }) {
  return <AuthenticatedChatApp options={options} />;
}

function AuthenticatedChatApp({ options }: { options: AgentRunOptions }) {
  const app = useApp();
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
  const [auth, setAuth] = useState<AuthGateState>(() => authGateController.initialState({
    apiKey: process.env.AGENT_API_KEY || "",
    baseURL: process.env.AGENT_API_BASE_URL || defaultBaseURL,
    profile: options.profile || "default",
  }));

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

  return <AuthGate state={auth} />;
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
  const textDeltaBufferRef = useRef<{ id: string; text: string } | null>(null);
  const textDeltaFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draft, setDraft] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const sessionRef = useRef<WorkbenchSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = createWorkbenchSession({
      authController,
      baseOptions: options,
      flushTextDeltaBuffer,
      runRuntimeEffects,
    });
  }
  const session = sessionRef.current;
  const engine = session.engine;
  const conversationController = session.conversation;
  const inputController = session.input;
  const lifecycleController = session.lifecycle;
  const localController = session.local;
  const settingsController = session.settings;
  const turnController = session.turn;
  const state = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const dispatch = engine.dispatch;
  const commandController = createWorkbenchCommandController({
    authController,
    conversationController,
    engine,
    localController,
    options,
    profileName,
    settingsController,
    turnController,
    onDeleteProfile,
    onExit: app.exit,
    onLogin,
    onLogout,
    onSwitchProfile,
  });
  const terminalRows = Math.max(18, stdout.rows || process.stdout.rows || 32);
  const terminalColumns = Math.max(80, stdout.columns || process.stdout.columns || 100);
  const viewportHeight = Math.max(6, terminalRows - 9);
  const transcriptWidth = Math.max(36, Math.floor(terminalColumns * 0.72) - 4);
  const transcript = useMemo(
    () =>
      buildTranscriptViewModel({
        activeAssistantMessageId: state.activeAssistantMessageId,
        busy: state.busy,
        messages: state.messages,
        offset: transcriptOffset,
        renderMode: state.renderMode,
        spinnerFrame,
        viewportHeight,
        width: transcriptWidth,
      }),
    [state.activeAssistantMessageId, state.busy, state.messages, state.renderMode, spinnerFrame, transcriptOffset, transcriptWidth, viewportHeight],
  );

  useEffect(() => {
    setTranscriptOffset((offset) => Math.min(offset, transcript.maxOffset));
  }, [transcript.maxOffset]);

  function scrollTranscript(delta: number) {
    setTranscriptOffset((offset) => Math.max(0, Math.min(transcript.maxOffset, offset + delta)));
  }

  function scrollTranscriptToTop() {
    setTranscriptOffset(transcript.maxOffset);
  }

  function scrollTranscriptToBottom() {
    setTranscriptOffset(0);
  }

  useEffect(() => {
    let mounted = true;
    lifecycleController.maybeCheckForUpdate()
      .then((effects) => {
        if (mounted) runLifecycleEffects(effects, () => mounted);
      });
    settingsController.loadInitial({
      modelExplicit: options.modelExplicit,
      preset: options.preset,
      presetExplicit: options.presetExplicit,
    })
      .then((settings) => {
        if (!mounted) return;
        dispatch({ type: "settings.set", settings });
      })
      .catch((error) => {
        if (!mounted) return;
        dispatch({ type: "activity.add", level: "warning", text: `Config preferences unavailable: ${userFacingError(error)}` });
      });
    return () => {
      mounted = false;
    };
  }, [dispatch, lifecycleController, options.modelExplicit, options.preset, options.presetExplicit, settingsController]);

  useEffect(() => {
    let mounted = true;
    dispatch({ type: "activity.add", text: "Loading workdir" });
    localController.load(options.workdir || process.cwd())
      .then((workdir) => {
        if (!mounted) return;
        dispatch({
          type: "workdir.set",
          workdir,
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
  }, [dispatch, localController, options.workdir]);

  useEffect(() => {
    let mounted = true;
    const refreshIntervalMs = 60_000;
    const refreshAuth = async () => {
      const effects = await lifecycleController.refreshAuth(options.profile);
      if (mounted) runLifecycleEffects(effects, () => mounted);
    };
    void refreshAuth();
    const interval = setInterval(refreshAuth, refreshIntervalMs);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [lifecycleController, options.profile]);

  useInput((input, key) => {
    const result = inputController.handle(input, key, {
      busy: state.busy,
      draft,
      viewportHeight,
    });
    if (result.draft !== draft) setDraft(result.draft);
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
          void turnController.abort("Abort requested.");
          break;
        case "submit":
          void submit(effect.input);
          break;
        case "ignored_busy":
          dispatch({ type: "message.add", role: "system", text: "Agent turn is running. Use /abort or Esc to cancel it." });
          dispatch({ type: "activity.add", level: "warning", text: "Input ignored while agent is running" });
          break;
      }
    }
  });

  useEffect(() => {
    const initialPrompt = lifecycleController.initialPrompt({
      busy: state.busy,
      promptParts: options.promptParts,
      workdir: state.workdir,
    });
    if (initialPrompt) void turnController.startPrompt(initialPrompt);
  }, [lifecycleController, options.promptParts, state.busy, state.workdir, turnController]);

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

  function runLifecycleEffects(effects: WorkbenchLifecycleEffect[], isMounted: () => boolean) {
    for (const effect of effects) {
      switch (effect.type) {
        case "dispatch":
          dispatch(effect.action);
          break;
        case "close":
          setTimeout(() => {
            if (isMounted()) app.exit();
          }, effect.delayMs);
          break;
      }
    }
  }

  async function submit(input: string) {
    const submission = engine.submit(input);
    if (submission.kind === "command") {
      await commandController.run(submission.command);
      return;
    }
    if (submission.kind === "prompt") {
      await turnController.startPrompt(submission.prompt);
    }
  }

  function runRuntimeEffects(effects: WorkbenchRuntimeEffect[], assistantId: string) {
    for (const effect of effects) {
      switch (effect.type) {
        case "append_text_delta":
          appendTextDeltaBuffered(assistantId, effect.delta);
          break;
        case "set_active_response_id":
          break;
        case "flush_text_delta_buffer":
          flushTextDeltaBuffer();
          break;
      }
    }
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
          {transcript.visibleLines.map((line) => (
            <Text bold={line.bold} color={line.color} inverse={line.inverse} key={line.id}>
              {line.text || " "}
            </Text>
          ))}
          {transcript.visibleLines.length === 0 && <Text color="gray">No transcript lines.</Text>}
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
          {transcript.offset > 0 ? ` · ${transcript.offset} rows from latest` : " · live"}
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

function Cursor({ visible }: { visible: boolean }) {
  return visible ? <Text inverse> </Text> : <Text> </Text>;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pendingLocalLabel(state: WorkbenchState) {
  if (state.pendingLocalTool) {
    return `${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`;
  }
  return "none";
}
