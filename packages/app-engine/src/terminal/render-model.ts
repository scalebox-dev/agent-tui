import type { RenderMode, WorkbenchState } from "../workbench/state.js";
import {
  buildTranscriptViewModel,
  elapsedDots,
  spinnerGlyph,
  type TranscriptViewModel,
} from "./view-model.js";

export interface WorkbenchRendererViewport {
  rows: number;
  columns: number;
}

export interface WorkbenchRenderModel {
  activityHeight: number;
  footerText: string;
  header: {
    accessMode: string;
    contextEnabled: boolean;
    conversation: string;
    conversationId: string;
    conversationPreviousResponseId: string;
    conversationStatus: "fresh" | "continued" | "unknown";
    model: string;
    pendingLocalLabel: string;
    preset: string;
    profile: string;
    renderMode: RenderMode;
    workdir: string;
  };
  layout: "wide" | "compact";
  input: {
    busy: boolean;
    cursor: number;
    draft: string;
    fullAccess: boolean;
    height: number;
    label: string;
    lines: WorkbenchInputLine[];
    viewportColumns: number;
    waitingText: string;
  };
  terminalColumns: number;
  terminalRows: number;
  transcript: TranscriptViewModel;
  transcriptWidth: number;
  viewportHeight: number;
  visibleActivities: WorkbenchState["activities"];
}

export interface WorkbenchInputLine {
  afterCursor: string;
  beforeCursor: string;
  cursorText: string;
  hasCursor: boolean;
}

export interface BuildWorkbenchRenderModelInput {
  cursor?: number;
  draft: string;
  profileName: string;
  spinnerFrame: number;
  state: WorkbenchState;
  transcriptOffset: number;
  viewport: Partial<WorkbenchRendererViewport>;
  workdirFallback: string;
}

export function buildWorkbenchRenderModel(input: BuildWorkbenchRenderModelInput): WorkbenchRenderModel {
  const terminalRows = Math.max(8, input.viewport.rows || 32);
  const terminalColumns = Math.max(24, input.viewport.columns || 100);
  const layout = terminalColumns >= 96 ? "wide" : "compact";
  const cursor = Math.max(0, Math.min(input.draft.length, input.cursor ?? input.draft.length));
  const fullAccess = input.state.accessMode === "full";
  const label = input.state.busy ? "working" : "you";
  const inputViewportColumns = Math.max(8, terminalColumns - 10 - label.length - (fullAccess ? 14 : 0));
  const inputView = input.state.busy
    ? singleLineInputView({ beforeCursor: "", cursorText: " ", afterCursor: "" }, inputViewportColumns)
    : buildInputView(input.draft, cursor, inputViewportColumns, maxInputRows(terminalRows));
  const reservedRows = (layout === "wide" ? 11 : 14) + Math.max(0, inputView.height - 1);
  const viewportHeight = Math.max(3, terminalRows - reservedRows);
  const activityHeight = layout === "wide" ? viewportHeight : Math.min(4, Math.max(2, Math.floor(viewportHeight / 3)));
  const transcriptHeight = layout === "wide" ? viewportHeight : Math.max(3, viewportHeight - activityHeight);
  const transcriptWidth = layout === "wide"
    ? Math.max(28, Math.floor(terminalColumns * 0.72) - 4)
    : Math.max(20, terminalColumns - 4);
  const transcript = buildTranscriptViewModel({
    activeAssistantMessageId: input.state.activeAssistantMessageId,
    busy: input.state.busy,
    messages: input.state.messages,
    offset: input.transcriptOffset,
    renderMode: input.state.renderMode,
    spinnerFrame: input.spinnerFrame,
    viewportHeight: transcriptHeight,
    width: transcriptWidth,
  });

  return {
    activityHeight,
    footerText: [
      "PgUp/PgDn scroll",
      "End live",
      "/export save",
      "/transcript preview",
      transcript.offset > 0 ? `${transcript.offset} rows from latest` : "live",
    ].join(" · "),
    header: {
      accessMode: input.state.accessMode,
      contextEnabled: input.state.contextEnabled,
      conversation: input.state.currentConversation,
      conversationId: input.state.conversationId || "unresolved",
      conversationPreviousResponseId: input.state.conversationPreviousResponseId || "",
      conversationStatus: input.state.conversationStatus,
      model: input.state.runModel || "auto",
      pendingLocalLabel: pendingLocalLabel(input.state),
      preset: input.state.runPreset || "none",
      profile: input.profileName,
      renderMode: input.state.renderMode,
      workdir: input.state.workdir?.root || input.workdirFallback,
    },
    layout,
    input: {
      busy: input.state.busy,
      cursor,
      draft: input.draft,
      fullAccess,
      height: inputView.height,
      label,
      lines: inputView.lines,
      viewportColumns: inputViewportColumns,
      waitingText: `waiting for agent ${elapsedDots(input.spinnerFrame)}`,
    },
    terminalColumns,
    terminalRows,
    transcript,
    transcriptWidth,
    viewportHeight,
    visibleActivities: input.state.activities.slice(-Math.max(1, activityHeight - 2)),
  };
}

