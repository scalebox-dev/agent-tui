import type { WorkbenchCopyTarget } from "../workbench/state.js";
import type { WorkbenchRenderModel } from "./render-model.js";
import type { TranscriptLine } from "./view-model.js";

export type { WorkbenchCopyTarget };

export function copyTextFromRenderModel(renderModel: WorkbenchRenderModel, target: WorkbenchCopyTarget): string {
  switch (target) {
    case "activity":
      return renderModel.visibleActivities
        .map((activity) => `${new Date(activity.timestamp).toLocaleTimeString()} ${activity.text}`)
        .join("\n")
        .trimEnd();
    case "transcript":
      return transcriptLinesText(renderModel.transcript.lines);
    case "page":
      return transcriptLinesText(renderModel.transcript.visibleLines);
  }
}

function transcriptLinesText(lines: readonly TranscriptLine[]) {
  return lines.map((line) => line.text).join("\n").trimEnd();
}
