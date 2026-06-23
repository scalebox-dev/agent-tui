import { createInputHistory } from "./state.js";

export interface WorkbenchInputKey {
  backspace?: boolean;
  ctrl?: boolean;
  delete?: boolean;
  downArrow?: boolean;
  end?: boolean;
  escape?: boolean;
  home?: boolean;
  meta?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
  return?: boolean;
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
  draft: string;
  effects: WorkbenchInputEffect[];
}

export interface WorkbenchInputContext {
  busy: boolean;
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
      if (key.ctrl && input === "c") return result(context.draft, { type: "exit" });
      if (key.pageUp || (key.ctrl && input === "u")) {
        return result(context.draft, { type: "scroll", delta: Math.max(1, Math.floor(context.viewportHeight / 2)) });
      }
      if (key.pageDown || (key.ctrl && input === "d")) {
        return result(context.draft, { type: "scroll", delta: -Math.max(1, Math.floor(context.viewportHeight / 2)) });
      }
      if (key.home) return result(context.draft, { type: "scroll_top" });
      if (key.end) return result(context.draft, { type: "scroll_bottom" });
      if (key.upArrow) return result(history.previous(context.draft));
      if (key.downArrow) return result(history.next(context.draft));

      if (context.busy) {
        return handleBusyInput(input, key, context.draft, history);
      }
      return handleReadyInput(input, key, context.draft, history);
    },
  };
}

function handleBusyInput(
  input: string,
  key: WorkbenchInputKey,
  draft: string,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.escape) return result(draft, { type: "abort" });
  if (key.return) {
    const command = draft.trim();
    history.record(command);
    if (command === "/abort" || command === "/cancel") return result("", { type: "abort" });
    if (command) return result("", { type: "ignored_busy" });
    return result("");
  }
  if (key.backspace || key.delete) {
    history.reset();
    return result(draft.slice(0, -1));
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return result(draft + input);
  }
  return result(draft);
}

function handleReadyInput(
  input: string,
  key: WorkbenchInputKey,
  draft: string,
  history: ReturnType<typeof createInputHistory>,
): WorkbenchInputResult {
  if (key.return) {
    const prompt = draft.trim();
    if (!prompt) return result(draft);
    history.record(prompt);
    return result("", { type: "submit", input: prompt });
  }
  if (key.backspace || key.delete) {
    history.reset();
    return result(draft.slice(0, -1));
  }
  if (input && !key.ctrl && !key.meta) {
    history.reset();
    return result(draft + input);
  }
  return result(draft);
}

function result(draft: string, ...effects: WorkbenchInputEffect[]): WorkbenchInputResult {
  return { draft, effects };
}
