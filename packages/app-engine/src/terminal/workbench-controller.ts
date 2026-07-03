import type { WorkbenchCopyTarget } from "../workbench/state.js";
import type { WorkbenchInputEffect, WorkbenchInputKey } from "./input-controller.js";
import { createWorkbenchInputController } from "./input-controller.js";
import type { WorkbenchRenderModel } from "./render-model.js";
import { indexAtDisplayColumn } from "./text-layout.js";

export type WorkbenchFocusedPanel = "activity" | "conversation" | "header" | "input" | "transcript" | "workspace" | "workdir";

export interface WorkbenchPanelPosition {
  column: number;
  line: number;
}

export interface WorkbenchPanelSelection {
  end: WorkbenchPanelPosition;
  start: WorkbenchPanelPosition;
}

export interface WorkbenchTerminalKey extends WorkbenchInputKey {
  tab?: boolean;
}

export interface WorkbenchTerminalMouseEvent {
  button: "left" | "right" | "wheel_down" | "wheel_up" | "unknown";
  column: number;
  kind: "motion" | "press" | "release" | "wheel";
  row: number;
}

export interface WorkbenchTerminalState {
  activityCursor: WorkbenchPanelPosition;
  activitySelectionAnchor: WorkbenchPanelPosition | null;
  conversationCursor: WorkbenchPanelPosition;
  conversationSelectionAnchor: WorkbenchPanelPosition | null;
  cursor: number;
  draft: string;
  focusedPanel: WorkbenchFocusedPanel;
  headerCursor: WorkbenchPanelPosition;
  headerSelectionAnchor: WorkbenchPanelPosition | null;
  mouseDragPanel: WorkbenchFocusedPanel | null;
  selectionAnchor: number | null;
  transcriptCursor: WorkbenchPanelPosition;
  transcriptOffset: number;
  transcriptSelectionAnchor: WorkbenchPanelPosition | null;
  workspaceCursor: WorkbenchPanelPosition;
  workspaceSelectionAnchor: WorkbenchPanelPosition | null;
  workdirCursor: WorkbenchPanelPosition;
  workdirSelectionAnchor: WorkbenchPanelPosition | null;
}

export type WorkbenchTerminalEffect =
  | WorkbenchInputEffect
  | { type: "copy"; target: WorkbenchCopyTarget }
  | { type: "paste" }
  | { type: "switch_conversation"; name: string }
  | { type: "switch_workspace"; id: string };

export interface WorkbenchTerminalContext {
  busy: boolean;
  renderModel: WorkbenchRenderModel;
}

export interface WorkbenchTerminalResult {
  effects: WorkbenchTerminalEffect[];
  state: WorkbenchTerminalState;
}

export interface WorkbenchTerminalController {
  handle(
    input: string,
    key: WorkbenchTerminalKey,
    state: WorkbenchTerminalState,
    context: WorkbenchTerminalContext,
  ): WorkbenchTerminalResult;
  handleMouse(
    event: WorkbenchTerminalMouseEvent,
    state: WorkbenchTerminalState,
    context: WorkbenchTerminalContext,
  ): WorkbenchTerminalResult;
}

export function initialWorkbenchTerminalState(): WorkbenchTerminalState {
  return {
    activityCursor: { column: 0, line: 0 },
    activitySelectionAnchor: null,
    conversationCursor: { column: 0, line: 0 },
    conversationSelectionAnchor: null,
    cursor: 0,
    draft: "",
    focusedPanel: "input",
    headerCursor: { column: 0, line: 0 },
    headerSelectionAnchor: null,
    mouseDragPanel: null,
    selectionAnchor: null,
    transcriptCursor: { column: 0, line: 0 },
    transcriptOffset: 0,
    transcriptSelectionAnchor: null,
    workspaceCursor: { column: 0, line: 0 },
    workspaceSelectionAnchor: null,
    workdirCursor: { column: 0, line: 0 },
    workdirSelectionAnchor: null,
  };
}

export function createWorkbenchTerminalController(): WorkbenchTerminalController {
  const inputController = createWorkbenchInputController();

  return {
    handle(input, key, state, context) {
      const normalized = normalizeTerminalState(state, context.renderModel);
      if (key.tab) {
        return stateResult(cycleFocusedPanel(normalized, context.renderModel, key.shift ? -1 : 1));
      }
      if (key.meta && input.toLowerCase() === "v") {
        return stateResult({ ...normalized, focusedPanel: "input" }, { type: "paste" });
      }
      const direction = directionalPanelShortcut(input, key);
      if (direction && normalized.focusedPanel !== "input") {
        return stateResult(focusDirectionalPanel(normalized, context.renderModel, direction));
      }
      if (normalized.focusedPanel !== "input") {
        return handleReadOnlyPanel(input, key, normalized, context.renderModel);
      }
      const result = inputController.handle(input, key, {
        busy: context.busy,
        cursor: normalized.cursor,
        draft: normalized.draft,
        selectionAnchor: normalized.selectionAnchor,
        viewportColumns: context.renderModel.input.viewportColumns,
        viewportHeight: context.renderModel.transcript.viewportHeight,
      });
      return {
        state: {
          ...normalized,
          cursor: result.cursor,
          draft: result.draft,
          selectionAnchor: result.selectionAnchor,
        },
        effects: result.effects,
      };
    },
    handleMouse(event, state, context) {
      return handleMouseEvent(event, normalizeTerminalState(state, context.renderModel), context.renderModel);
    },
  };
}

export function selectedPanelRange(
  anchor: WorkbenchPanelPosition | null,
  cursor: WorkbenchPanelPosition,
): WorkbenchPanelSelection | null {
  if (anchor === null || samePosition(anchor, cursor)) return null;
  if (comparePosition(anchor, cursor) <= 0) return { start: anchor, end: cursor };
  return {
    start: cursor,
    end: anchor,
  };
}

