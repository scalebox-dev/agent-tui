import {
  createInitialWorkbenchState,
  formatTranscript,
  formatTranscriptPreview,
  helpText,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  workbenchReducer,
  workdirText,
  type RenderMode,
  type WorkbenchAction,
  type WorkbenchCommand,
  type WorkbenchState,
} from "../tui/workbench.js";
import type { WorkdirAccessMode } from "../agent.js";

export interface WorkbenchEngineOptions {
  contextEnabled: boolean;
  accessMode?: WorkdirAccessMode;
  conversation?: string;
  preset?: string;
  model?: string;
  renderMode?: RenderMode;
  defaultPreset?: string | null;
}

export interface WorkbenchEngine {
  snapshot(): WorkbenchState;
  subscribe(listener: () => void): () => void;
  dispatch(action: WorkbenchAction): void;
  submit(input: string): WorkbenchSubmission;
  handleCommand(command: WorkbenchCommand): WorkbenchCommandResult;
}

export type WorkbenchSubmission =
  | { kind: "command"; command: WorkbenchCommand }
  | { kind: "prompt"; prompt: string }
  | { kind: "handled" };

export type WorkbenchEffect =
  | { type: "exit" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "delete_profile" }
  | { type: "switch_profile"; name?: string }
  | { type: "show_auth_status" }
  | { type: "export_transcript"; path?: string; transcript: string; conversation: string }
  | { type: "clear_preset_tool_catalog_cache" };

export interface WorkbenchCommandResult {
  handled: boolean;
  effects: WorkbenchEffect[];
}

