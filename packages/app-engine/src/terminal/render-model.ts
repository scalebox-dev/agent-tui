import type { RenderMode, WorkbenchState } from "../workbench/state.js";
import {
  buildTranscriptViewModel,
  elapsedDots,
  spinnerGlyph,
  type TranscriptViewModel,
} from "./view-model.js";
import { findCursorSegmentIndex, inputLineSegments } from "./text-layout.js";

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
    selectionAnchor: number | null;
    statusText: string;
    viewportColumns: number;
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
  end: number;
  hasCursor: boolean;
  start: number;
  spans: WorkbenchInputSpan[];
  text: string;
}

export interface WorkbenchInputSpan {
  inverse?: boolean;
  text: string;
}

export interface BuildWorkbenchRenderModelInput {
  cursor?: number;
  draft: string;
  profileName: string;
  selectionAnchor?: number | null;
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
  const selectionAnchor = input.selectionAnchor == null
    ? null
    : Math.max(0, Math.min(input.draft.length, input.selectionAnchor));
  const fullAccess = input.state.accessMode === "full";
  const label = "You";
  const inputViewportColumns = Math.max(8, terminalColumns - 6);
  const inputView = buildInputView(input.draft, cursor, selectionAnchor, inputViewportColumns, maxInputRows(terminalRows));
  const reservedRows = 10 + inputView.height;
  const viewportHeight = Math.max(3, terminalRows - reservedRows);
  const activityHeight = layout === "wide" ? viewportHeight : Math.min(4, Math.max(2, Math.floor(viewportHeight / 3)));
  const transcriptOuterHeight = layout === "wide" ? viewportHeight : Math.max(3, viewportHeight - activityHeight);
  const transcriptHeight = Math.max(1, transcriptOuterHeight - 2);
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
      "PgUp/PgDn page",
      "Shift+↑/↓ row",
      "End live",
      "/copy page",
      "/export save",
      "/transcript preview",
      transcript.offset > 0
        ? `${transcript.scrollPercent}% · rows ${transcript.startLine}-${transcript.endLine}/${transcript.totalLines} · ${transcript.offset} from live`
        : "live",
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
      selectionAnchor,
      statusText: input.state.busy ? `waiting for agent ${elapsedDots(input.spinnerFrame)}` : "",
      viewportColumns: inputViewportColumns,
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
  if (state.pendingUpdate) {
    return `update ${state.pendingUpdate.result.current}->${state.pendingUpdate.result.latest}`;
  }
  return "none";
}

export function busySpinner(frame: number) {
  return spinnerGlyph(frame);
}

function buildInputView(draft: string, cursor: number, selectionAnchor: number | null, maxColumns: number, maxRows: number) {
  const segments = inputLineSegments(draft, maxColumns);
  const cursorSegmentIndex = findCursorSegmentIndex(segments, cursor);
  const height = Math.min(maxRows, Math.max(1, segments.length));
  const start = clamp(cursorSegmentIndex - Math.floor(height / 2), 0, Math.max(0, segments.length - height));
  const visible = segments.slice(start, start + height);
  const selection = selectedRange(cursor, selectionAnchor);
  const lines = visible.map((segment, index): WorkbenchInputLine => {
    const hasCursor = cursor >= segment.start && cursor <= segment.end;
    const localCursor = hasCursor ? Math.max(0, Math.min(cursor - segment.start, segment.text.length)) : 0;
    const prefix = start > 0 && index === 0 ? "⋮ " : "";
    const suffix = start + height < segments.length && index === visible.length - 1 ? " ⋮" : "";
    return {
      beforeCursor: `${prefix}${displayText(hasCursor ? segment.text.slice(0, localCursor) : segment.text)}`,
      cursorText: hasCursor ? displayChar(charAt(segment.text, localCursor)) || " " : "",
      afterCursor: `${hasCursor ? displayText(segment.text.slice(localCursor + charLengthAt(segment.text, localCursor))) : ""}${suffix}`,
      end: segment.end,
      hasCursor,
      start: segment.start,
      spans: inputLineSpans(segment, {
        cursor: hasCursor ? cursor : null,
        prefix,
        selection,
        suffix,
      }),
      text: segment.text,
    };
  });
  return { height, lines };
}

function maxInputRows(terminalRows: number) {
  return Math.max(1, Math.min(6, Math.floor(terminalRows / 6)));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function selectedRange(cursor: number, selectionAnchor: number | null) {
  if (selectionAnchor === null || selectionAnchor === cursor) return null;
  return {
    start: Math.min(cursor, selectionAnchor),
    end: Math.max(cursor, selectionAnchor),
  };
}

function inputLineSpans(segment: { end: number; start: number; text: string }, options: {
  cursor: number | null;
  prefix: string;
  selection: { end: number; start: number } | null;
  suffix: string;
}): WorkbenchInputSpan[] {
  const spans: WorkbenchInputSpan[] = [];
  if (options.prefix) spans.push({ text: options.prefix });
  if (!segment.text && options.cursor !== null) {
    spans.push({ text: " ", inverse: true });
  } else {
    for (let index = 0; index < segment.text.length;) {
      const text = charAt(segment.text, index);
      const absolute = segment.start + index;
      const selected = Boolean(options.selection && absolute >= options.selection.start && absolute < options.selection.end);
      const underCursor = options.cursor === absolute;
      spans.push({ text: displayChar(text), inverse: selected || underCursor });
      index += text.length || 1;
    }
    if (options.cursor === segment.end) {
      spans.push({ text: " ", inverse: true });
    }
  }
  if (options.suffix) spans.push({ text: options.suffix });
  return coalesceSpans(spans);
}

function charAt(text: string, index: number) {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function charLengthAt(text: string, index: number) {
  const char = charAt(text, index);
  return char.length;
}

function displayText(text: string) {
  let result = "";
  for (let index = 0; index < text.length;) {
    const char = charAt(text, index);
    result += displayChar(char);
    index += char.length || 1;
  }
  return result;
}

function displayChar(char: string) {
  if (char === "\t") return "    ";
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return "";
  return char;
}

function coalesceSpans(spans: WorkbenchInputSpan[]) {
  const merged: WorkbenchInputSpan[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = merged.at(-1);
    if (last && Boolean(last.inverse) === Boolean(span.inverse)) {
      last.text += span.text;
    } else {
      merged.push(span.inverse ? { text: span.text, inverse: true } : { text: span.text });
    }
  }
  return merged.length > 0 ? merged : [{ text: " " }];
}