export function pendingLocalLabel(state: WorkbenchState) {
  if (state.pendingLocalTool) {
    return `${state.pendingLocalTool.name}${state.pendingLocalTool.action ? `.${state.pendingLocalTool.action}` : ""}`;
  }
  if (state.pendingAutomaticContinuation) {
    return `continuation ${state.pendingAutomaticContinuation.count}/${state.pendingAutomaticContinuation.limit}`;
  }
  return "none";
}

export function busySpinner(frame: number) {
  return spinnerGlyph(frame);
}

function inputViewportText(draft: string, cursor: number, maxColumns: number) {
  if (draft.length === 0) {
    return { beforeCursor: "", cursorText: " ", afterCursor: "" };
  }
  const fullWidth = Math.max(1, maxColumns - (cursor >= draft.length ? 1 : 0));
  if (draft.length <= fullWidth) {
    return {
      beforeCursor: draft.slice(0, cursor),
      cursorText: draft[cursor] ?? " ",
      afterCursor: draft.slice(cursor + (cursor < draft.length ? 1 : 0)),
    };
  }

  const windowColumns = Math.max(4, maxColumns - 3);
  const maxStart = Math.max(0, draft.length - windowColumns);
  const preferredStart = cursor >= draft.length
    ? maxStart
    : Math.max(0, cursor - Math.floor(windowColumns * 0.65));
  const start = Math.min(preferredStart, maxStart);
  const end = Math.min(draft.length, start + windowColumns);
  const visibleCursor = Math.max(start, Math.min(cursor, end));
  const hasLeft = start > 0;
  const hasRight = end < draft.length;
  const beforeCursor = `${hasLeft ? "‹" : ""}${draft.slice(start, visibleCursor)}`;
  const cursorText = draft[visibleCursor] ?? " ";
  const afterCursor = `${draft.slice(visibleCursor + (visibleCursor < draft.length ? 1 : 0), end)}${hasRight ? "›" : ""}`;
  return { beforeCursor, cursorText, afterCursor };
}

function buildInputView(draft: string, cursor: number, maxColumns: number, maxRows: number) {
  const segments = inputLineSegments(draft, maxColumns);
  const cursorSegmentIndex = Math.max(0, segments.findIndex((segment) => cursor >= segment.start && cursor <= segment.end));
  const height = Math.min(maxRows, Math.max(1, segments.length));
  const start = clamp(cursorSegmentIndex - Math.floor(height / 2), 0, Math.max(0, segments.length - height));
  const visible = segments.slice(start, start + height);
  const lines = visible.map((segment, index): WorkbenchInputLine => {
    const hasCursor = cursor >= segment.start && cursor <= segment.end;
    const localCursor = hasCursor ? Math.max(0, Math.min(cursor - segment.start, segment.text.length)) : 0;
    return {
      beforeCursor: `${start > 0 && index === 0 ? "⋮ " : ""}${hasCursor ? segment.text.slice(0, localCursor) : segment.text}`,
      cursorText: hasCursor ? segment.text[localCursor] ?? " " : "",
      afterCursor: `${hasCursor ? segment.text.slice(localCursor + (localCursor < segment.text.length ? 1 : 0)) : ""}${start + height < segments.length && index === visible.length - 1 ? " ⋮" : ""}`,
      hasCursor,
    };
  });
  return { height, lines };
}

function singleLineInputView(line: Omit<WorkbenchInputLine, "hasCursor">, maxColumns: number) {
  const clipped = inputViewportText(`${line.beforeCursor}${line.cursorText}${line.afterCursor}`, line.beforeCursor.length, maxColumns);
  return {
    height: 1,
    lines: [{ ...clipped, hasCursor: true }],
  };
}

function inputLineSegments(draft: string, maxColumns: number) {
  if (!draft) return [{ text: "", start: 0, end: 0 }];
  const width = Math.max(8, maxColumns);
  const segments: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  const hardLines = draft.split("\n");
  for (let lineIndex = 0; lineIndex < hardLines.length; lineIndex += 1) {
    const line = hardLines[lineIndex] ?? "";
    if (!line) {
      segments.push({ text: "", start: offset, end: offset });
    } else {
      for (let start = 0; start < line.length; start += width) {
        const text = line.slice(start, start + width);
        segments.push({ text, start: offset + start, end: offset + start + text.length });
      }
    }
    offset += line.length;
    if (lineIndex < hardLines.length - 1) offset += 1;
  }
  return segments;
}

function maxInputRows(terminalRows: number) {
  return Math.max(1, Math.min(6, Math.floor(terminalRows / 5)));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
