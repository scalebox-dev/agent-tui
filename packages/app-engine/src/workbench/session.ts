import type { AgentRunOptions } from "../agent.js";
import type { AgentEngineServices } from "../engine/services.js";
import type { WorkbenchState } from "./state.js";
import type { WorkbenchAuthController } from "./auth-controller.js";
import { createWorkbenchConversationController, type WorkbenchConversationController } from "./conversation-controller.js";
import { createWorkbenchEngine, type WorkbenchEngine } from "./engine.js";
import { createWorkbenchLifecycleController, type WorkbenchLifecycleController } from "./lifecycle-controller.js";
import { createWorkbenchLocalController, type WorkbenchLocalController } from "./local-controller.js";
import { createWorkbenchRuntimeController, type WorkbenchRuntimeController } from "./runtime-controller.js";
import { createWorkbenchSettingsController, type WorkbenchSettingsController } from "./settings-controller.js";
import { createWorkbenchTurnController, type WorkbenchTurnController } from "./turn-controller.js";
import { createWorkbenchWorkspaceController, type WorkbenchWorkspaceController } from "./workspace-controller.js";

export interface WorkbenchSession {
  conversation: WorkbenchConversationController;
  engine: WorkbenchEngine;
  lifecycle: WorkbenchLifecycleController;
  local: WorkbenchLocalController;
  runtime: WorkbenchRuntimeController;
  settings: WorkbenchSettingsController;
  turn: WorkbenchTurnController;
  workspace: WorkbenchWorkspaceController;
}

export interface WorkbenchSessionOptions {
  authController: WorkbenchAuthController;
  baseOptions: AgentRunOptions;
  services?: Omit<AgentEngineServices, "auth">;
}

export function createWorkbenchSession(options: WorkbenchSessionOptions): WorkbenchSession {
  const engine = options.services?.engine ?? createWorkbenchEngine({
    accessMode: options.baseOptions.accessMode,
    conversation: options.baseOptions.conversation,
    contextEnabled: Boolean(options.baseOptions.includeLocalContext || options.baseOptions.workdir),
    localSkillsEnabled: options.baseOptions.discoverLocalSkills,
    memoryRead: Boolean(options.baseOptions.memory?.read || options.baseOptions.memory?.enabled || options.baseOptions.memory?.tenant_search),
    memoryTenantSearch: Boolean(options.baseOptions.memory?.tenant_search),
    memoryWrite: Boolean(options.baseOptions.memory?.write),
    model: options.baseOptions.model,
    preset: options.baseOptions.preset,
    transcriptStore: options.services?.transcriptStore,
    workspaceSkillsEnabled: Boolean(options.baseOptions.skillTool?.tenant_search),
  });
  const local = options.services?.local ?? createWorkbenchLocalController({
    getShellIsolation: () => engine.snapshot().shellIsolation,
  });
  const runtime = options.services?.runtime ?? createWorkbenchRuntimeController({ dispatch: engine.dispatch });
  const workspace = options.services?.workspace ?? createWorkbenchWorkspaceController();
  const turn = options.services?.turn ?? createWorkbenchTurnController({
    baseOptions: options.baseOptions,
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer: runtime.flushTextDeltaBuffer,
    getState: engine.snapshot,
    runRuntimeEffects: runtime.runEffects,
  });

  return {
    conversation: options.services?.conversation ?? createWorkbenchConversationController(),
    engine,
    lifecycle: options.services?.lifecycle ?? createWorkbenchLifecycleController({ authController: options.authController }),
    local,
    runtime,
    settings: options.services?.settings ?? createWorkbenchSettingsController(),
    turn,
    workspace,
  };
}

export function sessionState(session: Pick<WorkbenchSession, "engine">): WorkbenchState {
  return session.engine.snapshot();
}
