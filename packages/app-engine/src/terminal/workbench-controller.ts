import type { WorkbenchCopyTarget } from "../workbench/state.js";
import type { WorkbenchInputEffect, WorkbenchInputKey } from "./input-controller.js";
import { createWorkbenchInputController } from "./input-controller.js";
import type { WorkbenchRenderModel } from "./render-model.js";
import { indexAtDisplayColumn } from "./text-layout.js";

export type WorkbenchFocusedPanel = "header" | "input" | "transcript" | "activity";

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
}

export type WorkbenchTerminalEffect =
  | WorkbenchInputEffect
  | { type: "copy"; target: WorkbenchCopyTarget }
  | { type: "paste" };

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
  const maxHeaderIndex = Math.max(0, renderModel.header.lines.length - 1);
  const draftLength = state.draft.length;
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
    if (state.focusedPanel === "header" && state.headerSelectionAnchor !== null) {
      return stateResult({ ...state, headerSelectionAnchor: null });
    }
    return stateResult({ ...state, focusedPanel: "input" });
  }
  if (key.ctrl && input === "a") {
    if (state.focusedPanel === "transcript") return stateResult(selectTranscriptAll(state, renderModel));
    if (state.focusedPanel === "activity") return stateResult(selectActivityAll(state, renderModel));
    if (state.focusedPanel === "header") return stateResult(selectHeaderAll(state, renderModel));
  }
  if (key.meta && input.toLowerCase() === "c") {
    const target: WorkbenchCopyTarget = state.focusedPanel === "activity"
      ? "activity"
      : state.focusedPanel === "header"
        ? "header"
        : "page";
    return { state, effects: [{ type: "copy", target }] };
  }
  if (state.focusedPanel === "transcript") {
    return stateResult(handleTranscriptPanelKey(key, state, renderModel));
  }
  if (state.focusedPanel === "header") return stateResult(handleHeaderPanelKey(key, state, renderModel));
  return stateResult(handleActivityPanelKey(key, state, renderModel));
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
  const panels: WorkbenchFocusedPanel[] = ["input", "header", "transcript", "activity"];
  const index = panels.indexOf(state.focusedPanel);
  const focusedPanel = panels[(index + direction + panels.length) % panels.length] ?? "input";
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
  if (focusedPanel === "header") {
    return setHeaderCursor(next, renderModel, next.headerCursor.line, next.headerCursor.column, false);
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

function moveHeaderCursor(
  state: WorkbenchTerminalState,
  renderModel: WorkbenchRenderModel,
  delta: number,
  selecting: boolean,
) {
  return setHeaderCursor(state, renderModel, state.headerCursor.line + delta, state.headerCursor.column, selecting);
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
  }
}

function handleRightClick(
  state: WorkbenchTerminalState,
  target: MouseTarget,
): WorkbenchTerminalResult {
  switch (target.panel) {
    case "activity":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "activity" }, "activity");
    case "header":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "header" }, "header");
    case "input":
      return stateResult({ ...state, cursor: target.inputCursor, focusedPanel: "input" }, { type: "paste" });
    case "transcript":
      return rightClickCopyIfSelected({ ...state, focusedPanel: "transcript" }, "page");
  }
}

function rightClickCopyIfSelected(
  state: WorkbenchTerminalState,
  target: WorkbenchCopyTarget,
): WorkbenchTerminalResult {
  if (state.focusedPanel === "activity" && selectedPanelRange(state.activitySelectionAnchor, state.activityCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "header" && selectedPanelRange(state.headerSelectionAnchor, state.headerCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  if (state.focusedPanel === "transcript" && selectedPanelRange(state.transcriptSelectionAnchor, state.transcriptCursor)) {
    return stateResult(state, { type: "copy", target });
  }
  return stateResult(state);
}

function endMouseDrag(state: WorkbenchTerminalState): WorkbenchTerminalState {
  const next = { ...state, mouseDragPanel: null };
  if (samePositionOrNull(next.activitySelectionAnchor, next.activityCursor)) {
    next.activitySelectionAnchor = null;
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
  return next;
}

type MouseTarget =
  | { panel: "activity"; column: number; line: number }
  | { panel: "header"; column: number; line: number }
  | { inputCursor: number; panel: "input" }
  | { panel: "transcript"; column: number; line: number };

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
  }
}

function mouseLayout(renderModel: WorkbenchRenderModel) {
  const headerHeight = 6;
  const transcriptTop = headerHeight + 1;
  const transcriptBottom = transcriptTop + renderModel.transcript.viewportHeight + 1;
  const inputTop = transcriptBottom + 1;
  const inputBottom = inputTop + renderModel.input.height + 2;
  const transcriptPanelWidth = renderModel.layout === "wide"
    ? Math.max(1, Math.floor(renderModel.terminalColumns * 0.72))
    : renderModel.terminalColumns;
  const activityLeft = renderModel.layout === "wide" ? transcriptPanelWidth + 1 : 1;
  const activityTop = renderModel.layout === "wide" ? transcriptTop : transcriptBottom + 1;
  const activityBottom = renderModel.layout === "wide" ? transcriptBottom : activityTop + renderModel.activityHeight - 1;
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
    input: {
      bottom: inputBottom,
      textBottom: inputTop + renderModel.input.height + 1,
      textLeft: 3,
      textTop: inputTop + 2,
      top: inputTop,
    },
    transcript: {
      bottom: transcriptBottom,
      textLeft: 3,
      top: transcriptTop,
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

function headerLineText(renderModel: WorkbenchRenderModel, line: number) {
  return renderModel.header.lines[line] ?? "";
}
