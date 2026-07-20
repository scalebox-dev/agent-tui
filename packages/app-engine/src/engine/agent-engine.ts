import type { AgentRunOptions } from "../agent.js";
import type { WorkbenchAuthController } from "../workbench/auth-controller.js";
import {
  createWorkbenchCommandController,
  type WorkbenchCommandController,
} from "../workbench/command-controller.js";
import type { ConversationSelection } from "../workbench/conversation-controller.js";
import {
  createWorkbenchSession,
  type WorkbenchSession,
} from "../workbench/session.js";
import type { WorkbenchLifecycleEffect } from "../workbench/lifecycle-controller.js";
import type { WorkbenchAction, WorkbenchConversationSummary, WorkbenchState } from "../workbench/state.js";
import type { WorkbenchTranscriptStore } from "../workbench/transcript-store.js";
import type { AgentEngineServices } from "./services.js";

export interface AgentEngineApp {
  session: WorkbenchSession;
  commands: WorkbenchCommandController;
  snapshot(): WorkbenchState;
  subscribe(listener: () => void): () => void;
  dispatch(action: WorkbenchAction): void;
  maybeCheckForUpdate(options?: AgentEngineLifecycleOptions): Promise<void>;
  loadWorkspaceContext(options?: AgentEngineLifecycleOptions): Promise<void>;
  loadInitialConversation(options?: AgentEngineLifecycleOptions): Promise<void>;
  refreshConversationSummaries(options?: AgentEngineLifecycleOptions): Promise<void>;
  loadOlderTranscript(limit?: number): Promise<number>;
  loadNewerTranscript(limit?: number): Promise<number>;
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
  let disposed = false;
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
    transcriptStore: options.services?.transcriptStore,
    turnController: session.turn,
    workspaceController: session.workspace,
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
      await refreshConversationSummaries();
      return;
    }
    if (submission.kind === "prompt") {
      await session.turn.startPrompt(submission.prompt);
      await refreshConversationSummaries();
    }
  }

  async function maybeCheckForUpdate(lifecycleOptions?: AgentEngineLifecycleOptions) {
    const effects = await session.lifecycle.maybeCheckForUpdate();
    runLifecycleEffects(effects, lifecycleOptions);
  }

  async function loadInitialConversation(lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    try {
      const state = session.engine.snapshot();
      if (!state.currentWorkspaceId) {
        session.engine.dispatch({ type: "activity.add", level: "warning", text: "Conversation load is waiting for workspace context" });
        return;
      }
      const initialConversationName = await resolveInitialConversationName(state);
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      const conversation = await session.conversation.resolveConversation(
        initialConversationName,
        options.baseOptions.profile,
        state.currentWorkspaceId,
        state.currentWorkspaceName,
      );
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "conversation.set",
        id: conversation.id,
        name: conversation.name,
        previousResponseId: conversation.previousResponseId,
        runSettings: initialConversationRunSettings(conversation),
        status: conversation.status,
      });
      if (options.services?.transcriptStore) {
        const messages = await options.services.transcriptStore.loadRecentMessages(conversation.id, 80);
        if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
        if (messages.length > 0) {
          session.engine.dispatch({ type: "messages.restore", messages });
          session.engine.dispatch({ type: "activity.add", level: "success", text: `Loaded ${messages.length} local transcript message${messages.length === 1 ? "" : "s"}` });
        }
      }
      if (conversation.previousResponseId) {
        session.engine.dispatch({
          type: "message.add",
          role: "system",
          text: `Continuing conversation "${conversation.name}" from ${conversation.previousResponseId}. Use /new to start without prior context.`,
        });
      }
      await refreshConversationSummaries(lifecycleOptions);
    } catch (error) {
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Conversation state unavailable: ${userFacingError(error)}`,
      });
    }
  }

  async function refreshConversationSummaries(lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    try {
      const conversations = await session.conversation.listConversationSelections(
        options.baseOptions.profile,
        session.engine.snapshot().currentWorkspaceId,
      );
      const summaries = await buildConversationSummaries(conversations, options.services?.transcriptStore);
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({ type: "conversations.set", conversations: summaries });
    } catch (error) {
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Conversation list unavailable: ${userFacingError(error)}`,
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
      const state = session.engine.snapshot();
      session.engine.dispatch({
        type: "settings.set",
        settings: {
          ...settings,
          defaultAutomaticContinuationLimit: settings.defaultAutomaticContinuationLimit ?? settings.automaticContinuationLimit,
          ...(state.runPreset ? { runPreset: state.runPreset } : {}),
          ...(state.automaticContinuationLimit !== undefined ? { automaticContinuationLimit: state.automaticContinuationLimit } : {}),
          ...(state.conversationId ? { localKnowledgeEnabled: state.localKnowledgeEnabled } : {}),
        },
      });
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

  async function loadWorkspaceContext(lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    try {
      const snapshot = await session.workspace.load(options.baseOptions.profile);
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "workspace.set",
        workspace: {
          authType: snapshot.authType,
          id: snapshot.current.id,
          name: snapshot.current.name,
          role: snapshot.current.role,
          switchable: snapshot.switchable,
        },
      });
      session.engine.dispatch({ type: "workspaces.set", workspaces: snapshot.workspaces });
      session.engine.dispatch({
        type: "activity.add",
        level: "success",
        text: `Workspace: ${snapshot.current.name}`,
      });
    } catch (error) {
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Workspace context unavailable: ${userFacingError(error)}`,
      });
    }
  }

  async function loadOlderTranscript(limit = 80): Promise<number> {
    const store = options.services?.transcriptStore;
    const state = session.engine.snapshot();
    const firstSeq = firstStoredTranscriptSeq(state.messages);
    if (!store || !state.conversationId || firstSeq == null) return 0;
    try {
      const messages = await store.loadBeforeMessages(state.conversationId, firstSeq, limit);
      if (messages.length > 0) {
        session.engine.dispatch({ type: "messages.prepend", messages });
        session.engine.dispatch({ type: "activity.add", level: "success", text: `Loaded ${messages.length} older transcript message${messages.length === 1 ? "" : "s"}` });
      } else {
        session.engine.dispatch({ type: "activity.add", text: "Reached start of local transcript history" });
      }
      return messages.length;
    } catch (error) {
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Transcript history unavailable: ${userFacingError(error)}`,
      });
      return 0;
    }
  }

  async function loadNewerTranscript(limit = 80): Promise<number> {
    const store = options.services?.transcriptStore;
    const state = session.engine.snapshot();
    const lastSeq = lastStoredTranscriptSeq(state.messages);
    if (!store || !state.conversationId || lastSeq == null) return 0;
    try {
      const messages = await store.loadAfterMessages(state.conversationId, lastSeq, limit);
      if (messages.length > 0) {
        session.engine.dispatch({ type: "messages.appendPage", messages });
        session.engine.dispatch({ type: "activity.add", level: "success", text: `Loaded ${messages.length} newer transcript message${messages.length === 1 ? "" : "s"}` });
      } else {
        session.engine.dispatch({ type: "activity.add", text: "Reached latest local transcript history" });
      }
      return messages.length;
    } catch (error) {
      session.engine.dispatch({
        type: "activity.add",
        level: "warning",
        text: `Transcript history unavailable: ${userFacingError(error)}`,
      });
      return 0;
    }
  }

  async function loadWorkdir(path?: string, lifecycleOptions: AgentEngineLifecycleOptions = {}) {
    if (disposed) return;
    session.engine.dispatch({ type: "activity.add", text: "Loading workdir" });
    try {
      const workdir = await session.local.load(path);
      if (disposed) return;
      if (lifecycleOptions.isMounted && !lifecycleOptions.isMounted()) return;
      session.engine.dispatch({
        type: "workdir.set",
        workdir,
      });
      if (workdir.scanWarnings?.length) {
        session.engine.dispatch({
          type: "activity.add",
          level: "warning",
          text: formatWorkdirScanWarning(workdir.scanWarnings),
        });
      }
    } catch (error) {
      if (disposed || isCanceledWorkdirLoad(error)) return;
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
    if (!state.currentWorkspaceId) return;
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

  async function resolveInitialConversationName(state: WorkbenchState) {
    if (options.baseOptions.conversationExplicit !== false) return state.currentConversation;
    const conversations = await session.conversation.listConversationSelections(
      options.baseOptions.profile,
      state.currentWorkspaceId,
    );
    return conversations[0]?.name || state.currentConversation;
  }

  function initialConversationRunSettings(conversation: ConversationSelection) {
    if (!conversation.runSettings) return undefined;
    const runSettings = { ...conversation.runSettings };
    if (options.baseOptions.modelExplicit) {
      delete runSettings.model;
      delete runSettings.preset;
    } else if (options.baseOptions.presetExplicit) {
      delete runSettings.preset;
    }
    return runSettings;
  }

  return {
    session,
    commands,
    snapshot: session.engine.snapshot,
    subscribe: session.engine.subscribe,
    dispatch: session.engine.dispatch,
    maybeCheckForUpdate,
    loadWorkspaceContext,
    loadInitialConversation,
    refreshConversationSummaries,
    loadOlderTranscript,
    loadNewerTranscript,
    loadInitialSettings,
    loadWorkdir,
    refreshAuth,
    abortActiveTurn,
    startInitialPrompt,
    submit,
    runLifecycleEffects,
    dispose() {
      disposed = true;
      session.local.dispose();
      session.runtime.dispose();
      options.services?.localKnowledge?.dispose?.();
      options.services?.transcriptStore?.dispose?.();
    },
  };
}

function isCanceledWorkdirLoad(error: unknown): boolean {
  return error instanceof Error && /workdir load canceled/i.test(error.message);
}

function formatWorkdirScanWarning(warnings: NonNullable<WorkbenchState["workdir"]>["scanWarnings"]): string {
  const first = warnings?.[0];
  const suffix = first ? `: ${first.path}${first.code ? ` (${first.code})` : ""}` : "";
  const extra = warnings && warnings.length > 1 ? ` and ${warnings.length - 1} more` : "";
  return `Workdir scan skipped ${warnings?.length ?? 0} entr${warnings?.length === 1 ? "y" : "ies"}${suffix}${extra}`;
}

function firstStoredTranscriptSeq(messages: WorkbenchState["messages"]) {
  for (const message of messages) {
    if (typeof message.transcriptSeq === "number") return message.transcriptSeq;
  }
  return null;
}

function lastStoredTranscriptSeq(messages: WorkbenchState["messages"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message.transcriptSeq === "number") return message.transcriptSeq;
  }
  return null;
}

async function buildConversationSummaries(
  conversations: readonly ConversationSelection[],
  transcriptStore?: WorkbenchTranscriptStore,
): Promise<WorkbenchConversationSummary[]> {
  return Promise.all(conversations.map(async (conversation) => {
    const transcript = transcriptStore
      ? await transcriptStore.getConversationSummary(conversation.id)
      : { latestSnippet: "", messageCount: 0, titleSnippet: "" };
    return {
      id: conversation.id,
      latestSnippet: transcript.latestSnippet,
      messageCount: transcript.messageCount,
      name: conversation.name,
      previousResponseId: conversation.previousResponseId,
      status: conversation.status,
      titleSnippet: transcript.titleSnippet,
      updatedAt: transcript.updatedAt ?? conversation.updatedAt,
    };
  }));
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
