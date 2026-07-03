import type { WorkbenchCopyTarget } from "../workbench/state.js";
import type { WorkbenchRenderModel } from "./render-model.js";
import type { TranscriptLine } from "./view-model.js";
import type { WorkbenchPanelSelection } from "./workbench-controller.js";

export type { WorkbenchCopyTarget };

export function copyTextFromRenderModel(renderModel: WorkbenchRenderModel, target: WorkbenchCopyTarget): string {
  switch (target) {
    case "activity":
      return copyTextFromActivities(renderModel.visibleActivities);
    case "conversation":
      return copyTextFromLines(renderModel.conversation.lines);
    case "header":
      return copyTextFromLines(renderModel.header.lines);
    case "transcript":
      return copyTextFromTranscriptLines(renderModel.transcript.lines);
    case "page":
      return copyTextFromTranscriptLines(renderModel.transcript.visibleLines);
    case "workspace":
      return copyTextFromLines(renderModel.workspace.lines);
    case "workdir":
      return copyTextFromLines(renderModel.workdir.lines);
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

export function copyTextFromHeaderLines(lines: readonly string[]) {
  return copyTextFromLines(lines);
}

export function copyTextFromLines(lines: readonly string[]) {
  return lines.join("\n").trimEnd();
}

export function copyTextFromHeaderSelection(
  lines: readonly string[],
  selection: WorkbenchPanelSelection,
) {
  return copySelectedLines(lines, selection);
}

export function copyTextFromTranscriptSelection(
  lines: readonly TranscriptLine[],
  selection: WorkbenchPanelSelection,
) {
  return copySelectedLines(lines.map((line) => line.text), selection);
}

export function copyTextFromActivitySelection(
  activities: readonly WorkbenchRenderModel["visibleActivities"][number][],
  selection: WorkbenchPanelSelection,
) {
  return copySelectedLines(
    activities.map((activity) => `${new Date(activity.timestamp).toLocaleTimeString()} ${activity.text}`),
    selection,
  );
}

function copySelectedLines(lines: readonly string[], selection: WorkbenchPanelSelection) {
  const output: string[] = [];
  for (let line = selection.start.line; line <= selection.end.line; line += 1) {
    const text = lines[line] ?? "";
    const start = line === selection.start.line ? selection.start.column : 0;
    const end = line === selection.end.line ? selection.end.column : text.length;
    output.push(text.slice(start, end));
  }
  return output.join("\n").trimEnd();
}
