import { createInputHistory } from "../workbench/state.js";

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
}

export interface WorkbenchInputContext {
  busy: boolean;
  cursor?: number;
  draft: string;
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
      if (key.ctrl && input === "c") return result(context.draft, cursor, { type: "exit" });
      if (key.pageUp || (key.ctrl && input === "u")) {
        return result(context.draft, cursor, { type: "scroll", delta: Math.max(1, Math.floor(context.viewportHeight / 2)) });
      }
      if (key.pageDown || (key.ctrl && input === "d")) {
        return result(context.draft, cursor, { type: "scroll", delta: -Math.max(1, Math.floor(context.viewportHeight / 2)) });
      }
      if (key.home || (key.ctrl && input === "a")) return result(context.draft, 0);
      if (key.end || (key.ctrl && input === "e")) return result(context.draft, context.draft.length);
      if (key.leftArrow) return result(context.draft, Math.max(0, cursor - 1));
      if (key.rightArrow) return result(context.draft, Math.min(context.draft.length, cursor + 1));
      if (key.upArrow) return historyResult(history.previous(context.draft));
      if (key.downArrow) return historyResult(history.next(context.draft));

      if (context.busy) {
        return handleBusyInput(input, key, context.draft, cursor, history);
      }
      return handleReadyInput(input, key, context.draft, cursor, history);
    },
  };
}

function handleBusyInput(
  input: string,
  key: WorkbenchInputKey,
  draft: string,
  cursor: number,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.escape) return result(draft, cursor, { type: "abort" });
  if (key.return) {
    const command = draft.trim();
    history.record(command);
    if (command === "/abort" || command === "/cancel") return result("", 0, { type: "abort" });
    if (command) return result("", 0, { type: "ignored_busy" });
    return result("", 0);
  }
  if (key.backspace) {
    history.reset();
    return deleteBeforeCursor(draft, cursor);
  }
  if (key.delete) {
    history.reset();
    return cursor >= draft.length ? deleteBeforeCursor(draft, cursor) : deleteAtCursor(draft, cursor);
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return insertAtCursor(draft, cursor, input);
  }
  return result(draft, cursor);
}

function handleReadyInput(
  input: string,
  key: WorkbenchInputKey,
  draft: string,
  cursor: number,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.return) {
    const prompt = draft.trim();
    if (!prompt) return result(draft, cursor);
    history.record(prompt);
    return result("", 0, { type: "submit", input: prompt });
  }
  if (key.backspace) {
    history.reset();
    return deleteBeforeCursor(draft, cursor);
  }
  if (key.delete) {
    history.reset();
    return cursor >= draft.length ? deleteBeforeCursor(draft, cursor) : deleteAtCursor(draft, cursor);
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return insertAtCursor(draft, cursor, input);
  }
  return result(draft, cursor);
}

function result(draft: string, cursor: number, ...effects: WorkbenchInputEffect[]): WorkbenchInputResult {
  return { cursor: clampCursor(cursor, draft), draft, effects };
}

function historyResult(draft: string): WorkbenchInputResult {
  return result(draft, draft.length);
}

function insertAtCursor(draft: string, cursor: number, input: string): WorkbenchInputResult {
  const next = `${draft.slice(0, cursor)}${input}${draft.slice(cursor)}`;
  return result(next, cursor + input.length);
}

function deleteBeforeCursor(draft: string, cursor: number): WorkbenchInputResult {
  if (cursor <= 0) return result(draft, 0);
  return result(`${draft.slice(0, cursor - 1)}${draft.slice(cursor)}`, cursor - 1);
}

function deleteAtCursor(draft: string, cursor: number): WorkbenchInputResult {
  if (cursor >= draft.length) return result(draft, cursor);
  return result(`${draft.slice(0, cursor)}${draft.slice(cursor + 1)}`, cursor);
}

function clampCursor(cursor: number, draft: string) {
  return Math.max(0, Math.min(draft.length, cursor));
}
