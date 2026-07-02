import { createInputHistory } from "../workbench/state.js";
import {
  deleteTextBeforeCursor,
  deleteTextAtCursor,
  insertText,
  moveTextEditorCursor,
  normalizeTextEditorState,
  selectAllText,
  type TextEditorMovement,
  type TextEditorState,
} from "./text-editor.js";

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
      const editor = normalizeTextEditorState({ text: context.draft, cursor, selectionAnchor });
      const layout = { viewportColumns };
      if (key.ctrl && input === "c") return editorResult(editor, { type: "exit" });
      if (key.pageUp) {
        return editorResult(editor, { type: "scroll", delta: pageScrollDelta(context.viewportHeight) });
      }
      if (key.pageDown) {
        return editorResult(editor, { type: "scroll", delta: -pageScrollDelta(context.viewportHeight) });
      }
      if (key.ctrl && key.upArrow) return historyResult(history.previous(context.draft));
      if (key.ctrl && key.downArrow) return historyResult(history.next(context.draft));
      if (key.ctrl && input === "a") return editorResult(selectAllText(editor));
      const movement = movementFromKey(input, key);
      if (movement) return editorResult(moveTextEditorCursor(editor, movement, layout, isSelectionMovement(key)));

      if (context.busy) {
        return handleBusyInput(input, key, editor, history);
      }
      return handleReadyInput(input, key, editor, history);
    },
  };
}

function pageScrollDelta(viewportHeight: number) {
  return Math.max(1, viewportHeight - 1);
}

function handleBusyInput(
  input: string,
  key: WorkbenchInputKey,
  editor: TextEditorState,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.escape) return editorResult(editor, { type: "abort" });
  if (key.return) {
    const command = editor.text.trim();
    history.record(command);
    if (command === "/abort" || command === "/cancel") return editorResult(emptyEditor(), { type: "abort" });
    if (isResumeCommand(command)) return editorResult(emptyEditor(), { type: "submit", input: command });
    if (isCopyCommand(command)) return editorResult(emptyEditor(), { type: "submit", input: command });
    if (command) return editorResult(emptyEditor(), { type: "ignored_busy" });
    return editorResult(emptyEditor());
  }
  if (isBackwardDelete(input, key)) {
    history.reset();
    return editorResult(deleteTextBeforeCursor(editor));
  }
  if (key.delete) {
    history.reset();
    return editorResult(deleteTextAtCursor(editor));
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return editorResult(insertText(editor, input));
  }
  return editorResult(editor);
}

function handleReadyInput(
  input: string,
  key: WorkbenchInputKey,
  editor: TextEditorState,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.return) {
    if (key.meta) {
      history.reset();
      return editorResult(insertText(editor, "\n"));
    }
    const prompt = editor.text.trim();
    if (!prompt) return editorResult(editor);
    history.record(prompt);
    return editorResult(emptyEditor(), { type: "submit", input: prompt });
  }
  if (isBackwardDelete(input, key)) {
    history.reset();
    return editorResult(deleteTextBeforeCursor(editor));
  }
  if (key.delete) {
    history.reset();
    return editorResult(deleteTextAtCursor(editor));
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return editorResult(insertText(editor, input));
  }
  return editorResult(editor);
}

function editorResult(editor: TextEditorState, ...effects: WorkbenchInputEffect[]): WorkbenchInputResult {
  const state = normalizeTextEditorState(editor);
  return { cursor: state.cursor, draft: state.text, effects, selectionAnchor: state.selectionAnchor };
}

function historyResult(draft: string): WorkbenchInputResult {
  return editorResult({ text: draft, cursor: draft.length, selectionAnchor: null });
}

function clampCursor(cursor: number, draft: string) {
  return Math.max(0, Math.min(draft.length, cursor));
}

function movementFromKey(input: string, key: WorkbenchInputKey): TextEditorMovement | null {
  if (key.ctrl && input === "e") return "documentEnd";
  if (key.home) return "visualLineStart";
  if (key.end) return "visualLineEnd";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "visualUp";
  if (key.downArrow) return "visualDown";
  return null;
}

function isSelectionMovement(key: WorkbenchInputKey) {
  return Boolean(key.shift || key.meta);
}

function emptyEditor(): TextEditorState {
  return { text: "", cursor: 0, selectionAnchor: null };
}

function isResumeCommand(command: string) {
  return command === "/resume" || command.startsWith("/resume ");
}

function isCopyCommand(command: string) {
  return command === "/copy" || command.startsWith("/copy ");
}

function isBackwardDelete(input: string, key: WorkbenchInputKey) {
  return Boolean(key.backspace || (key.ctrl && input === "h"));
}