export function normalizeTerminalState(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  const maxTranscriptLine = Math.max(0, renderModel.transcript.totalLines - 1);
  const maxActivityIndex = Math.max(0, renderModel.visibleActivities.length - 1);
  const maxConversationIndex = Math.max(0, renderModel.conversation.lines.length - 1);
  const maxHeaderIndex = Math.max(0, renderModel.header.lines.length - 1);
  const maxWorkspaceIndex = Math.max(0, renderModel.workspace.lines.length - 1);
  const maxWorkdirIndex = Math.max(0, renderModel.workdir.lines.length - 1);
  const draftLength = state.draft.length;
  const conversationCursor = normalizePanelPosition(
    state.conversationCursor,
    maxConversationIndex,
    (line) => conversationLineText(renderModel, line),
  );
  const headerCursor = normalizePanelPosition(
    state.headerCursor,
    maxHeaderIndex,
    (line) => headerLineText(renderModel, line),
  );
  const transcriptCursor = normalizePanelPosition(
    state.transcriptCursor,
    maxTranscriptLine,
    (line) => transcriptLineText(renderModel, line),
  );
  const activityCursor = normalizePanelPosition(
    state.activityCursor,
    maxActivityIndex,
    (line) => activityLineText(renderModel, line),
  );
  return {
    ...state,
    activityCursor,
    activitySelectionAnchor: state.activitySelectionAnchor == null
      ? null
      : normalizePanelPosition(state.activitySelectionAnchor, maxActivityIndex, (line) => activityLineText(renderModel, line)),
    conversationCursor,
    conversationSelectionAnchor: state.conversationSelectionAnchor == null
      ? null
      : normalizePanelPosition(state.conversationSelectionAnchor, maxConversationIndex, (line) => conversationLineText(renderModel, line)),
    cursor: clamp(state.cursor, 0, draftLength),
    headerCursor,
    headerSelectionAnchor: state.headerSelectionAnchor == null
      ? null
      : normalizePanelPosition(state.headerSelectionAnchor, maxHeaderIndex, (line) => headerLineText(renderModel, line)),
    selectionAnchor: state.selectionAnchor == null ? null : clamp(state.selectionAnchor, 0, draftLength),
    transcriptCursor,
    transcriptOffset: clamp(state.transcriptOffset, 0, renderModel.transcript.maxOffset),
    transcriptSelectionAnchor: state.transcriptSelectionAnchor == null
      ? null
      : normalizePanelPosition(state.transcriptSelectionAnchor, maxTranscriptLine, (line) => transcriptLineText(renderModel, line)),
    workspaceCursor: normalizePanelPosition(
      state.workspaceCursor,
      maxWorkspaceIndex,
      (line) => workspaceLineText(renderModel, line),
    ),
    workspaceSelectionAnchor: state.workspaceSelectionAnchor == null
      ? null
      : normalizePanelPosition(state.workspaceSelectionAnchor, maxWorkspaceIndex, (line) => workspaceLineText(renderModel, line)),
    workdirCursor: normalizePanelPosition(
      state.workdirCursor,
      maxWorkdirIndex,
      (line) => workdirLineText(renderModel, line),
    ),
    workdirSelectionAnchor: state.workdirSelectionAnchor == null
      ? null
      : normalizePanelPosition(state.workdirSelectionAnchor, maxWorkdirIndex, (line) => workdirLineText(renderModel, line)),
  };
}

