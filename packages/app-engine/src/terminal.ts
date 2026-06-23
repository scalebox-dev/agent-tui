export type { WorkbenchInputController } from "./workbench/input-controller.js";
export { createWorkbenchInputController } from "./workbench/input-controller.js";
export type { WorkbenchRenderModel } from "./workbench/render-model.js";
export {
  buildWorkbenchRenderModel,
  busySpinner,
  pendingLocalLabel,
} from "./workbench/render-model.js";
export {
  buildTranscriptLines,
  buildTranscriptViewModel,
  elapsedDots,
  spinnerGlyph,
} from "./workbench/view-model.js";
export { activityColor } from "./workbench/state.js";