export function createWorkbenchEngine(options: WorkbenchEngineOptions): WorkbenchEngine {
  let state = createInitialWorkbenchState(options);
  let pendingApprovalInvalidInputs = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const dispatch = (action: WorkbenchAction) => {
    if (action.type === "local_tool.pending.set" || action.type === "local_tool.pending.clear") {
      pendingApprovalInvalidInputs = 0;
    }
    const next = workbenchReducer(state, action);
    if (Object.is(next, state)) return;
    state = next;
    notify();
  };

  return {
    snapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    handleCommand(command) {
      switch (command.kind) {
        case "quit":
          return handled({ type: "exit" });
        case "login":
          return handled({ type: "login" });
        case "logout":
          return handled({ type: "logout" });
        case "delete_profile":
          return handled({ type: "delete_profile" });
        case "switch_profile":
          return handled({ type: "switch_profile", name: command.name });
        case "auth_status":
          return handled({ type: "show_auth_status" });
        case "export":
          return handled({
            type: "export_transcript",
            path: command.path,
            transcript: formatTranscript(state.messages),
            conversation: state.currentConversation,
          });
        case "refresh_catalog":
          dispatch({ type: "activity.add", level: "success", text: "Preset and tool catalogs refreshed" });
          dispatch({ type: "message.add", role: "system", text: "Cleared cached preset and server tool catalogs. The next agent turn will fetch fresh platform configuration." });
          return handled({ type: "clear_preset_tool_catalog_cache" });
        case "invalid":
          dispatch({
            type: "message.add",
            role: "system",
            text: `Unknown command: /${command.command}\nType /help for supported commands.`,
          });
          dispatch({ type: "activity.add", level: "warning", text: `Unknown command: /${command.command}` });
          return handled();
        case "help":
          dispatch({ type: "message.add", role: "system", text: helpText() });
          return handled();
        case "clear":
          dispatch({ type: "messages.clear" });
          return handled();
        case "render":
          if (!command.mode) {
            dispatch({ type: "message.add", role: "system", text: `Render mode: ${state.renderMode}. Use /render markdown or /render raw.` });
            return handled();
          }
          dispatch({ type: "settings.set", settings: { renderMode: command.mode } });
          dispatch({ type: "activity.add", level: "success", text: `Render mode: ${command.mode}` });
          dispatch({ type: "message.add", role: "system", text: `Render mode set to ${command.mode}.` });
          return handled();
        case "transcript":
          dispatch({ type: "message.add", role: "system", text: formatTranscriptPreview(state.messages) });
          dispatch({ type: "activity.add", level: "success", text: "Transcript preview ready" });
          return handled();
        case "context":
          dispatch({ type: "context.set", enabled: command.enabled ?? !state.contextEnabled });
          return handled();
        case "access":
          if (!command.mode) {
            dispatch({ type: "message.add", role: "system", text: `Local access: ${state.accessMode}. Use /access off, /access approval, or /access full.` });
            return handled();
          }
          dispatch({ type: "access.set", mode: command.mode });
          return handled();
        case "model":
          if (!command.value) {
            dispatch({ type: "message.add", role: "system", text: `Model: ${state.runModel || "auto"}. Use /model <name> or /model auto.` });
            return handled();
          }
          dispatch({ type: "settings.set", settings: { runModel: normalizeOptionalSetting(command.value, ["auto", "none", "off", "clear"]) } });
          dispatch({ type: "activity.add", text: `Model: ${normalizeOptionalSetting(command.value, ["auto", "none", "off", "clear"]) || "auto"}` });
          return handled();
        case "workdir":
          if (command.enabled === undefined) {
            dispatch({
              type: "message.add",
              role: "system",
              text: [
                workdirText(state.workdir),
                "",
                `local_workdir tool: ${state.contextEnabled ? "on" : "off"}`,
                `local_shell tool: ${state.contextEnabled ? "on" : "off"}`,
                "Use /access approval or /access full to expose local tools, or /access off to hide them.",
              ].join("\n"),
            });
            return handled();
          }
          dispatch({ type: "context.set", enabled: command.enabled });
          dispatch({
            type: "activity.add",
            level: command.enabled ? "success" : "warning",
            text: `local tools ${command.enabled ? "enabled" : "disabled"}`,
          });
          dispatch({
            type: "message.add",
            role: "system",
            text: command.enabled
              ? "local_workdir and local_shell are now available to the model in approval mode. Use /access full to allow execution without prompts."
              : "local tools are now hidden from the model.",
          });
          return handled();
        default:
          return unhandled();
      }
    },
    submit(input) {
      const trimmed = input.trim();
      if (!trimmed) return { kind: "handled" };
      if (state.pendingLocalTool) {
        const command = parsePendingApprovalCommand(trimmed);
        if (command) {
          pendingApprovalInvalidInputs = 0;
          return { kind: "command", command };
        }
        handleInvalidPendingApprovalInput();
        return { kind: "handled" };
      }
      const command = parseWorkbenchCommand(trimmed);
      if (command) return { kind: "command", command };
      return { kind: "prompt", prompt: trimmed };
    },
  };

  function handleInvalidPendingApprovalInput() {
    pendingApprovalInvalidInputs += 1;
    const attempts = pendingApprovalInvalidInputs;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      dispatch({
        type: "message.add",
        role: "system",
        text: "Local approval aborted after too many invalid inputs. The pending action was not executed.",
      });
      dispatch({ type: "activity.add", level: "warning", text: "Local approval aborted" });
      dispatch({ type: "local_tool.pending.clear" });
      pendingApprovalInvalidInputs = 0;
      return;
    }
    dispatch({
      type: "message.add",
      role: "system",
      text: `Local approval is pending. Enter /apply or /yes to execute once, /apply-all or /yes-all to allow future local actions, or /reject or /no to discard. Invalid input ${attempts}/${maxAttempts}.`,
    });
    dispatch({ type: "activity.add", level: "warning", text: "Waiting for local approval command" });
  }
}

function handled(...effects: WorkbenchEffect[]): WorkbenchCommandResult {
  return { handled: true, effects };
}

function unhandled(): WorkbenchCommandResult {
  return { handled: false, effects: [] };
}

function normalizeOptionalSetting(value: string, clearValues: string[]) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return clearValues.includes(trimmed.toLowerCase()) ? undefined : trimmed;
}
