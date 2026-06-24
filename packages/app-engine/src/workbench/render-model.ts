import type { RenderMode, WorkbenchState } from "./state.js";
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
    afterCursor: string;
    beforeCursor: string;
    busy: boolean;
    cursor: number;
    cursorText: string;
    draft: string;
    fullAccess: boolean;
    label: string;
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
  const reservedRows = layout === "wide" ? 11 : 14;
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
  const cursor = Math.max(0, Math.min(input.draft.length, input.cursor ?? input.draft.length));
  const fullAccess = input.state.accessMode === "full";
  const label = input.state.busy ? "working" : "you";
  const inputViewportColumns = Math.max(8, terminalColumns - 10 - label.length - (fullAccess ? 14 : 0));
  const inputViewport = inputViewportText(input.draft, cursor, inputViewportColumns);

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
      afterCursor: inputViewport.afterCursor,
      beforeCursor: inputViewport.beforeCursor,
      busy: input.state.busy,
      cursor,
      cursorText: inputViewport.cursorText,
      draft: input.draft,
      fullAccess,
      label,
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
