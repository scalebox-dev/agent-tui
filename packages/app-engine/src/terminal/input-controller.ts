import { createInputHistory } from "../workbench/state.js";
import { moveCursorVisualRow } from "./text-layout.js";

export interface WorkbenchInputKey {
  backspace?: boolean;
  ctrl?: boolean;
  delete?: boolean;
  downArrow?: boolean;
  end?: boolean;
  escape?: boolean;
  home?: boolean;
  leftArrow?: boolean;
  meta?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
  return?: boolean;
  rightArrow?: boolean;
  shift?: boolean;
  upArrow?: boolean;
}

export type WorkbenchInputEffect =
  | { type: "exit" }
  | { type: "scroll"; delta: number }
  | { type: "scroll_top" }
  | { type: "scroll_bottom" }
  | { type: "abort" }
  | { type: "submit"; input: string }
  | { type: "ignored_busy" };

export interface WorkbenchInputResult {
  cursor: number;
  draft: string;
  effects: WorkbenchInputEffect[];
  selectionAnchor: number | null;
}

export interface WorkbenchInputContext {
  busy: boolean;
  cursor?: number;
  draft: string;
  selectionAnchor?: number | null;
  viewportColumns?: number;
  viewportHeight: number;
}

export interface WorkbenchInputController {
  handle(input: string, key: WorkbenchInputKey, context: WorkbenchInputContext): WorkbenchInputResult;
}

export function createWorkbenchInputController(): WorkbenchInputController {
  const history = createInputHistory();

  return {
    handle(input, key, context) {
      const cursor = clampCursor(context.cursor ?? context.draft.length, context.draft);
      const selectionAnchor = context.selectionAnchor ?? null;
      const viewportColumns = context.viewportColumns ?? 80;
      if (key.ctrl && input === "c") return result(context.draft, cursor, null, { type: "exit" });
      if (key.pageUp || (key.ctrl && input === "u")) {
        return result(context.draft, cursor, null, { type: "scroll", delta: Math.max(1, Math.floor(context.viewportHeight / 2)) });
      }
      if (key.pageDown || (key.ctrl && input === "d")) {
        return result(context.draft, cursor, null, { type: "scroll", delta: -Math.max(1, Math.floor(context.viewportHeight / 2)) });
      }
      if (key.ctrl && key.upArrow) return historyResult(history.previous(context.draft));
      if (key.ctrl && key.downArrow) return historyResult(history.next(context.draft));
      if (key.ctrl && input === "a") return navigationResult(context.draft, cursor, 0, key, selectionAnchor);
      if (key.ctrl && input === "e") return navigationResult(context.draft, cursor, context.draft.length, key, selectionAnchor);
      if (key.home) return navigationResult(context.draft, cursor, lineStart(context.draft, cursor), key, selectionAnchor);
      if (key.end) return navigationResult(context.draft, cursor, lineEnd(context.draft, cursor), key, selectionAnchor);
      if (key.leftArrow) return navigationResult(context.draft, cursor, Math.max(0, cursor - 1), key, selectionAnchor);
      if (key.rightArrow) return navigationResult(context.draft, cursor, Math.min(context.draft.length, cursor + 1), key, selectionAnchor);
      if (key.upArrow) return navigationResult(context.draft, cursor, moveCursorVisualRow(context.draft, cursor, viewportColumns, -1), key, selectionAnchor);
      if (key.downArrow) return navigationResult(context.draft, cursor, moveCursorVisualRow(context.draft, cursor, viewportColumns, 1), key, selectionAnchor);

      if (context.busy) {
        return handleBusyInput(input, key, context.draft, cursor, selectionAnchor, history);
      }
      return handleReadyInput(input, key, context.draft, cursor, selectionAnchor, history);
    },
  };
}

function handleBusyInput(
  input: string,
  key: WorkbenchInputKey,
  draft: string,
  cursor: number,
  selectionAnchor: number | null,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.escape) return result(draft, cursor, null, { type: "abort" });
  if (key.return) {
    const command = draft.trim();
    history.record(command);
    if (command === "/abort" || command === "/cancel") return result("", 0, null, { type: "abort" });
    if (command) return result("", 0, null, { type: "ignored_busy" });
    return result("", 0, null);
  }
  if (key.backspace) {
    history.reset();
    return deleteBeforeCursor(draft, cursor, selectionAnchor);
  }
  if (key.delete) {
    history.reset();
    return cursor >= draft.length ? deleteBeforeCursor(draft, cursor, selectionAnchor) : deleteAtCursor(draft, cursor, selectionAnchor);
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return insertAtCursor(draft, cursor, input, selectionAnchor);
  }
  return result(draft, cursor, selectionAnchor);
}