function handleReadOnlyPanel(
  input: string,
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalResult {
  if (key.escape) {
    if (state.focusedPanel === "transcript" && state.transcriptSelectionAnchor !== null) {
      return stateResult({ ...state, transcriptSelectionAnchor: null });
    }
    if (state.focusedPanel === "activity" && state.activitySelectionAnchor !== null) {
      return stateResult({ ...state, activitySelectionAnchor: null });
    }
    if (state.focusedPanel === "conversation" && state.conversationSelectionAnchor !== null) {
      return stateResult({ ...state, conversationSelectionAnchor: null });
    }
    if (state.focusedPanel === "header" && state.headerSelectionAnchor !== null) {
      return stateResult({ ...state, headerSelectionAnchor: null });
    }
    if (state.focusedPanel === "workspace" && state.workspaceSelectionAnchor !== null) {
      return stateResult({ ...state, workspaceSelectionAnchor: null });
    }
    if (state.focusedPanel === "workdir" && state.workdirSelectionAnchor !== null) {
      return stateResult({ ...state, workdirSelectionAnchor: null });
    }
    return stateResult({ ...state, focusedPanel: "input" });
  }
  if (key.ctrl && input === "a") {
    if (state.focusedPanel === "transcript") return stateResult(selectTranscriptAll(state, renderModel));
    if (state.focusedPanel === "activity") return stateResult(selectActivityAll(state, renderModel));
    if (state.focusedPanel === "conversation") return stateResult(selectConversationAll(state, renderModel));
    if (state.focusedPanel === "header") return stateResult(selectHeaderAll(state, renderModel));
    if (state.focusedPanel === "workspace") return stateResult(selectWorkspaceAll(state, renderModel));
    if (state.focusedPanel === "workdir") return stateResult(selectWorkdirAll(state, renderModel));
  }
  if (key.meta && input.toLowerCase() === "c") {
    const target: WorkbenchCopyTarget = state.focusedPanel === "activity"
      ? "activity"
      : state.focusedPanel === "conversation"
        ? "conversation"
        : state.focusedPanel === "header"
          ? "header"
          : state.focusedPanel === "workspace"
            ? "workspace"
            : state.focusedPanel === "workdir"
              ? "workdir"
              : "page";
    return { state, effects: [{ type: "copy", target }] };
  }
  if (state.focusedPanel === "conversation" && key.return) {
    const item = renderModel.conversation.items[state.conversationCursor.line];
    if (item && item.name !== renderModel.header.conversation) {
      return stateResult(state, { type: "switch_conversation", name: item.name });
    }
    return stateResult(state);
  }
  if (state.focusedPanel === "workspace" && key.return) {
    const workspace = renderModel.workspace.lines[state.workspaceCursor.line];
    const id = renderModel.workspace.items?.[state.workspaceCursor.line]?.id ?? workspaceIDFromLine(workspace || "");
    if (id) return { state, effects: [{ type: "switch_workspace", id }] };
  }
  if (state.focusedPanel === "transcript") {
    return stateResult(handleTranscriptPanelKey(key, state, renderModel));
  }
  if (state.focusedPanel === "conversation") return stateResult(handleConversationPanelKey(key, state, renderModel));
  if (state.focusedPanel === "header") return stateResult(handleHeaderPanelKey(key, state, renderModel));
  if (state.focusedPanel === "workspace") return stateResult(handleWorkspacePanelKey(key, state, renderModel));
  if (state.focusedPanel === "workdir") return stateResult(handleWorkdirPanelKey(key, state, renderModel));
  return stateResult(handleActivityPanelKey(key, state, renderModel));
}

function handleConversationPanelKey(
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (key.home) return setConversationCursor(state, renderModel, 0, 0, Boolean(key.shift));
  if (key.end) {
    const line = Math.max(0, renderModel.conversation.lines.length - 1);
    return setConversationCursor(state, renderModel, line, conversationLineText(renderModel, line).length, Boolean(key.shift));
  }
  if (key.leftArrow) return moveConversationColumn(state, renderModel, -1, Boolean(key.shift));
  if (key.rightArrow) return moveConversationColumn(state, renderModel, 1, Boolean(key.shift));
  if (key.upArrow) return moveConversationCursor(state, renderModel, -1, Boolean(key.shift));
  if (key.downArrow) return moveConversationCursor(state, renderModel, 1, Boolean(key.shift));
  return state;
}

function handleWorkspacePanelKey(
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (key.home) return setWorkspaceCursor(state, renderModel, 0, 0, Boolean(key.shift));
  if (key.end) {
    const line = Math.max(0, renderModel.workspace.lines.length - 1);
    return setWorkspaceCursor(state, renderModel, line, workspaceLineText(renderModel, line).length, Boolean(key.shift));
  }
  if (key.leftArrow) return moveWorkspaceColumn(state, renderModel, -1, Boolean(key.shift));
  if (key.rightArrow) return moveWorkspaceColumn(state, renderModel, 1, Boolean(key.shift));
  if (key.upArrow) return moveWorkspaceCursor(state, renderModel, -1, Boolean(key.shift));
  if (key.downArrow) return moveWorkspaceCursor(state, renderModel, 1, Boolean(key.shift));
  return state;
}

function handleWorkdirPanelKey(
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (key.home) return setWorkdirCursor(state, renderModel, 0, 0, Boolean(key.shift));
  if (key.end) {
    const line = Math.max(0, renderModel.workdir.lines.length - 1);
    return setWorkdirCursor(state, renderModel, line, workdirLineText(renderModel, line).length, Boolean(key.shift));
  }
  if (key.leftArrow) return moveWorkdirColumn(state, renderModel, -1, Boolean(key.shift));
  if (key.rightArrow) return moveWorkdirColumn(state, renderModel, 1, Boolean(key.shift));
  if (key.upArrow) return moveWorkdirCursor(state, renderModel, -1, Boolean(key.shift));
  if (key.downArrow) return moveWorkdirCursor(state, renderModel, 1, Boolean(key.shift));
  return state;
}

function handleHeaderPanelKey(
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (key.home) return setHeaderCursor(state, renderModel, 0, 0, Boolean(key.shift));
  if (key.end) {
    const line = Math.max(0, renderModel.header.lines.length - 1);
    return setHeaderCursor(state, renderModel, line, headerLineText(renderModel, line).length, Boolean(key.shift));
  }
  if (key.leftArrow) return moveHeaderColumn(state, renderModel, -1, Boolean(key.shift));
  if (key.rightArrow) return moveHeaderColumn(state, renderModel, 1, Boolean(key.shift));
  if (key.upArrow) return moveHeaderCursor(state, renderModel, -1, Boolean(key.shift));
  if (key.downArrow) return moveHeaderCursor(state, renderModel, 1, Boolean(key.shift));
  return state;
}

function handleTranscriptPanelKey(
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  const pageDelta = Math.max(1, renderModel.transcript.viewportHeight - 1);
  if (key.pageUp) {
    return moveTranscriptCursor(
      scrollTranscript(state, renderModel, pageDelta),
      renderModel,
      -pageDelta,
      Boolean(key.shift),
    );
  }
  if (key.pageDown) {
    return moveTranscriptCursor(
      scrollTranscript(state, renderModel, -pageDelta),
      renderModel,
      pageDelta,
      Boolean(key.shift),
    );
  }
  if (key.home) return setTranscriptCursor(scrollTranscriptToTop(state, renderModel), renderModel, 0, 0, Boolean(key.shift));
  if (key.end) {
    const line = Math.max(0, renderModel.transcript.totalLines - 1);
    return setTranscriptCursor(
      scrollTranscriptToBottom(state),
      renderModel,
      line,
      transcriptLineText(renderModel, line).length,
      Boolean(key.shift),
    );
  }
  if (key.leftArrow) return moveTranscriptColumn(state, renderModel, -1, Boolean(key.shift));
  if (key.rightArrow) return moveTranscriptColumn(state, renderModel, 1, Boolean(key.shift));
  if (key.upArrow) return moveTranscriptCursor(state, renderModel, -1, Boolean(key.shift));
  if (key.downArrow) return moveTranscriptCursor(state, renderModel, 1, Boolean(key.shift));
  return state;
}

function handleActivityPanelKey(
  key: WorkbenchTerminalKey,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (key.home) return setActivityCursor(state, renderModel, 0, 0, Boolean(key.shift));
  if (key.end) {
    const line = Math.max(0, renderModel.visibleActivities.length - 1);
    return setActivityCursor(state, renderModel, line, activityLineText(renderModel, line).length, Boolean(key.shift));
  }
  if (key.leftArrow) return moveActivityColumn(state, renderModel, -1, Boolean(key.shift));
  if (key.rightArrow) return moveActivityColumn(state, renderModel, 1, Boolean(key.shift));
  if (key.upArrow) return moveActivityCursor(state, renderModel, -1, Boolean(key.shift));
  if (key.downArrow) return moveActivityCursor(state, renderModel, 1, Boolean(key.shift));
  return state;
}

function cycleFocusedPanel(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  direction: 1 | -1,
): WorkbenchTerminalState {
  const panels: WorkbenchFocusedPanel[] = ["input", "header", "conversation", "workdir", "workspace", "transcript", "activity"];
  const index = panels.indexOf(state.focusedPanel);
  const focusedPanel = panels[(index + direction + panels.length) % panels.length] ?? "input";
  return focusPanel(state, renderModel, focusedPanel);
}

type PanelDirection = "down" | "left" | "right" | "up";

function directionalPanelShortcut(input: string, key: WorkbenchTerminalKey): PanelDirection | null {
  if (key.ctrl || key.meta) return null;
  const ch = input.length === 1 ? input : "";
  const shifted = key.shift || (ch >= "A" && ch <= "Z");
  if (!shifted) return null;
  switch (ch.toLowerCase()) {
    case "w":
      return "up";
    case "a":
      return "left";
    case "s":
      return "down";
    case "d":
      return "right";
    default:
      return null;
  }
}

function focusDirectionalPanel(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  direction: PanelDirection,
) {
  const wide = renderModel.layout === "wide";
  const nextPanel = directionalPanelTarget(state.focusedPanel, direction, wide);
  return nextPanel === state.focusedPanel
    ? state
    : cycleToPanel(state, renderModel, nextPanel);
}

function directionalPanelTarget(
  panel: WorkbenchFocusedPanel,
  direction: PanelDirection,
  wide: boolean,
): WorkbenchFocusedPanel {
  if (!wide) {
    const order: WorkbenchFocusedPanel[] = ["header", "conversation", "workdir", "workspace", "transcript", "activity", "input"];
    const index = order.indexOf(panel);
    if (index < 0) return panel;
    if (direction === "up" || direction === "left") return order[Math.max(0, index - 1)] ?? panel;
    return order[Math.min(order.length - 1, index + 1)] ?? panel;
  }
  switch (panel) {
    case "header":
      return direction === "down" ? "conversation" : panel;
    case "conversation":
      if (direction === "down") return "workdir";
      if (direction === "right") return "transcript";
      if (direction === "up") return "header";
      return panel;
    case "workdir":
      if (direction === "up") return "conversation";
      if (direction === "down") return "workspace";
      if (direction === "right") return "transcript";
      return panel;
    case "workspace":
      if (direction === "up") return "workdir";
      if (direction === "right") return "transcript";
      if (direction === "down") return "input";
      return panel;
    case "transcript":
      if (direction === "left") return "conversation";
      if (direction === "right") return "activity";
      if (direction === "up") return "header";
      if (direction === "down") return "input";
      return panel;
    case "activity":
      if (direction === "left") return "transcript";
      if (direction === "down") return "input";
      if (direction === "up") return "header";
      return panel;
    case "input":
      return direction === "up" ? "transcript" : panel;
  }
}

function cycleToPanel(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  panel: WorkbenchFocusedPanel,
) {
  return focusPanel(state, renderModel, panel);
}

function focusPanel(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  focusedPanel: WorkbenchFocusedPanel,
): WorkbenchTerminalState {
  const next = {
    ...state,
    focusedPanel,
    selectionAnchor: focusedPanel === "input" ? state.selectionAnchor : null,
  };
  if (focusedPanel === "transcript") {
    const preferred = renderModel.transcript.endLine ? renderModel.transcript.endLine - 1 : 0;
    return setTranscriptCursor(next, renderModel, next.transcriptCursor.line || preferred, next.transcriptCursor.column, false);
  }
  if (focusedPanel === "activity") {
    return setActivityCursor(next, renderModel, next.activityCursor.line, next.activityCursor.column, false);
  }
  if (focusedPanel === "conversation") {
    return setConversationCursor(next, renderModel, next.conversationCursor.line, next.conversationCursor.column, false);
  }
  if (focusedPanel === "workspace") {
    return setWorkspaceCursor(next, renderModel, next.workspaceCursor.line, next.workspaceCursor.column, false);
  }
  if (focusedPanel === "header") {
    return setHeaderCursor(next, renderModel, next.headerCursor.line, next.headerCursor.column, false);
  }
  if (focusedPanel === "workdir") {
    return setWorkdirCursor(next, renderModel, next.workdirCursor.line, next.workdirCursor.column, false);
  }
  return next;
}

function scrollTranscript(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
): WorkbenchTerminalState {
  return {
    ...state,
    transcriptOffset: clamp(state.transcriptOffset + delta, 0, renderModel.transcript.maxOffset),
  };
}

function scrollTranscriptToTop(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  return { ...state, transcriptOffset: renderModel.transcript.maxOffset };
}

function scrollTranscriptToBottom(state: WorkbenchTerminalState): WorkbenchTerminalState {
  return { ...state, transcriptOffset: 0 };
}

function moveTranscriptCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setTranscriptCursor(state, renderModel, state.transcriptCursor.line + delta, state.transcriptCursor.column, selecting);
}

function setTranscriptCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  next: number,
  columnOrSelecting: number | boolean,
  selecting: boolean,
): WorkbenchTerminalState {
  const nextColumn = typeof columnOrSelecting === "number" ? columnOrSelecting : state.transcriptCursor.column;
  const shouldSelect = typeof columnOrSelecting === "number" ? selecting : columnOrSelecting;
  const current = state.transcriptCursor;
  const clamped = clamp(next, 0, Math.max(0, renderModel.transcript.totalLines - 1));
  const cursor = normalizePanelPosition({ line: clamped, column: nextColumn }, clamped, (line) => transcriptLineText(renderModel, line));
  return revealTranscriptLine({
    ...state,
    transcriptCursor: cursor,
    transcriptSelectionAnchor: shouldSelect ? state.transcriptSelectionAnchor ?? current : null,
  }, renderModel, cursor.line);
}

function moveTranscriptColumn(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: -1 | 1,
  selecting: boolean,
) {
  const cursor = movePanelColumn(
    state.transcriptCursor,
    delta,
    Math.max(0, renderModel.transcript.totalLines - 1),
    (line) => transcriptLineText(renderModel, line),
  );
  return setTranscriptCursor(state, renderModel, cursor.line, cursor.column, selecting);
}

function revealTranscriptLine(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  line: number,
): WorkbenchTerminalState {
  const total = renderModel.transcript.totalLines;
  const height = renderModel.transcript.viewportHeight;
  const currentStart = Math.max(0, total - height - state.transcriptOffset);
  const currentEnd = currentStart + height - 1;
  if (line >= currentStart && line <= currentEnd) return state;
  const nextStart = line < currentStart ? line : line - height + 1;
  const nextOffset = total - height - nextStart;
  return {
    ...state,
    transcriptOffset: clamp(nextOffset, 0, renderModel.transcript.maxOffset),
  };
}

function moveActivityCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setActivityCursor(state, renderModel, state.activityCursor.line + delta, state.activityCursor.column, selecting);
}

function moveConversationCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setConversationCursor(state, renderModel, state.conversationCursor.line + delta, state.conversationCursor.column, selecting);
}

function moveHeaderCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setHeaderCursor(state, renderModel, state.headerCursor.line + delta, state.headerCursor.column, selecting);
}

function moveWorkspaceCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setWorkspaceCursor(state, renderModel, state.workspaceCursor.line + delta, state.workspaceCursor.column, selecting);
}

function moveWorkdirCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setWorkdirCursor(state, renderModel, state.workdirCursor.line + delta, state.workdirCursor.column, selecting);
}

function setConversationCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  next: number,
  columnOrSelecting: number | boolean,
  selecting: boolean,
): WorkbenchTerminalState {
  const nextColumn = typeof columnOrSelecting === "number" ? columnOrSelecting : state.conversationCursor.column;
  const shouldSelect = typeof columnOrSelecting === "number" ? selecting : columnOrSelecting;
  const current = state.conversationCursor;
  const clamped = clamp(next, 0, Math.max(0, renderModel.conversation.lines.length - 1));
  const cursor = normalizePanelPosition({ line: clamped, column: nextColumn }, clamped, (line) => conversationLineText(renderModel, line));
  return {
    ...state,
    conversationCursor: cursor,
    conversationSelectionAnchor: shouldSelect ? state.conversationSelectionAnchor ?? current : null,
  };
}

function setHeaderCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  next: number,
  columnOrSelecting: number | boolean,
  selecting: boolean,
): WorkbenchTerminalState {
  const nextColumn = typeof columnOrSelecting === "number" ? columnOrSelecting : state.headerCursor.column;
  const shouldSelect = typeof columnOrSelecting === "number" ? selecting : columnOrSelecting;
  const current = state.headerCursor;
  const clamped = clamp(next, 0, Math.max(0, renderModel.header.lines.length - 1));
  const cursor = normalizePanelPosition({ line: clamped, column: nextColumn }, clamped, (line) => headerLineText(renderModel, line));
  return {
    ...state,
    headerCursor: cursor,
    headerSelectionAnchor: shouldSelect ? state.headerSelectionAnchor ?? current : null,
  };
}

function setWorkspaceCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  next: number,
  columnOrSelecting: number | boolean,
  selecting: boolean,
): WorkbenchTerminalState {
  const nextColumn = typeof columnOrSelecting === "number" ? columnOrSelecting : state.workspaceCursor.column;
  const shouldSelect = typeof columnOrSelecting === "number" ? selecting : columnOrSelecting;
  const current = state.workspaceCursor;
  const clamped = clamp(next, 0, Math.max(0, renderModel.workspace.lines.length - 1));
  const cursor = normalizePanelPosition({ line: clamped, column: nextColumn }, clamped, (line) => workspaceLineText(renderModel, line));
  return {
    ...state,
    workspaceCursor: cursor,
    workspaceSelectionAnchor: shouldSelect ? state.workspaceSelectionAnchor ?? current : null,
  };
}

function setWorkdirCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  next: number,
  columnOrSelecting: number | boolean,
  selecting: boolean,
): WorkbenchTerminalState {
  const nextColumn = typeof columnOrSelecting === "number" ? columnOrSelecting : state.workdirCursor.column;
  const shouldSelect = typeof columnOrSelecting === "number" ? selecting : columnOrSelecting;
  const current = state.workdirCursor;
  const clamped = clamp(next, 0, Math.max(0, renderModel.workdir.lines.length - 1));
  const cursor = normalizePanelPosition({ line: clamped, column: nextColumn }, clamped, (line) => workdirLineText(renderModel, line));
  return {
    ...state,
    workdirCursor: cursor,
    workdirSelectionAnchor: shouldSelect ? state.workdirSelectionAnchor ?? current : null,
  };
}

function moveConversationColumn(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: -1 | 1,
  selecting: boolean,
) {
  const cursor = movePanelColumn(
    state.conversationCursor,
    delta,
    Math.max(0, renderModel.conversation.lines.length - 1),
    (line) => conversationLineText(renderModel, line),
  );
  return setConversationCursor(state, renderModel, cursor.line, cursor.column, selecting);
}

function moveHeaderColumn(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: -1 | 1,
  selecting: boolean,
) {
  const cursor = movePanelColumn(
    state.headerCursor,
    delta,
    Math.max(0, renderModel.header.lines.length - 1),
    (line) => headerLineText(renderModel, line),
  );
  return setHeaderCursor(state, renderModel, cursor.line, cursor.column, selecting);
}

function moveWorkspaceColumn(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: -1 | 1,
  selecting: boolean,
) {
  const cursor = movePanelColumn(
    state.workspaceCursor,
    delta,
    Math.max(0, renderModel.workspace.lines.length - 1),
    (line) => workspaceLineText(renderModel, line),
  );
  return setWorkspaceCursor(state, renderModel, cursor.line, cursor.column, selecting);
}

function moveWorkdirColumn(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: -1 | 1,
  selecting: boolean,
) {
  const cursor = movePanelColumn(
    state.workdirCursor,
    delta,
    Math.max(0, renderModel.workdir.lines.length - 1),
    (line) => workdirLineText(renderModel, line),
  );
  return setWorkdirCursor(state, renderModel, cursor.line, cursor.column, selecting);
}

function setActivityCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  next: number,
  columnOrSelecting: number | boolean,
  selecting: boolean,
): WorkbenchTerminalState {
  const nextColumn = typeof columnOrSelecting === "number" ? columnOrSelecting : state.activityCursor.column;
  const shouldSelect = typeof columnOrSelecting === "number" ? selecting : columnOrSelecting;
  const current = state.activityCursor;
  const clamped = clamp(next, 0, Math.max(0, renderModel.visibleActivities.length - 1));
  const cursor = normalizePanelPosition({ line: clamped, column: nextColumn }, clamped, (line) => activityLineText(renderModel, line));
  return {
    ...state,
    activityCursor: cursor,
    activitySelectionAnchor: shouldSelect ? state.activitySelectionAnchor ?? current : null,
  };
}

function moveActivityColumn(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: -1 | 1,
  selecting: boolean,
) {
  const cursor = movePanelColumn(
    state.activityCursor,
    delta,
    Math.max(0, renderModel.visibleActivities.length - 1),
    (line) => activityLineText(renderModel, line),
  );
  return setActivityCursor(state, renderModel, cursor.line, cursor.column, selecting);
}

