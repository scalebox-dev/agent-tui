import type { AgentRunOptions } from "../agent.js";
import type { WorkbenchState } from "../tui/workbench.js";
import type { WorkbenchAuthController } from "./auth-controller.js";
import { createWorkbenchConversationController, type WorkbenchConversationController } from "./conversation-controller.js";
import { createWorkbenchEngine, type WorkbenchEngine } from "./engine.js";
import { createWorkbenchInputController, type WorkbenchInputController } from "./input-controller.js";
import { createWorkbenchLifecycleController, type WorkbenchLifecycleController } from "./lifecycle-controller.js";
import { createWorkbenchLocalController, type WorkbenchLocalController } from "./local-controller.js";
import { createWorkbenchRuntimeController, type WorkbenchRuntimeController } from "./runtime-controller.js";
import { createWorkbenchSettingsController, type WorkbenchSettingsController } from "./settings-controller.js";
import { createWorkbenchTurnController, type WorkbenchTurnController } from "./turn-controller.js";

export interface WorkbenchSession {
  conversation: WorkbenchConversationController;
  engine: WorkbenchEngine;
  input: WorkbenchInputController;
  lifecycle: WorkbenchLifecycleController;
  local: WorkbenchLocalController;
  runtime: WorkbenchRuntimeController;
  settings: WorkbenchSettingsController;
  turn: WorkbenchTurnController;
}

export interface WorkbenchSessionOptions {
  authController: WorkbenchAuthController;
  baseOptions: AgentRunOptions;
}

export function createWorkbenchSession(options: WorkbenchSessionOptions): WorkbenchSession {
  const engine = createWorkbenchEngine({
    accessMode: options.baseOptions.accessMode,
    conversation: options.baseOptions.conversation,
    contextEnabled: Boolean(options.baseOptions.includeLocalContext || options.baseOptions.workdir),
    model: options.baseOptions.model,
    preset: options.baseOptions.preset,
  });
  const local = createWorkbenchLocalController({
    getShellIsolation: () => engine.snapshot().shellIsolation,
  });
  const runtime = createWorkbenchRuntimeController({ dispatch: engine.dispatch });
  const turn = createWorkbenchTurnController({
    baseOptions: options.baseOptions,
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer: runtime.flushTextDeltaBuffer,
    getState: engine.snapshot,
    runRuntimeEffects: runtime.runEffects,
  });

  return {
    conversation: createWorkbenchConversationController(),
    engine,
    input: createWorkbenchInputController(),
    lifecycle: createWorkbenchLifecycleController({ authController: options.authController }),
    local,
    runtime,
    settings: createWorkbenchSettingsController(),
    turn,
  };
}

export function sessionState(session: Pick<WorkbenchSession, "engine">): WorkbenchState {
  return session.engine.snapshot();
}