function handleReadyInput(
  input: string,
  key: WorkbenchInputKey,
  draft: string,
  cursor: number,
  selectionAnchor: number | null,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.return) {
    if (key.meta) {
      history.reset();
      return insertAtCursor(draft, cursor, "\n", selectionAnchor);
    }
    const prompt = draft.trim();
    if (!prompt) return result(draft, cursor, selectionAnchor);
    history.record(prompt);
    return result("", 0, null, { type: "submit", input: prompt });
  }
  if (key.backspace) {
    history.reset();
    return deleteBeforeCursor(draft, cursor, selectionAnchor);
  }
  if (key.delete) {
    history.reset();
    return cursor >= draft.length ? deleteBeforeCursor(draft, cursor, selectionAnchor) : deleteAtCursor(draft, cursor, selectionAnchor);
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return insertAtCursor(draft, cursor, input, selectionAnchor);
  }
  return result(draft, cursor, selectionAnchor);
}

function result(draft: string, cursor: number, selectionAnchor: number | null, ...effects: WorkbenchInputEffect[]): WorkbenchInputResult {
  const nextCursor = clampCursor(cursor, draft);
  const nextAnchor = selectionAnchor === null || selectionAnchor === nextCursor ? null : clampCursor(selectionAnchor, draft);
  return { cursor: nextCursor, draft, effects, selectionAnchor: nextAnchor };
}

function historyResult(draft: string): WorkbenchInputResult {
  return result(draft, draft.length, null);
}

function navigationResult(draft: string, cursor: number, nextCursor: number, key: WorkbenchInputKey, selectionAnchor: number | null) {
  const nextAnchor = key.shift ? selectionAnchor ?? cursor : null;
  return result(draft, nextCursor, nextAnchor);
}

function insertAtCursor(draft: string, cursor: number, input: string, selectionAnchor: number | null): WorkbenchInputResult {
  const selected = selectedRange(cursor, selectionAnchor);
  if (selected) {
    const next = `${draft.slice(0, selected.start)}${input}${draft.slice(selected.end)}`;
    return result(next, selected.start + input.length, null);
  }
  const next = `${draft.slice(0, cursor)}${input}${draft.slice(cursor)}`;
  return result(next, cursor + input.length, null);
}

function deleteBeforeCursor(draft: string, cursor: number, selectionAnchor: number | null): WorkbenchInputResult {
  const selected = selectedRange(cursor, selectionAnchor);
  if (selected) return result(`${draft.slice(0, selected.start)}${draft.slice(selected.end)}`, selected.start, null);
  if (cursor <= 0) return result(draft, 0, null);
  return result(`${draft.slice(0, cursor - 1)}${draft.slice(cursor)}`, cursor - 1, null);
}

function deleteAtCursor(draft: string, cursor: number, selectionAnchor: number | null): WorkbenchInputResult {
  const selected = selectedRange(cursor, selectionAnchor);
  if (selected) return result(`${draft.slice(0, selected.start)}${draft.slice(selected.end)}`, selected.start, null);
  if (cursor >= draft.length) return result(draft, cursor, null);
  return result(`${draft.slice(0, cursor)}${draft.slice(cursor + 1)}`, cursor, null);
}

function clampCursor(cursor: number, draft: string) {
  return Math.max(0, Math.min(draft.length, cursor));
}

function lineStart(draft: string, cursor: number) {
  return draft.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function lineEnd(draft: string, cursor: number) {
  const end = draft.indexOf("\n", cursor);
  return end === -1 ? draft.length : end;
}

function selectedRange(cursor: number, selectionAnchor: number | null) {
  if (selectionAnchor === null || selectionAnchor === cursor) return null;
  return {
    start: Math.min(cursor, selectionAnchor),
    end: Math.max(cursor, selectionAnchor),
  };
}
