import type { WorkbenchAuthController } from "../workbench/auth-controller.js";
import type { WorkbenchConversationController } from "../workbench/conversation-controller.js";
import type { WorkbenchEngine } from "../workbench/engine.js";
import type { WorkbenchLifecycleController } from "../workbench/lifecycle-controller.js";
import type { WorkbenchLocalController } from "../workbench/local-controller.js";
import type { WorkbenchRuntimeController } from "../workbench/runtime-controller.js";
import type { WorkbenchSettingsController } from "../workbench/settings-controller.js";
import type { WorkbenchTranscriptStore } from "../workbench/transcript-store.js";
import type { WorkbenchTurnController } from "../workbench/turn-controller.js";

export interface AgentEngineServices {
  auth?: WorkbenchAuthController;
  conversation?: WorkbenchConversationController;
  engine?: WorkbenchEngine;
  lifecycle?: WorkbenchLifecycleController;
  local?: WorkbenchLocalController;
  runtime?: WorkbenchRuntimeController;
  settings?: WorkbenchSettingsController;
  transcriptStore?: WorkbenchTranscriptStore;
  turn?: WorkbenchTurnController;
}
