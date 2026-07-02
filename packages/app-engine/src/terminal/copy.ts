import type { WorkbenchCopyTarget } from "../workbench/state.js";
import type { WorkbenchRenderModel } from "./render-model.js";
import type { TranscriptLine } from "./view-model.js";

export type { WorkbenchCopyTarget };

export function copyTextFromRenderModel(renderModel: WorkbenchRenderModel, target: WorkbenchCopyTarget): string {
  switch (target) {
    case "activity":
      return copyTextFromActivities(renderModel.visibleActivities);
    case "transcript":
      return copyTextFromTranscriptLines(renderModel.transcript.lines);
    case "page":
      return copyTextFromTranscriptLines(renderModel.transcript.visibleLines);
  }
}

export function copyTextFromTranscriptLines(lines: readonly TranscriptLine[]) {
  return lines.map((line) => line.text).join("\n").trimEnd();
}

export function copyTextFromActivities(activities: readonly WorkbenchRenderModel["visibleActivities"][number][]) {
  return activities
    .map((activity) => `${new Date(activity.timestamp).toLocaleTimeString()} ${activity.text}`)
    .join("\n")
    .trimEnd();
}
