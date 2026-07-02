export type { WorkbenchInputController } from "./terminal/input-controller.js";
export { createWorkbenchInputController } from "./terminal/input-controller.js";
export type { WorkbenchCopyTarget } from "./terminal/copy.js";
export { copyTextFromRenderModel } from "./terminal/copy.js";
export type { WorkbenchRenderModel } from "./terminal/render-model.js";
export {
  buildWorkbenchRenderModel,
  busySpinner,
  pendingLocalLabel,
} from "./terminal/render-model.js";
export type {
  TranscriptLine,
  TranscriptSpan,
  TranscriptViewModel,
} from "./terminal/view-model.js";
export {
  activityColor,
  buildTranscriptLines,
  buildTranscriptViewModel,
  elapsedDots,
  spinnerGlyph,
} from "./terminal/view-model.js";
