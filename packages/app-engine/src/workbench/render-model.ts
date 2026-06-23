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
  input: {
    afterCursor: string;
    beforeCursor: string;
    busy: boolean;
    cursor: number;
    cursorText: string;
    draft: string;
    fullAccess: boolean;
    label: string;
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
  const terminalRows = Math.max(18, input.viewport.rows || 32);
  const terminalColumns = Math.max(80, input.viewport.columns || 100);
  const viewportHeight = Math.max(6, terminalRows - 11);
  const activityHeight = viewportHeight;
  const transcriptWidth = Math.max(36, Math.floor(terminalColumns * 0.72) - 4);
  const transcript = buildTranscriptViewModel({
    activeAssistantMessageId: input.state.activeAssistantMessageId,
    busy: input.state.busy,
    messages: input.state.messages,
    offset: input.transcriptOffset,
    renderMode: input.state.renderMode,
    spinnerFrame: input.spinnerFrame,
    viewportHeight,
    width: transcriptWidth,
  });
  const cursor = Math.max(0, Math.min(input.draft.length, input.cursor ?? input.draft.length));
  const beforeCursor = input.draft.slice(0, cursor);
  const cursorText = input.draft[cursor] ?? " ";
  const afterCursor = input.draft.slice(cursor + (cursor < input.draft.length ? 1 : 0));

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
    input: {
      afterCursor,
      beforeCursor,
      busy: input.state.busy,
      cursor,
      cursorText,
      draft: input.draft,
      fullAccess: input.state.accessMode === "full",
      label: input.state.busy ? "working" : "you",
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
