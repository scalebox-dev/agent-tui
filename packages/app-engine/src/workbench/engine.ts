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
} from "./state.js";
import type { AgentTurnEvent, WorkdirAccessMode } from "../agent.js";
import { formatDisplayPreview, localToolDisplayArguments } from "../local-display.js";
import { shouldPersistTranscriptMessage, type WorkbenchTranscriptStore } from "./transcript-store.js";

export interface WorkbenchEngineOptions {
  contextEnabled: boolean;
  accessMode?: WorkdirAccessMode;
  conversation?: string;
  preset?: string;
  model?: string;
  memoryRead?: boolean;
  memoryWrite?: boolean;
  memoryTenantSearch?: boolean;
  localSkillsEnabled?: boolean;
  workspaceSkillsEnabled?: boolean;
  renderMode?: RenderMode;
  defaultPreset?: string | null;
  transcriptStore?: WorkbenchTranscriptStore;
}

export interface WorkbenchEngine {
  snapshot(): WorkbenchState;
  subscribe(listener: () => void): () => void;
  dispatch(action: WorkbenchAction): void;
  submit(input: string): WorkbenchSubmission;
  handleCommand(command: WorkbenchCommand): WorkbenchCommandResult;
  handleAgentEvent(event: AgentTurnEvent): WorkbenchEventResult;
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

export type WorkbenchRuntimeEffect =
  | { type: "append_text_delta"; delta: string }
  | { type: "set_active_response_id"; responseID: string }
  | { type: "flush_text_delta_buffer" };

export interface WorkbenchCommandResult {
  handled: boolean;
  effects: WorkbenchEffect[];
}

export interface WorkbenchEventResult {
  effects: WorkbenchRuntimeEffect[];
}

export function createWorkbenchEngine(options: WorkbenchEngineOptions): WorkbenchEngine {
  let state = createInitialWorkbenchState(options);
  let pendingApprovalInvalidInputs = 0;
  let transcriptPersistQueue = Promise.resolve();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const dispatch = (action: WorkbenchAction) => {
    if (
      action.type === "local_tool.pending.set" ||
      action.type === "local_tool.pending.clear" ||
      action.type === "automatic_continuation.pending.set" ||
      action.type === "automatic_continuation.pending.clear" ||
      action.type === "update.pending.set" ||
      action.type === "update.pending.clear"
    ) {
      pendingApprovalInvalidInputs = 0;
    }
    const next = workbenchReducer(state, action);
    if (Object.is(next, state)) return;
    state = next;
    transcriptPersistQueue = transcriptPersistQueue.then(() =>
      persistTranscriptAction(options.transcriptStore, state, action, dispatch),
    );
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
        case "copy":
          dispatch({ type: "message.add", role: "system", text: `Copy target: ${command.target}. Clipboard copy is provided by the active renderer.` });
          dispatch({ type: "activity.add", text: `Copy requested: ${command.target}` });
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
        case "memory":
          handleMemoryCommand(command);
          return handled();
        case "skills":
          handleSkillsCommand(command);
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
    handleAgentEvent(event) {
      switch (event.type) {
        case "text.delta":
          return event.delta ? eventResult({ type: "append_text_delta", delta: event.delta }) : eventResult();
        case "response.started":
          if (event.responseID) {
            dispatch({ type: "activity.add", text: `Response started: ${event.responseID}` });
            return eventResult({ type: "set_active_response_id", responseID: event.responseID });
          }
          dispatch({ type: "activity.add", text: "Response started" });
          return eventResult();
        case "response.completed":
          dispatch({ type: "activity.add", level: "success", text: event.responseID ? `Response completed: ${event.responseID}` : "Response completed" });
          return eventResult({ type: "flush_text_delta_buffer" });
        case "response.failed":
          dispatch({ type: "activity.add", level: "error", text: event.message });
          return eventResult({ type: "flush_text_delta_buffer" });
        case "reasoning.started":
          dispatch({ type: "activity.add", text: "Reasoning started" });
          return eventResult();
        case "reasoning.stopped":
          dispatch({ type: "activity.add", text: event.thought ? `Reasoning stopped: ${event.thought}` : "Reasoning stopped" });
          return eventResult();
        case "reasoning.search_queries":
          dispatch({ type: "activity.add", text: `Search queries: ${event.queries.join(", ") || "none"}` });
          return eventResult();
        case "reasoning.search_results":
          dispatch({ type: "activity.add", text: `Search results: ${event.count}` });
          return eventResult();
        case "reasoning.fetch_url_queries":
          dispatch({ type: "activity.add", text: `Fetch URLs: ${event.urls.join(", ") || "none"}` });
          return eventResult();
        case "reasoning.fetch_url_results":
          dispatch({ type: "activity.add", text: `Fetched URL results: ${event.count}` });
          return eventResult();
        case "tool.completed":
          dispatch({ type: "activity.add", level: event.status === "failed" ? "error" : "success", text: `Tool completed: ${event.name}${event.status ? ` (${event.status})` : ""}` });
          return eventResult();
        case "local_tool.started":
          dispatch({
            type: "activity.add",
            text: formatLocalToolStartedActivity(event),
          });
          return eventResult();
        case "local_tool.completed":
          dispatch({
            type: "activity.add",
            level: event.requiresApproval ? "warning" : "success",
            text: `Local tool: ${event.name}${event.action ? `.${event.action}` : ""}${event.requiresApproval ? " (approval required)" : ""}`,
          });
          if (!event.requiresApproval && (event.arguments || event.result)) {
            dispatch({ type: "message.add", role: "system", kind: "tool", text: formatLocalToolCompleted(event) });
          }
          return eventResult();
        case "local_tool.approval_requested":
          dispatch({
            type: "local_tool.pending.set",
            approval: {
              name: event.name,
              action: event.action,
              arguments: event.arguments,
              preview: event.preview,
              callID: event.callID,
              responseID: event.responseID,
            },
          });
          dispatch({ type: "message.add", role: "system", text: formatLocalToolApproval(event) });
          return eventResult();
        case "automatic_continuation.paused":
          dispatch({
            type: "automatic_continuation.pending.set",
            pause: {
              reason: event.reason,
              message: event.message,
              continuation: event.continuation,
              count: event.count,
              limit: event.limit,
              responseID: event.responseID,
            },
          });
          dispatch({ type: "message.add", role: "system", text: event.message });
          return eventResult({ type: "flush_text_delta_buffer" });
        case "model.requested":
          dispatch({ type: "activity.add", text: `Model requested: ${modelLabel(event.model, event.provider)}` });
          return eventResult();
        case "model.completed":
          dispatch({ type: "activity.add", level: "success", text: `Model completed: ${modelLabel(event.model, event.provider)}` });
          return eventResult();
        case "model.failed":
          dispatch({ type: "activity.add", level: "error", text: `Model failed: ${modelLabel(event.model, event.provider)}` });
          return eventResult();
        case "step.completed":
          dispatch({ type: "activity.add", level: "success", text: `Step completed: ${event.stepType || "step"}` });
          return eventResult();
        case "step.failed":
          dispatch({ type: "activity.add", level: "error", text: `Step failed: ${event.stepType || "step"}` });
          return eventResult();
        case "raw":
          return eventResult();
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
      if (state.pendingAutomaticContinuation) {
        const command = parsePendingApprovalCommand(trimmed);
        if (command) {
          pendingApprovalInvalidInputs = 0;
          return { kind: "command", command };
        }
        handleInvalidPendingContinuationInput();
        return { kind: "handled" };
      }
      if (state.pendingUpdate) {
        const command = parsePendingApprovalCommand(trimmed);
        if (command) {
          pendingApprovalInvalidInputs = 0;
          return { kind: "command", command };
        }
        handleInvalidPendingUpdateInput();
        return { kind: "handled" };
      }
      const command = parseWorkbenchCommand(trimmed);
      if (command) return { kind: "command", command };
      if (trimmed.startsWith("\\/")) return { kind: "prompt", prompt: trimmed.slice(1) };
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

  function handleInvalidPendingContinuationInput() {
    pendingApprovalInvalidInputs += 1;
    const attempts = pendingApprovalInvalidInputs;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      dispatch({
        type: "message.add",
        role: "system",
        text: "Automatic continuation stopped after too many invalid inputs. The job remains paused at the last response.",
      });
      dispatch({ type: "activity.add", level: "warning", text: "Automatic continuation stopped" });
      dispatch({ type: "automatic_continuation.pending.clear" });
      pendingApprovalInvalidInputs = 0;
      return;
    }
    dispatch({
      type: "message.add",
      role: "system",
      text: `Automatic continuation is paused. Enter /apply or /yes to continue, /apply-all or /yes-all to continue without more automatic continuation checkpoints for this turn, or /reject or /no to stop. Invalid input ${attempts}/${maxAttempts}.`,
    });
    dispatch({ type: "activity.add", level: "warning", text: "Waiting for continuation command" });
  }

  function handleInvalidPendingUpdateInput() {
    pendingApprovalInvalidInputs += 1;
    const attempts = pendingApprovalInvalidInputs;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      dispatch({
        type: "message.add",
        role: "system",
        text: "CLI update canceled after too many invalid inputs.",
      });
      dispatch({ type: "activity.add", level: "warning", text: "CLI update canceled" });
      dispatch({ type: "update.pending.clear" });
      pendingApprovalInvalidInputs = 0;
      return;
    }
    dispatch({
      type: "message.add",
      role: "system",
      text: `CLI update is ready. Enter /apply to install and close the workbench, or /reject to cancel. Invalid input ${attempts}/${maxAttempts}.`,
    });
    dispatch({ type: "activity.add", level: "warning", text: "Waiting for update confirmation" });
  }

  function handleMemoryCommand(command: Extract<WorkbenchCommand, { kind: "memory" }>) {
    if (!command.field && command.enabled !== false) {
      dispatch({
        type: "message.add",
        role: "system",
        text: [
          `Memory read: ${state.memoryRead ? "on" : "api default"}`,
          `Memory write: ${state.memoryWrite ? "on" : "api default"}`,
          `Memory workspace search: ${state.memoryTenantSearch ? "on" : "api default"}`,
          "Use /memory read on, /memory write on, /memory read workspace on, or /memory off.",
        ].join("\n"),
      });
      return;
    }
    if (!command.field) {
      dispatch({
        type: "settings.set",
        settings: { memoryRead: false, memoryWrite: false, memoryTenantSearch: false },
      });
      dispatch({ type: "message.add", role: "system", text: "Memory options cleared; API defaults apply." });
      dispatch({ type: "activity.add", level: "warning", text: "Memory: api default" });
      return;
    }
    const enabled = command.enabled ?? !memoryFieldEnabled(command.field);
    dispatch({
      type: "settings.set",
      settings: {
        ...(command.field === "workspace" && enabled ? { memoryRead: true } : {}),
        ...(command.field === "read" ? { memoryRead: enabled, ...(enabled ? {} : { memoryTenantSearch: false }) } : {}),
        ...(command.field === "write" ? { memoryWrite: enabled } : {}),
        ...(command.field === "workspace" ? { memoryTenantSearch: enabled } : {}),
      },
    });
    const label = command.field === "workspace" ? "read workspace search" : command.field;
    dispatch({ type: "message.add", role: "system", text: `Memory ${label} set to ${enabled ? "on" : "api default"}.` });
    dispatch({ type: "activity.add", level: enabled ? "success" : "warning", text: `Memory ${label}: ${enabled ? "on" : "api default"}` });
  }

  function memoryFieldEnabled(field: Extract<WorkbenchCommand, { kind: "memory" }>["field"]) {
    if (field === "read") return state.memoryRead;
    if (field === "write") return state.memoryWrite;
    if (field === "workspace") return state.memoryTenantSearch;
    return state.memoryRead;
  }

  function handleSkillsCommand(command: Extract<WorkbenchCommand, { kind: "skills" }>) {
    if (!command.field && command.enabled === undefined) {
      dispatch({
        type: "message.add",
        role: "system",
        text: [
          `Local skill discovery: ${state.localSkillsEnabled ? "on" : "off"}`,
          `Workspace skill discovery: ${state.workspaceSkillsEnabled ? "on" : "off"}`,
          "Use /skills local on|off or /skills workspace on|off.",
        ].join("\n"),
      });
      return;
    }
    const field = command.field ?? "local";
    const current = field === "local" ? state.localSkillsEnabled : state.workspaceSkillsEnabled;
    const enabled = command.enabled ?? !current;
    dispatch({
      type: "settings.set",
      settings: field === "local" ? { localSkillsEnabled: enabled } : { workspaceSkillsEnabled: enabled },
    });
    dispatch({ type: "message.add", role: "system", text: `${field === "local" ? "Local" : "Workspace"} skill discovery set to ${enabled ? "on" : "off"}.` });
    dispatch({ type: "activity.add", level: enabled ? "success" : "warning", text: `${field === "local" ? "Local" : "Workspace"} skills: ${enabled ? "on" : "off"}` });
  }
}

function handled(...effects: WorkbenchEffect[]): WorkbenchCommandResult {
  return { handled: true, effects };
}

function unhandled(): WorkbenchCommandResult {
  return { handled: false, effects: [] };
}

function eventResult(...effects: WorkbenchRuntimeEffect[]): WorkbenchEventResult {
  return { effects };
}

async function persistTranscriptAction(
  store: WorkbenchTranscriptStore | undefined,
  state: WorkbenchState,
  action: WorkbenchAction,
  dispatch: (action: WorkbenchAction) => void,
) {
  if (!store || !state.conversationId) return;
  try {
    if (action.type === "message.add") {
      const message = {
        id: action.id ?? state.messages.at(-1)?.id ?? "",
        kind: action.kind,
        role: action.role,
        text: action.text,
      };
      if (message && shouldPersistTranscriptMessage(message)) {
        await store.appendMessage(state.conversationId, message);
      }
      return;
    }
    if (action.type === "message.append") {
      const message = state.messages.find((item) => item.id === action.id);
      if (message && shouldPersistTranscriptMessage(message)) {
        await store.appendMessageDelta(state.conversationId, action.id, action.delta);
      }
    }
  } catch (error) {
    dispatch({
      type: "activity.add",
      level: "warning",
      text: `Transcript persistence unavailable: ${userFacingError(error)}`,
    });
  }
}

function modelLabel(model?: string, provider?: string) {
  if (model && provider) return `${provider}/${model}`;
  return model || provider || "unknown";
}

function userFacingError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatLocalToolApproval(event: Extract<AgentTurnEvent, { type: "local_tool.approval_requested" }>) {
  const label = `${event.name}${event.action ? `.${event.action}` : ""}`;
  return [
    `Local action requires approval: ${label}.`,
    formatLocalToolArgumentPreview(event.name, event.arguments),
    event.preview ? `Preview:\n${formatPreview(event.preview)}` : undefined,
    "Review it in the workbench, then use /apply to execute once, /apply-all to allow future local actions, or /reject to discard it.",
  ].filter(Boolean).join("\n\n");
}

function formatLocalToolCompleted(event: Extract<AgentTurnEvent, { type: "local_tool.completed" }>) {
  const label = `${event.name}${event.action ? `.${event.action}` : ""}`;
  return [
    `Local execution completed: ${label}.`,
    event.arguments ? formatLocalToolArgumentPreview(event.name, event.arguments) : undefined,
    event.result ? `Result:\n${formatPreview(event.result)}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function formatLocalToolStartedActivity(event: Extract<AgentTurnEvent, { type: "local_tool.started" }>) {
  const label = `${event.name}${event.action ? `.${event.action}` : ""}`;
  if (event.name === "local_shell") {
    const command = stringArg(event.arguments, "command");
    const description = stringArg(event.arguments, "description");
    if (command && description) return `Local shell: ${description} - ${command}`;
    if (command) return `Local shell: ${command}`;
  }
  return `Local tool requested: ${label}`;
}

function formatLocalToolArgumentPreview(name: string, args: Record<string, unknown>) {
  if (name === "local_shell") {
    const command = stringArg(args, "command");
    const description = stringArg(args, "description");
    const cwd = stringArg(args, "cwd");
    const timeout = typeof args.timeout_ms === "number" ? `${args.timeout_ms}ms` : "";
    if (command) {
      return [
        "Command:",
        `  ${command}`,
        description ? `Description: ${description}` : "",
        cwd ? `Working directory: ${cwd}` : "",
        timeout ? `Timeout: ${timeout}` : "",
      ].filter(Boolean).join("\n");
    }
  }
  return `Arguments:\n${formatPreview(localToolDisplayArguments(name, args))}`;
}

function formatPreview(preview: unknown) {
  return formatDisplayPreview(preview);
}

function stringArg(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeOptionalSetting(value: string, clearValues: string[]) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return clearValues.includes(trimmed.toLowerCase()) ? undefined : trimmed;
}