function selectTranscriptAll(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (renderModel.transcript.totalLines === 0) return state;
  const line = renderModel.transcript.totalLines - 1;
  return revealTranscriptLine({
    ...state,
    transcriptSelectionAnchor: { column: 0, line: 0 },
    transcriptCursor: { column: transcriptLineText(renderModel, line).length, line },
  }, renderModel, line);
}

function selectActivityAll(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (renderModel.visibleActivities.length === 0) return state;
  const line = renderModel.visibleActivities.length - 1;
  return {
    ...state,
    activitySelectionAnchor: { column: 0, line: 0 },
    activityCursor: { column: activityLineText(renderModel, line).length, line },
  };
}

function selectConversationAll(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (renderModel.conversation.lines.length === 0) return state;
  const line = renderModel.conversation.lines.length - 1;
  return {
    ...state,
    conversationSelectionAnchor: { column: 0, line: 0 },
    conversationCursor: { column: conversationLineText(renderModel, line).length, line },
  };
}

function selectHeaderAll(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (renderModel.header.lines.length === 0) return state;
  const line = renderModel.header.lines.length - 1;
  return {
    ...state,
    headerSelectionAnchor: { column: 0, line: 0 },
    headerCursor: { column: headerLineText(renderModel, line).length, line },
  };
}

function selectWorkspaceAll(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (renderModel.workspace.lines.length === 0) return state;
  const line = renderModel.workspace.lines.length - 1;
  return {
    ...state,
    workspaceSelectionAnchor: { column: 0, line: 0 },
    workspaceCursor: { column: workspaceLineText(renderModel, line).length, line },
  };
}

function selectWorkdirAll(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalState {
  if (renderModel.workdir.lines.length === 0) return state;
  const line = renderModel.workdir.lines.length - 1;
  return {
    ...state,
    workdirSelectionAnchor: { column: 0, line: 0 },
    workdirCursor: { column: workdirLineText(renderModel, line).length, line },
  };
}

function stateResult(state: WorkbenchTerminalState, ...effects: WorkbenchTerminalEffect[]): WorkbenchTerminalResult {
  return { state, effects };
}

function handleMouseEvent(
  event: WorkbenchTerminalMouseEvent,
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
): WorkbenchTerminalResult {
  const target = state.mouseDragPanel && event.kind !== "press"
    ? mouseTargetForPanel(state.mouseDragPanel, event, renderModel)
    : mouseTarget(event, renderModel);
  if (!target) return stateResult(state);
  if (event.kind === "wheel") {
    if (target.panel !== "transcript") return stateResult({ ...state, focusedPanel: target.panel });
    const delta = event.button === "wheel_up"
      ? Math.max(1, Math.floor(renderModel.transcript.viewportHeight / 3))
      : -Math.max(1, Math.floor(renderModel.transcript.viewportHeight / 3));
    return stateResult(scrollTranscript({ ...state, focusedPanel: "transcript" }, renderModel, delta));
  }
  if (event.kind === "release") return stateResult(endMouseDrag(state));
  if (event.kind === "press" && event.button === "right") {
    return handleRightClick(state, target);
  }
  if (event.button !== "left") return stateResult(state);
  if (event.kind === "motion") return stateResult(state);
  switch (target.panel) {
    case "header":
      return stateResult(setHeaderCursor(
        { ...state, focusedPanel: "header", headerSelectionAnchor: null },
        renderModel,
        target.line,
        target.column,
        false,
      ));
    case "activity":
      return stateResult(setActivityCursor(
        { ...state, focusedPanel: "activity", activitySelectionAnchor: null },
        renderModel,
        target.line,
        target.column,
        false,
      ));
    case "conversation":
      return stateResult(setConversationCursor(
        { ...state, focusedPanel: "conversation", conversationSelectionAnchor: null },
        renderModel,
        target.line,
        target.column,
        false,
      ));
    case "input":
      return stateResult({
        ...state,
        cursor: target.inputCursor,
        focusedPanel: "input",
        mouseDragPanel: null,
        selectionAnchor: null,
      });
    case "transcript":
      return stateResult(setTranscriptCursor(
        { ...state, focusedPanel: "transcript", transcriptSelectionAnchor: null },
        renderModel,
        target.line,
        target.column,
        false,
      ));
    case "workspace":
      return stateResult(setWorkspaceCursor(
        { ...state, focusedPanel: "workspace", workspaceSelectionAnchor: null },
        renderModel,
        target.line,
        target.column,
        false,
      ));
    case "workdir":
      return stateResult(setWorkdirCursor(
        { ...state, focusedPanel: "workdir", workdirSelectionAnchor: null },
        renderModel,
        target.line,
        target.column,
        false,
      ));
  }
}

function handleRightClick(
  state: WorkbenchTerminalState,
  target: MouseTarget,
): WorkbenchTerminalResult {
  switch (target.panel) {
    case "activity":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "activity" }, "activity");
    case "conversation":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "conversation" }, "conversation");
    case "workspace":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "workspace" }, "workspace");
    case "header":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "header" }, "header");
    case "input":
      return stateResult({ ...state, cursor: target.inputCursor, focusedPanel: "input" }, { type: "paste" });
    case "transcript":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "transcript" }, "page");
    case "workdir":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "workdir" }, "workdir");
  }
}

