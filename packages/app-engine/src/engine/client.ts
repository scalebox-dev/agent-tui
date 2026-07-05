import type { WorkbenchLifecycleEffect } from "../workbench/lifecycle-controller.js";
import type { WorkbenchAction, WorkbenchState } from "../workbench/state.js";
import {
  createAgentEngine,
  type AgentEngineApp,
  type AgentEngineAppOptions,
  type AgentEngineLifecycleOptions,
} from "./agent-engine.js";

export interface AgentEngineClient {
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

export function agentEngineClientFromApp(app: AgentEngineApp): AgentEngineClient {
  return {
    snapshot: app.snapshot,
    subscribe: app.subscribe,
    dispatch: app.dispatch,
    maybeCheckForUpdate: app.maybeCheckForUpdate,
    loadWorkspaceContext: app.loadWorkspaceContext,
    loadInitialConversation: app.loadInitialConversation,
    refreshConversationSummaries: app.refreshConversationSummaries,
    loadOlderTranscript: app.loadOlderTranscript,
    loadNewerTranscript: app.loadNewerTranscript,
    loadInitialSettings: app.loadInitialSettings,
    loadWorkdir: app.loadWorkdir,
    refreshAuth: app.refreshAuth,
    abortActiveTurn: app.abortActiveTurn,
    startInitialPrompt: app.startInitialPrompt,
    submit: app.submit,
    runLifecycleEffects: app.runLifecycleEffects,
    dispose: app.dispose,
  };
}

export function createInProcessAgentEngineClient(options: AgentEngineAppOptions): AgentEngineClient {
  return agentEngineClientFromApp(createAgentEngine(options));
}
