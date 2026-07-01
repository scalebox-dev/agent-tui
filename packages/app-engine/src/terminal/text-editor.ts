import { moveCursorVisualLineBoundary, moveCursorVisualRow } from "./text-layout.js";

export interface TextEditorState {
  cursor: number;
  selectionAnchor: number | null;
  text: string;
}

export interface TextEditorLayout {
  viewportColumns: number;
}

export type TextEditorMovement =
  | "documentEnd"
  | "left"
  | "right"
  | "visualDown"
  | "visualLineEnd"
  | "visualLineStart"
  | "visualUp";

export function normalizeTextEditorState(state: TextEditorState): TextEditorState {
  const cursor = clampCursor(state.cursor, state.text);
  const selectionAnchor = state.selectionAnchor === null || state.selectionAnchor === cursor
    ? null
    : clampCursor(state.selectionAnchor, state.text);
  return { cursor, selectionAnchor, text: state.text };
}

export function moveTextEditorCursor(
  state: TextEditorState,
  movement: TextEditorMovement,
  layout: TextEditorLayout,
  selecting: boolean,
): TextEditorState {
  const current = normalizeTextEditorState(state);
  const nextCursor = movementCursor(current, movement, layout);
  return normalizeTextEditorState({
    text: current.text,
    cursor: nextCursor,
    selectionAnchor: selecting ? current.selectionAnchor ?? current.cursor : null,
  });
}

export function selectAllText(state: TextEditorState): TextEditorState {
  const current = normalizeTextEditorState(state);
  return normalizeTextEditorState({
    text: current.text,
    cursor: current.text.length,
    selectionAnchor: current.text ? 0 : null,
  });
}

export function insertText(state: TextEditorState, input: string): TextEditorState {
  const current = normalizeTextEditorState(state);
  const normalizedInput = normalizeInsertedText(input);
  const selected = selectedRange(current);
  if (selected) {
    const text = `${current.text.slice(0, selected.start)}${normalizedInput}${current.text.slice(selected.end)}`;
    return normalizeTextEditorState({ text, cursor: selected.start + normalizedInput.length, selectionAnchor: null });
  }
  const text = `${current.text.slice(0, current.cursor)}${normalizedInput}${current.text.slice(current.cursor)}`;
  return normalizeTextEditorState({ text, cursor: current.cursor + normalizedInput.length, selectionAnchor: null });
}

export function deleteTextBeforeCursor(state: TextEditorState): TextEditorState {
  const current = normalizeTextEditorState(state);
  const selected = selectedRange(current);
  if (selected) {
    return normalizeTextEditorState({
      text: `${current.text.slice(0, selected.start)}${current.text.slice(selected.end)}`,
      cursor: selected.start,
      selectionAnchor: null,
    });
  }
  if (current.cursor <= 0) return current;
  return normalizeTextEditorState({
    text: `${current.text.slice(0, current.cursor - 1)}${current.text.slice(current.cursor)}`,
    cursor: current.cursor - 1,
    selectionAnchor: null,
  });
}

export function deleteTextAtCursor(state: TextEditorState): TextEditorState {
  const current = normalizeTextEditorState(state);
  const selected = selectedRange(current);
  if (selected) {
    return normalizeTextEditorState({
      text: `${current.text.slice(0, selected.start)}${current.text.slice(selected.end)}`,
      cursor: selected.start,
      selectionAnchor: null,
    });
  }
  if (current.cursor >= current.text.length) return current;
  return normalizeTextEditorState({
    text: `${current.text.slice(0, current.cursor)}${current.text.slice(current.cursor + 1)}`,
    cursor: current.cursor,
    selectionAnchor: null,
  });
}

function movementCursor(state: TextEditorState, movement: TextEditorMovement, layout: TextEditorLayout) {
  switch (movement) {
    case "documentEnd":
      return state.text.length;
    case "left":
      return Math.max(0, state.cursor - 1);
    case "right":
      return Math.min(state.text.length, state.cursor + 1);
    case "visualDown":
      return moveCursorVisualRow(state.text, state.cursor, layout.viewportColumns, 1);
    case "visualLineEnd":
      return moveCursorVisualLineBoundary(state.text, state.cursor, layout.viewportColumns, "end");
    case "visualLineStart":
      return moveCursorVisualLineBoundary(state.text, state.cursor, layout.viewportColumns, "start");
    case "visualUp":
      return moveCursorVisualRow(state.text, state.cursor, layout.viewportColumns, -1);
  }
}

function selectedRange(state: TextEditorState) {
  if (state.selectionAnchor === null || state.selectionAnchor === state.cursor) return null;
  return {
    start: Math.min(state.cursor, state.selectionAnchor),
    end: Math.max(state.cursor, state.selectionAnchor),
  };
}

function clampCursor(cursor: number, text: string) {
  return Math.max(0, Math.min(text.length, cursor));
}

function normalizeInsertedText(input: string) {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