function rightClickCopyIfSelected(
  state: WorkbenchTerminalState,
  target: WorkbenchCopyTarget,
): WorkbenchTerminalResult {
  if (state.focusedPanel === "activity" && selectedPanelRange(state.activitySelectionAnchor, state.activityCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "conversation" && selectedPanelRange(state.conversationSelectionAnchor, state.conversationCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "header" && selectedPanelRange(state.headerSelectionAnchor, state.headerCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "workspace" && selectedPanelRange(state.workspaceSelectionAnchor, state.workspaceCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "transcript" && selectedPanelRange(state.transcriptSelectionAnchor, state.transcriptCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "workdir" && selectedPanelRange(state.workdirSelectionAnchor, state.workdirCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  return stateResult(state);
}

function endMouseDrag(state: WorkbenchTerminalState): WorkbenchTerminalState {
  const next = { ...state, mouseDragPanel: null };
  if (samePositionOrNull(next.activitySelectionAnchor, next.activityCursor)) {
    next.activitySelectionAnchor = null;
  }
  if (samePositionOrNull(next.conversationSelectionAnchor, next.conversationCursor)) {
    next.conversationSelectionAnchor = null;
  }
  if (next.selectionAnchor === next.cursor) {
    next.selectionAnchor = null;
  }
  if (samePositionOrNull(next.headerSelectionAnchor, next.headerCursor)) {
    next.headerSelectionAnchor = null;
  }
  if (samePositionOrNull(next.transcriptSelectionAnchor, next.transcriptCursor)) {
    next.transcriptSelectionAnchor = null;
  }
  if (samePositionOrNull(next.workspaceSelectionAnchor, next.workspaceCursor)) {
    next.workspaceSelectionAnchor = null;
  }
  if (samePositionOrNull(next.workdirSelectionAnchor, next.workdirCursor)) {
    next.workdirSelectionAnchor = null;
  }
  return next;
}

type MouseTarget =
  | { panel: "activity"; column: number; line: number }
  | { panel: "conversation"; column: number; line: number }
  | { panel: "header"; column: number; line: number }
  | { inputCursor: number; panel: "input" }
  | { panel: "transcript"; column: number; line: number }
  | { panel: "workspace"; column: number; line: number }
  | { panel: "workdir"; column: number; line: number };

function mouseTarget(event: WorkbenchTerminalMouseEvent, renderModel: WorkbenchRenderModel): MouseTarget | null {
  const layout = mouseLayout(renderModel);
  const row = event.row;
  const column = event.column;
  if (row >= layout.header.top && row <= layout.header.bottom) {
    const line = clamp(row - layout.header.textTop, 0, Math.max(0, renderModel.header.lines.length - 1));
    return {
      panel: "header",
      line,
      column: textIndexAtMouseColumn(headerLineText(renderModel, line), column - layout.header.textLeft),
    };
  }
  if (renderModel.layout === "wide" && column <= layout.side.right && row >= layout.side.top && row <= layout.side.bottom) {
    if (row <= layout.conversation.bottom) {
      const line = clamp(row - layout.conversation.textTop, 0, Math.max(0, renderModel.conversation.lines.length - 1));
      return {
        panel: "conversation",
        line,
        column: textIndexAtMouseColumn(conversationLineText(renderModel, line), column - layout.conversation.textLeft),
      };
    }
    if (row >= layout.workspace.top && row <= layout.workspace.bottom) {
      const line = clamp(row - layout.workspace.textTop, 0, Math.max(0, renderModel.workspace.lines.length - 1));
      return {
        panel: "workspace",
        line,
        column: textIndexAtMouseColumn(workspaceLineText(renderModel, line), column - layout.workspace.textLeft),
      };
    }
    const line = clamp(row - layout.workdir.textTop, 0, Math.max(0, renderModel.workdir.lines.length - 1));
    return {
      panel: "workdir",
      line,
      column: textIndexAtMouseColumn(workdirLineText(renderModel, line), column - layout.workdir.textLeft),
    };
  }
  if (row >= layout.transcript.top && row <= layout.transcript.bottom) {
    if (renderModel.layout === "wide" && column >= layout.activity.left) {
      const line = clamp(row - layout.activity.top - 2, 0, Math.max(0, renderModel.visibleActivities.length - 1));
      return {
        panel: "activity",
        line,
        column: textIndexAtMouseColumn(activityLineText(renderModel, line), column - layout.activity.textLeft),
      };
    }
    const line = renderModel.transcript.startLine + row - layout.transcript.top - 1;
    return {
      panel: "transcript",
      line: clamp(line, 0, Math.max(0, renderModel.transcript.totalLines - 1)),
      column: textIndexAtMouseColumn(transcriptLineText(renderModel, line), column - layout.transcript.textLeft),
    };
  }
  if (renderModel.layout === "compact" && row >= layout.activity.top && row <= layout.activity.bottom) {
    const line = clamp(row - layout.activity.top - 2, 0, Math.max(0, renderModel.visibleActivities.length - 1));
    return {
      panel: "activity",
      line,
      column: textIndexAtMouseColumn(activityLineText(renderModel, line), column - layout.activity.textLeft),
    };
  }
  if (row >= layout.input.textTop && row <= layout.input.textBottom) {
    const line = renderModel.input.lines[row - layout.input.textTop];
    if (!line) return { inputCursor: renderModel.input.cursor, panel: "input" };
    const columnIndex = textIndexAtMouseColumn(line.text, column - layout.input.textLeft);
    return {
      panel: "input",
      inputCursor: clamp(line.start + columnIndex, line.start, line.end),
    };
  }
  if (row >= layout.input.top && row <= layout.input.bottom) {
    return { inputCursor: renderModel.input.cursor, panel: "input" };
  }
  return null;
}

function mouseTargetForPanel(
  panel: WorkbenchFocusedPanel,
  event: WorkbenchTerminalMouseEvent,
  renderModel: WorkbenchRenderModel,
): MouseTarget | null {
  const layout = mouseLayout(renderModel);
  switch (panel) {
    case "activity": {
      const line = clamp(event.row - layout.activity.top - 2, 0, Math.max(0, renderModel.visibleActivities.length - 1));
      return {
        panel,
        line,
        column: textIndexAtMouseColumn(activityLineText(renderModel, line), event.column - layout.activity.textLeft),
      };
    }
    case "conversation": {
      const line = clamp(event.row - layout.conversation.textTop, 0, Math.max(0, renderModel.conversation.lines.length - 1));
      return {
        panel,
        line,
        column: textIndexAtMouseColumn(conversationLineText(renderModel, line), event.column - layout.conversation.textLeft),
      };
    }
    case "input": {
      const row = clamp(event.row, layout.input.textTop, layout.input.textBottom);
      const line = renderModel.input.lines[row - layout.input.textTop];
      if (!line) return { inputCursor: renderModel.input.cursor, panel };
      const columnIndex = textIndexAtMouseColumn(line.text, event.column - layout.input.textLeft);
      return {
        panel,
        inputCursor: clamp(line.start + columnIndex, line.start, line.end),
      };
    }
    case "header":
      {
        const line = clamp(event.row - layout.header.textTop, 0, Math.max(0, renderModel.header.lines.length - 1));
        return {
          panel,
          line,
          column: textIndexAtMouseColumn(headerLineText(renderModel, line), event.column - layout.header.textLeft),
        };
      }
    case "transcript": {
      const line = clamp(
        renderModel.transcript.startLine + event.row - layout.transcript.top - 1,
        0,
        Math.max(0, renderModel.transcript.totalLines - 1),
      );
      return {
        panel,
        line,
        column: textIndexAtMouseColumn(transcriptLineText(renderModel, line), event.column - layout.transcript.textLeft),
      };
    }
    case "workspace": {
      const line = clamp(event.row - layout.workspace.textTop, 0, Math.max(0, renderModel.workspace.lines.length - 1));
      return {
        panel,
        line,
        column: textIndexAtMouseColumn(workspaceLineText(renderModel, line), event.column - layout.workspace.textLeft),
      };
    }
    case "workdir": {
      const line = clamp(event.row - layout.workdir.textTop, 0, Math.max(0, renderModel.workdir.lines.length - 1));
      return {
        panel,
        line,
        column: textIndexAtMouseColumn(workdirLineText(renderModel, line), event.column - layout.workdir.textLeft),
      };
    }
  }
}

function mouseLayout(renderModel: WorkbenchRenderModel) {
  const headerHeight = 6;
  const transcriptTop = headerHeight + 1;
  const transcriptBottom = transcriptTop + renderModel.transcript.viewportHeight + 2;
  const inputTop = transcriptBottom + 1;
  const inputBottom = inputTop + renderModel.input.height + 2;
  const sidePanelWidth = renderModel.layout === "wide" ? renderModel.workdirPanelWidth + 1 : 0;
  const transcriptPanelWidth = renderModel.layout === "wide"
    ? Math.max(1, renderModel.terminalColumns - sidePanelWidth - Math.floor(renderModel.terminalColumns * 0.27) - 1)
    : renderModel.terminalColumns;
  const transcriptLeft = renderModel.layout === "wide" ? sidePanelWidth + 1 : 1;
  const activityLeft = renderModel.layout === "wide" ? sidePanelWidth + transcriptPanelWidth + 1 : 1;
  const activityTop = renderModel.layout === "wide" ? transcriptTop : transcriptBottom + 1;
  const activityBottom = renderModel.layout === "wide" ? transcriptBottom : activityTop + renderModel.activityHeight - 1;
  const conversationTop = transcriptTop;
  const conversationBottom = conversationTop + renderModel.conversationHeight - 1;
  const workdirTop = conversationBottom + 2;
  const workdirBottom = workdirTop + renderModel.workdirHeight - 1;
  const workspaceTop = workdirBottom + 2;
  const workspaceBottom = transcriptBottom;
  return {
    header: {
      bottom: headerHeight,
      textLeft: 3,
      textTop: 2,
      top: 1,
    },
    activity: {
      bottom: activityBottom,
      left: activityLeft,
      textLeft: activityLeft + 4,
      top: activityTop,
    },
    conversation: {
      bottom: conversationBottom,
      textLeft: 4,
      textTop: conversationTop + 2,
      top: conversationTop,
    },
    input: {
      bottom: inputBottom,
      textBottom: inputTop + renderModel.input.height + 1,
      textLeft: 3,
      textTop: inputTop + 2,
      top: inputTop,
    },
    transcript: {
      bottom: transcriptBottom,
      textLeft: transcriptLeft + 2,
      top: transcriptTop,
    },
    side: {
      bottom: workspaceBottom,
      right: renderModel.workdirPanelWidth,
      top: conversationTop,
    },
    workspace: {
      bottom: workspaceBottom,
      textLeft: 4,
      textTop: workspaceTop + 2,
      top: workspaceTop,
    },
    workdir: {
      bottom: workdirBottom,
      textLeft: 4,
      textTop: workdirTop + 2,
      top: workdirTop,
    },
  };
}

function textIndexAtMouseColumn(text: string, column: number) {
  return indexAtDisplayColumn(text, Math.max(0, column - 1));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function normalizePanelPosition(
  position: WorkbenchPanelPosition,
  maxLine: number,
  textAtLine: (line: number) => string,
): WorkbenchPanelPosition {
  const line = clamp(position.line, 0, maxLine);
  return {
    line,
    column: clamp(position.column, 0, textAtLine(line).length),
  };
}

function movePanelColumn(
  position: WorkbenchPanelPosition,
  delta: -1 | 1,
  maxLine: number,
  textAtLine: (line: number) => string,
): WorkbenchPanelPosition {
  const current = normalizePanelPosition(position, maxLine, textAtLine);
  if (delta < 0) {
    if (current.column > 0) return { ...current, column: current.column - 1 };
    if (current.line <= 0) return current;
    const line = current.line - 1;
    return { line, column: textAtLine(line).length };
  }
  const currentLength = textAtLine(current.line).length;
  if (current.column < currentLength) return { ...current, column: current.column + 1 };
  if (current.line >= maxLine) return current;
  return { line: current.line + 1, column: 0 };
}

function comparePosition(a: WorkbenchPanelPosition, b: WorkbenchPanelPosition) {
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

function samePosition(a: WorkbenchPanelPosition, b: WorkbenchPanelPosition) {
  return a.line === b.line && a.column === b.column;
}

function samePositionOrNull(a: WorkbenchPanelPosition | null, b: WorkbenchPanelPosition) {
  return a !== null && samePosition(a, b);
}

function transcriptLineText(renderModel: WorkbenchRenderModel, line: number) {
  return renderModel.transcript.lines[line]?.text ?? "";
}

function activityLineText(renderModel: WorkbenchRenderModel, line: number) {
  const activity = renderModel.visibleActivities[line];
  return activity ? `${new Date(activity.timestamp).toLocaleTimeString()} ${activity.text}` : "";
}

function conversationLineText(renderModel: WorkbenchRenderModel, line: number) {
  return renderModel.conversation.lines[line] ?? "";
}

function headerLineText(renderModel: WorkbenchRenderModel, line: number) {
  return renderModel.header.lines[line] ?? "";
}

function workspaceLineText(renderModel: WorkbenchRenderModel, line: number) {
  return renderModel.workspace.lines[line] ?? "";
}

function workdirLineText(renderModel: WorkbenchRenderModel, line: number) {
  return renderModel.workdir.lines[line] ?? "";
}

function workspaceIDFromLine(line: string) {
  const trimmed = line.trim().replace(/^\*\s*/, "");
  const [id = ""] = trimmed.split(/\s+/);
  return id.endsWith("...") ? "" : id;
}
