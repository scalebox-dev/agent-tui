import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useInput, useStdout } from "ink";
import { defaultBaseURL } from "../config.js";
import { type AgentRunOptions } from "../agent.js";
import { createWorkbenchAuthController, type WorkbenchAuthController } from "../workbench/auth-controller.js";
import {
  createWorkbenchAuthGateController,
  type AuthGateState,
  type WorkbenchAuthGateController,
} from "../workbench/auth-gate-controller.js";
import {
  type WorkbenchLifecycleEffect,
} from "../workbench/lifecycle-controller.js";
import { createWorkbenchCommandController } from "../workbench/command-controller.js";
import {
  buildWorkbenchRenderModel,
} from "../workbench/render-model.js";
import { createWorkbenchSession, type WorkbenchSession } from "../workbench/session.js";
import { InkAuthGate, InkWorkbenchScreen } from "./ink/components.js";

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

  return <InkAuthGate state={auth} />;
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
  const [draft, setDraft] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const sessionRef = useRef<WorkbenchSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = createWorkbenchSession({
      authController,
      baseOptions: options,
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
  const renderModel = useMemo(
    () => buildWorkbenchRenderModel({
      draft,
      profileName,
      spinnerFrame,
      state,
      transcriptOffset,
      viewport: {
        rows: stdout.rows || process.stdout.rows,
        columns: stdout.columns || process.stdout.columns,
      },
      workdirFallback: options.workdir || process.cwd(),
    }),
    [draft, options.workdir, profileName, spinnerFrame, state, stdout.columns, stdout.rows, transcriptOffset],
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
      viewportHeight: renderModel.viewportHeight,
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
    return () => session.runtime.dispose();
  }, [session.runtime]);

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

  return <InkWorkbenchScreen renderModel={renderModel} spinnerFrame={spinnerFrame} />;
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
