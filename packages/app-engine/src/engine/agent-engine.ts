import type { AgentRunOptions } from "../agent.js";
import type { WorkbenchAuthController } from "../workbench/auth-controller.js";
import {
  createWorkbenchCommandController,
  type WorkbenchCommandController,
} from "../workbench/command-controller.js";
import {
  createWorkbenchSession,
  type WorkbenchSession,
} from "../workbench/session.js";
import type { WorkbenchLifecycleEffect } from "../workbench/lifecycle-controller.js";
import type { WorkbenchAction, WorkbenchState } from "../workbench/state.js";
import type { AgentEngineServices } from "./services.js";

export interface AgentEngineApp {
  session: WorkbenchSession;
  commands: WorkbenchCommandController;
  snapshot(): WorkbenchState;
  subscribe(listener: () => void): () => void;
  dispatch(action: WorkbenchAction): void;
  maybeCheckForUpdate(options?: AgentEngineLifecycleOptions): Promise<void>;
  loadInitialConversation(options?: AgentEngineLifecycleOptions): Promise<void>;
  loadInitialSettings(options?: AgentEngineLifecycleOptions): Promise<void>;
  loadWorkdir(path?: string, options?: AgentEngineLifecycleOptions): Promise<void>;
  refreshAuth(profile?: string, options?: AgentEngineLifecycleOptions): Promise<void>;
  abortActiveTurn(message?: string): Promise<void>;
  startInitialPrompt(): Promise<void>;
  submit(input: string): Promise<void>;
  runLifecycleEffects(effects: WorkbenchLifecycleEffect[], options?: AgentEngineLifecycleOptions): void;
  dispose(): void;
}

export interface AgentEngineAppOptions {
  authController: WorkbenchAuthController;
  baseOptions: AgentRunOptions;
  profileName: string;
  services?: Omit<AgentEngineServices, "auth">;
  onDeleteProfile(): Promise<void>;
  onExit(): void;
  onLogin(): void;
  onLogout(): void;
  onSwitchProfile(name?: string): void;
}

export interface AgentEngineLifecycleOptions {
  isMounted?: () => boolean;
}

export function createAgentEngine(options: AgentEngineAppOptions): AgentEngineApp {
  const session = createWorkbenchSession({
    authController: options.authController,
    baseOptions: options.baseOptions,
    services: options.services,
  });
  const commands = createWorkbenchCommandController({
    authController: options.authController,
    conversationController: session.conversation,
    engine: session.engine,
    localController: session.local,
    options: options.baseOptions,
    profileName: options.profileName,
    settingsController: session.settings,
    turnController: session.turn,
    onDeleteProfile: options.onDeleteProfile,
    onExit: options.onExit,
    onLogin: options.onLogin,
    onLogout: options.onLogout,
    onSwitchProfile: options.onSwitchProfile,
  });

  async function submit(input: string) {
    const submission = session.engine.submit(input);
    if (submission.kind === "command") {
      await commands.run(submission.command);
      return;
    }
    if (submission.kind === "prompt") {
      await session.turn.startPrompt(submission.prompt);
    }
  }

  async function maybeCheckForUpdate(lifecycleOptions?: AgentEngineLifecycleOptions) {
    const effects = await session.lifecycle.maybeCheckForUpdate();
    runLifecycleEffects(effects, lifecycleOptions);
  }

  async function loadInitialConversation(lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    try {
      const state = session.engine.snapshot();
      const conversation = await session.conversation.resolveConversation(state.currentConversation, options.baseOptions.profile);
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "conversation.set",
        id: conversation.id,
        name: conversation.name,
        previousResponseId: conversation.previousResponseId,
        status: conversation.status,
      });
      if (conversation.previousResponseId) {
        session.engine.dispatch({
          type: "message.add",
          role: "system",
          text: `Continuing conversation "${conversation.name}" from ${conversation.previousResponseId}. Use /new to start without prior context.`,
        });
      }
    } catch (error) {
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Conversation state unavailable: ${userFacingError(error)}`,
      });
    }
  }

  async function loadInitialSettings(lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    try {
      const settings = await session.settings.loadInitial({
        modelExplicit: options.baseOptions.modelExplicit,
        preset: options.baseOptions.preset,
        presetExplicit: options.baseOptions.presetExplicit,
      });
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({ type: "settings.set", settings });
      if (settings.activity) {
        session.engine.dispatch({ type: "activity.add", level: "success", text: settings.activity });
      }
      if (settings.notice) {
        session.engine.dispatch({ type: "message.add", role: "system", text: settings.notice });
        session.engine.dispatch({ type: "activity.add", level: "warning", text: "Shell isolation setup is not configured" });
      }
      if (settings.warning) {
        session.engine.dispatch({ type: "activity.add", level: "warning", text: settings.warning });
      }
    } catch (error) {
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Config preferences unavailable: ${userFacingError(error)}`,
      });
    }
  }

  async function loadWorkdir(path?: string, lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    session.engine.dispatch({ type: "activity.add", text: "Loading workdir" });
    try {
      const workdir = await session.local.load(path);
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "workdir.set",
        workdir,
      });
    } catch (error) {
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "activity.add",
        level: "error",
        text: `Workdir unavailable: ${userFacingError(error)}`,
      });
    }
  }

  async function refreshAuth(profile?: string, lifecycleOptions?: AgentEngineLifecycleOptions) {
    const effects = await session.lifecycle.refreshAuth(profile);
    runLifecycleEffects(effects, lifecycleOptions);
  }

  async function abortActiveTurn(message = "Abort requested.") {
    await session.turn.abort(message);
  }

  async function startInitialPrompt() {
    const state = session.engine.snapshot();
    const initialPrompt = session.lifecycle.initialPrompt({
      busy: state.busy,
      promptParts: options.baseOptions.promptParts,
      requiresWorkdir: state.contextEnabled,
      workdir: state.workdir,
    });
    if (initialPrompt) await session.turn.startPrompt(initialPrompt);
  }

  function runLifecycleEffects(effects: WorkbenchLifecycleEffect[], lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    for (const effect of effects) {
      switch (effect.type) {
        case "dispatch":
          session.engine.dispatch(effect.action);
          break;
        case "close":
          setTimeout(() => {
            if (lifecycleOptions.isMounted?.() ?? true) options.onExit();
          }, effect.delayMs);
          break;
      }
    }
  }

  return {
    session,
    commands,
    snapshot: session.engine.snapshot,
    subscribe: session.engine.subscribe,
    dispatch: session.engine.dispatch,
    maybeCheckForUpdate,
    loadInitialConversation,
    loadInitialSettings,
    loadWorkdir,
    refreshAuth,
    abortActiveTurn,
    startInitialPrompt,
    submit,
    runLifecycleEffects,
    dispose() {
      session.runtime.dispose();
    },
  };
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
