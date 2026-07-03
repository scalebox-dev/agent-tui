import type { AutomaticContinuationPause, LocalToolApprovalRequest, WorkdirAccessMode } from "../agent.js";
import type { UpdateCheckResult } from "../update.js";
import type { ShellIsolationPreferences } from "../workbench/shell-isolation.js";

export type WorkbenchRole = "user" | "assistant" | "system";
export type WorkbenchMessageKind = "tool";

export interface WorkbenchMessage {
  id: string;
  kind?: WorkbenchMessageKind;
  role: WorkbenchRole;
  text: string;
}

export type ActivityLevel = "info" | "success" | "warning" | "error";

export interface WorkbenchActivity {
  id: string;
  level: ActivityLevel;
  text: string;
  timestamp: number;
}

export interface WorkbenchWorkdirStatus {
  root: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  scanTruncated: boolean;
}

export interface LocalToolApproval extends LocalToolApprovalRequest {
  id: string;
  createdAt: number;
}

export interface PendingAutomaticContinuation extends AutomaticContinuationPause {
  id: string;
  createdAt: number;
}

export interface PendingUpdate {
  id: string;
  createdAt: number;
  result: UpdateCheckResult;
}

export type RenderMode = "markdown" | "raw";
export type WorkbenchCopyTarget = "page" | "transcript" | "activity" | "header";

export interface WorkbenchState {
  messages: WorkbenchMessage[];
  activities: WorkbenchActivity[];
  busy: boolean;
  contextEnabled: boolean;
  workdir: WorkbenchWorkdirStatus | null;
  activeAssistantMessageId: string | null;
  pendingLocalTool: LocalToolApproval | null;
  pendingAutomaticContinuation: PendingAutomaticContinuation | null;
  pendingUpdate: PendingUpdate | null;
  accessMode: WorkdirAccessMode;
  conversationId?: string;
  conversationPreviousResponseId?: string;
  conversationStatus: "fresh" | "continued" | "unknown";
  currentConversation: string;
  runPreset?: string;
  runModel?: string;
  memoryRead: boolean;
  memoryWrite: boolean;
  memoryTenantSearch: boolean;
  localSkillsEnabled: boolean;
  workspaceSkillsEnabled: boolean;
  renderMode: RenderMode;
  defaultPreset?: string | null;
  automaticContinuationLimit?: number | null;
  automaticContinuationUnlocked: boolean;
  shellIsolation?: ShellIsolationPreferences;
}

export interface InputHistory {
  record(value: string): void;
  previous(currentDraft: string): string;
  next(currentDraft: string): string;
  reset(): void;
  values(): string[];
}

export type WorkbenchAction =
  | { type: "message.add"; role: WorkbenchRole; text: string; id?: string; kind?: WorkbenchMessageKind }
  | { type: "message.append"; id: string; delta: string }
  | { type: "messages.clear" }
  | { type: "activity.add"; level?: ActivityLevel; text: string }
  | { type: "busy.set"; busy: boolean }
  | { type: "context.toggle" }
  | { type: "context.set"; enabled: boolean }
  | { type: "workdir.set"; workdir: WorkbenchWorkdirStatus }
  | { type: "assistant.active"; id: string | null }
  | { type: "local_tool.pending.set"; approval: LocalToolApprovalRequest }
  | { type: "local_tool.pending.clear" }
  | { type: "automatic_continuation.pending.set"; pause: AutomaticContinuationPause }
  | { type: "automatic_continuation.pending.clear" }
  | { type: "automatic_continuation.unlock"; unlocked: boolean }
  | { type: "update.pending.set"; result: UpdateCheckResult }
  | { type: "update.pending.clear" }
  | { type: "access.set"; mode: WorkdirAccessMode }
  | { type: "conversation.set"; id?: string; name: string; previousResponseId?: string; status?: "fresh" | "continued" | "unknown" }
  | { type: "settings.set"; settings: Partial<Pick<WorkbenchState, "runPreset" | "runModel" | "memoryRead" | "memoryWrite" | "memoryTenantSearch" | "localSkillsEnabled" | "workspaceSkillsEnabled" | "renderMode" | "defaultPreset" | "automaticContinuationLimit" | "shellIsolation">> };

export type WorkbenchCommand =
  | { kind: "invalid"; command: string }
  | { kind: "abort" }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "delete_profile" }
  | { kind: "switch_profile"; name?: string }
  | { kind: "auth_status" }
  | { kind: "config"; field?: "preset" | "continuation-limit" | "isolation" | "isolator"; value?: string }
  | { kind: "memory"; field?: "read" | "write" | "workspace"; enabled?: boolean }
  | { kind: "skills"; field?: "local" | "workspace"; enabled?: boolean }
  | { kind: "render"; mode?: RenderMode }
  | { kind: "transcript" }
  | { kind: "copy"; target: WorkbenchCopyTarget }
  | { kind: "export"; path?: string }
  | { kind: "context"; enabled?: boolean }
  | { kind: "workdir"; enabled?: boolean }
  | { kind: "access"; mode?: WorkdirAccessMode }
  | { kind: "preset"; value?: string }
  | { kind: "model"; value?: string }
  | { kind: "summary" }
  | { kind: "search"; query: string }
  | { kind: "new_conversation"; name?: string }
  | { kind: "switch_conversation"; name: string }
  | { kind: "list_conversations" }
  | { kind: "refresh_catalog" }
  | { kind: "update" }
  | { kind: "preview" }
  | { kind: "resume"; message?: string }
  | { kind: "apply" }
  | { kind: "apply_all" }
  | { kind: "reject" };

export function createInitialWorkbenchState(options: {
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
  automaticContinuationLimit?: number | null;
  shellIsolation?: ShellIsolationPreferences;
}): WorkbenchState {
  const accessMode = options.accessMode ?? (options.contextEnabled ? "approval" : "off");
  return {
    messages: [
      newMessage("system", "Agent API Workbench is ready. Type /help for commands."),
    ],
    activities: [
      newActivity("info", "Workbench started"),
    ],
    busy: false,
    contextEnabled: options.contextEnabled || accessMode === "approval" || accessMode === "full",
    workdir: null,
    activeAssistantMessageId: null,
    pendingLocalTool: null,
    pendingAutomaticContinuation: null,
    pendingUpdate: null,
    accessMode,
    conversationId: undefined,
    conversationPreviousResponseId: undefined,
    conversationStatus: "unknown",
    currentConversation: options.conversation || "default",
    runPreset: options.preset,
    runModel: options.model,
    memoryRead: Boolean(options.memoryRead),
    memoryWrite: Boolean(options.memoryWrite),
    memoryTenantSearch: Boolean(options.memoryTenantSearch),
    localSkillsEnabled: options.localSkillsEnabled !== false,
    workspaceSkillsEnabled: Boolean(options.workspaceSkillsEnabled),
    renderMode: options.renderMode ?? "markdown",
    defaultPreset: options.defaultPreset,
    automaticContinuationLimit: options.automaticContinuationLimit,
    automaticContinuationUnlocked: false,
    shellIsolation: options.shellIsolation,
  };
}

export function createInputHistory(limit = 100): InputHistory {
  const entries: string[] = [];
  let cursor: number | null = null;
  let draftBeforeBrowse = "";
  return {
    record(value: string) {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (entries.at(-1) !== trimmed) {
        entries.push(trimmed);
        if (entries.length > limit) entries.splice(0, entries.length - limit);
      }
      cursor = null;
      draftBeforeBrowse = "";
    },
    previous(currentDraft: string) {
      if (entries.length === 0) return currentDraft;
      if (cursor === null) {
        draftBeforeBrowse = currentDraft;
        cursor = entries.length - 1;
      } else {
        cursor = Math.max(0, cursor - 1);
      }
      return entries[cursor] ?? currentDraft;
    },
    next(currentDraft: string) {
      if (entries.length === 0 || cursor === null) return currentDraft;
      if (cursor < entries.length - 1) {
        cursor += 1;
        return entries[cursor] ?? currentDraft;
      }
      cursor = null;
      const restored = draftBeforeBrowse;
      draftBeforeBrowse = "";
      return restored;
    },
    reset() {
      cursor = null;
      draftBeforeBrowse = "";
    },
    values() {
      return [...entries];
    },
  };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "message.add":
      return {
        ...state,
        messages: [...state.messages, newMessage(action.role, action.text, action.id, action.kind)],
      };
    case "message.append":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.id ? { ...message, text: message.text + action.delta } : message,
        ),
      };
    case "messages.clear":
      return {
        ...state,
        messages: [newMessage("system", "Cleared. Type /help for commands.")],
      };
    case "activity.add":
      return {
        ...state,
        activities: [...state.activities, newActivity(action.level ?? "info", action.text)].slice(-20),
      };
    case "busy.set":
      return { ...state, busy: action.busy };
    case "context.toggle":
      return setLocalAccess(state, state.contextEnabled ? "off" : "approval");
    case "context.set":
      return setLocalAccess(state, action.enabled ? "approval" : "off");
    case "workdir.set":
      return {
        ...state,
        workdir: action.workdir,
        activities: [...state.activities, newActivity("success", `Workdir loaded: ${action.workdir.name}`)].slice(-20),
      };
    case "assistant.active":
      return { ...state, activeAssistantMessageId: action.id };
    case "local_tool.pending.set": {
      const pending = {
        ...action.approval,
        id: `local-${Date.now()}`,
        createdAt: Date.now(),
      };
      return {
        ...state,
        pendingLocalTool: pending,
        pendingAutomaticContinuation: null,
        pendingUpdate: null,
        activities: [
          ...state.activities,
          newActivity("warning", `Local approval ready: ${pending.name}${pending.action ? `.${pending.action}` : ""}`),
        ].slice(-20),
      };
    }
    case "local_tool.pending.clear":
      return {
        ...state,
        pendingLocalTool: null,
      };
    case "automatic_continuation.pending.set": {
      const pending = {
        ...action.pause,
        id: `continuation-${Date.now()}`,
        createdAt: Date.now(),
      };
      return {
        ...state,
        pendingLocalTool: null,
        pendingUpdate: null,
        pendingAutomaticContinuation: pending,
        activities: [
          ...state.activities,
          newActivity("warning", `Automatic continuation paused: ${pending.count}/${pending.limit}`),
        ].slice(-20),
      };
    }
    case "automatic_continuation.pending.clear":
      return {
        ...state,
        pendingAutomaticContinuation: null,
      };
    case "update.pending.set": {
      const pending = {
        result: action.result,
        id: `update-${Date.now()}`,
        createdAt: Date.now(),
      };
      return {
        ...state,
        pendingLocalTool: null,
        pendingAutomaticContinuation: null,
        pendingUpdate: pending,
        activities: [
          ...state.activities,
          newActivity("warning", `Update ready: ${pending.result.current} -> ${pending.result.latest}`),
        ].slice(-20),
      };
    }
    case "update.pending.clear":
      return {
        ...state,
        pendingUpdate: null,
      };
    case "automatic_continuation.unlock":
      return {
        ...state,
        automaticContinuationUnlocked: action.unlocked,
        activities: [
          ...state.activities,
          newActivity(action.unlocked ? "success" : "info", action.unlocked ? "Automatic continuation unlocked" : "Automatic continuation checkpoints restored"),
        ].slice(-20),
      };
    case "access.set":
      return setLocalAccess(state, action.mode);
    case "conversation.set":
      return {
        ...state,
        conversationId: action.id,
        currentConversation: action.name,
        conversationPreviousResponseId: action.previousResponseId,
        conversationStatus: action.status ?? (action.previousResponseId ? "continued" : "fresh"),
        automaticContinuationUnlocked: false,
        activities: [...state.activities, newActivity("info", conversationActivityText(action))].slice(-20),
      };
    case "settings.set":
      return {
        ...state,
        ...action.settings,
      };
    default:
      return state;
  }
}

function conversationActivityText(action: Extract<WorkbenchAction, { type: "conversation.set" }>) {
  const suffix = action.previousResponseId ? ` continues ${action.previousResponseId}` : action.status === "fresh" ? " fresh" : "";
  return `Conversation: ${action.name}${suffix}`;
}

function setLocalAccess(state: WorkbenchState, mode: WorkdirAccessMode): WorkbenchState {
  return {
    ...state,
    accessMode: mode,
    contextEnabled: mode !== "off",
    pendingLocalTool: mode === "off" ? null : state.pendingLocalTool,
    pendingAutomaticContinuation: mode === "off" ? null : state.pendingAutomaticContinuation,
    activities: [...state.activities, newActivity(mode === "off" ? "warning" : "success", `Local access: ${mode}`)].slice(-20),
  };
}

export function parseWorkbenchCommand(input: string): WorkbenchCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [name = "", ...rest] = trimmed.slice(1).split(/\s+/);
  switch (name) {
    case "abort":
    case "cancel":
      return { kind: "abort" };
    case "quit":
      return { kind: "quit" };
    case "exit":
      return { kind: "quit" };
    case "help":
      return { kind: "help" };
    case "clear":
      return { kind: "clear" };
    case "login":
    case "signin":
      return { kind: "login" };
    case "logout":
    case "signout":
      return { kind: "logout" };
    case "delete-profile":
    case "delete_profile":
      return { kind: "delete_profile" };
    case "switch-profile":
    case "switch_profile":
      return { kind: "switch_profile", name: rest.join(" ").trim() || undefined };
    case "auth":
      return { kind: "auth_status" };
    case "config":
    case "settings": {
      const [field, ...valueParts] = rest;
      if (!field) return { kind: "config" };
      if (field === "preset" || field === "continuation-limit" || field === "continuation" || field === "automatic-continuation-limit" || field === "isolator") {
        const normalizedField = field === "continuation" || field === "automatic-continuation-limit"
          ? "continuation-limit"
          : field;
        return { kind: "config", field: normalizedField, value: valueParts.join(" ").trim() || undefined };
      }
      if (field === "isolation") {
        return { kind: "config", field, value: valueParts.join(" ").trim() || undefined };
      }
      return { kind: "invalid", command: `${name} ${field}` };
    }
    case "render":
    case "display":
    case "view": {
      const mode = rest[0];
      if (mode === "raw" || mode === "markdown") return { kind: "render", mode };
      return { kind: "render" };
    }
    case "transcript":
      return { kind: "transcript" };
    case "copy": {
      const target = rest[0];
      if (!target || target === "page" || target === "visible") return { kind: "copy", target: "page" };
      if (target === "transcript" || target === "all") return { kind: "copy", target: "transcript" };
      if (target === "activity" || target === "activities") return { kind: "copy", target: "activity" };
      if (target === "header") return { kind: "copy", target: "header" };
      return { kind: "invalid", command: `copy ${target}` };
    }
    case "export":
      return { kind: "export", path: rest.join(" ").trim() || undefined };
    case "context":
      return { kind: "context", enabled: parseOnOff(rest[0]) };
    case "access": {
      const mode = rest[0];
      if (mode === "off" || mode === "approval" || mode === "full") return { kind: "access", mode };
      return { kind: "access" };
    }
    case "preset": {
      const value = rest.join(" ").trim();
      return { kind: "preset", value: value || undefined };
    }
    case "model": {
      const value = rest.join(" ").trim();
      return { kind: "model", value: value || undefined };
    }
    case "memory": {
      const [fieldOrValue, maybeValue, maybeToggle] = rest;
      if (fieldOrValue === "on") {
        return { kind: "invalid", command: "memory on" };
      }
      if (fieldOrValue === "off") {
        return { kind: "memory", enabled: false };
      }
      if (fieldOrValue === "read" && (maybeValue === "workspace" || maybeValue === "tenant" || maybeValue === "tenant-search")) {
        return { kind: "memory", field: "workspace", enabled: parseOnOff(maybeToggle) ?? true };
      }
      if (fieldOrValue === "read" || fieldOrValue === "write") {
        return { kind: "memory", field: fieldOrValue, enabled: parseOnOff(maybeValue) };
      }
      if (fieldOrValue === "workspace" || fieldOrValue === "tenant" || fieldOrValue === "tenant-search") {
        return { kind: "invalid", command: `memory ${fieldOrValue}` };
      }
      return { kind: "memory", enabled: undefined };
    }
    case "skills": {
      const [fieldOrValue, maybeValue] = rest;
      if (fieldOrValue === "local" || fieldOrValue === "workspace") {
        return { kind: "skills", field: fieldOrValue, enabled: parseOnOff(maybeValue) };
      }
      return { kind: "skills", enabled: parseOnOff(fieldOrValue) };
    }
    case "local-skills":
    case "local_skills":
      return { kind: "skills", field: "local", enabled: parseOnOff(rest[0]) };
    case "workspace-skills":
    case "workspace_skills":
      return { kind: "skills", field: "workspace", enabled: parseOnOff(rest[0]) };
    case "workdir":
    case "local":
      return { kind: "workdir", enabled: parseOnOff(rest[0]) };
    case "summary":
      return { kind: "summary" };
    case "new":
    case "thread":
      return { kind: "new_conversation", name: rest.join(" ").trim() || undefined };
    case "conversation":
    case "switch":
    case "use":
      if (rest.length === 0) return { kind: "list_conversations" };
      return { kind: "switch_conversation", name: rest.join(" ").trim() };
    case "conversations":
    case "threads":
      return { kind: "list_conversations" };
    case "refresh":
    case "reload":
    case "refresh-catalog":
      return { kind: "refresh_catalog" };
    case "update":
    case "upgrade":
      return { kind: "update" };
    case "search":
    case "grep":
      return { kind: "search", query: rest.join(" ").trim() };
    case "preview":
      return { kind: "preview" };
    case "resume":
      return { kind: "resume", message: rest.join(" ").trim() || undefined };
    case "apply":
      return { kind: "apply" };
    case "apply-all":
    case "yes-all":
      return { kind: "apply_all" };
    case "reject":
      return { kind: "reject" };
    default:
      return { kind: "invalid", command: name };
  }
}

export function parsePendingApprovalCommand(input: string): WorkbenchCommand | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.startsWith("/")) return null;
  const [name = ""] = trimmed.slice(1).split(/\s+/);
  switch (name) {
    case "apply":
    case "yes":
      return { kind: "apply" };
    case "apply-all":
    case "yes-all":
      return { kind: "apply_all" };
    case "reject":
    case "no":
      return { kind: "reject" };
    default:
      return null;
  }
}

export function helpText() {
  return [
    "Commands:",
    "/auth            show current auth profile",
    "/login           return to auth gate without deleting profiles",
    "/logout          leave current session and return to auth gate",
    "/switch-profile  switch/sign in with a different profile",
    "/delete-profile  delete current saved profile and return to auth",
    "/config          show current run configuration and saved defaults",
    "/render [mode]   show or set output rendering: markdown or raw",
    "/transcript      show a plain-text transcript preview",
    "/copy [target]   copy page, header, transcript, or activity text to clipboard",
    "/export [file]   save the plain-text transcript to a file",
    "/config preset   save default preset; use none/off for no preset, reset for built-in",
    "/config continuation-limit save automatic continuation checkpoint limit",
    "/config isolation save shell isolation mode: none, auto, or required",
    "/config isolator save agent-isolator path; use none/off to clear",
    "/preset [name]   show or set preset; use none/off to clear",
    "/model [name]    show or set explicit model; use auto/none/off to clear",
    "/memory          show memory options; /memory off clears memory options",
    "/memory read|write [on|off] toggle memory read or write",
    "/memory read workspace [on|off] toggle read-scoped workspace memory search",
    "/skills          show or toggle local/workspace skill discovery",
    "/skills local|workspace [on|off] toggle skill discovery scopes",
    "/access [mode]   show or set local tool access: off, approval, or full",
    "/workdir       show local workdir status",
    "/workdir on    shortcut for /access approval; /workdir off hides local tools",
    "/new [name]      start a fresh conversation in this workbench",
    "/switch <name>   switch to an existing/new conversation handle",
    "/conversations   list saved local conversation handles",
    "/update          check for a CLI update; /apply installs when available",
    "/summary         show local workdir summary previews",
    "/search <query>  search text in the local workdir",
    "/preview         show pending action or continuation checkpoint",
    "/resume [msg]    resume a timed local pause without aborting the run",
    "/apply           apply or continue pending action once",
    "/apply-all       apply/continue and relax future prompts for this turn",
    "/reject          reject or stop pending action",
    "/abort           cancel the in-flight agent turn",
    "/context         toggle local context packaging for each agent turn",
    "/clear           clear the visible transcript",
    "/quit            leave the workbench",
  ].join("\n");
}

export function formatTranscript(messages: WorkbenchMessage[]) {
  return messages
    .map((message) => {
      const body = message.text.trimEnd();
      return body ? `${messageLabel(message)}:\n${body}` : `${messageLabel(message)}:`;
    })
    .join("\n\n")
    .trimEnd() + "\n";
}

export function formatTranscriptPreview(messages: WorkbenchMessage[], maxLines = 80) {
  const lines = formatTranscript(messages).trimEnd().split(/\r?\n/);
  if (lines.length <= maxLines) {
    return ["Transcript preview:", "", ...lines].join("\n");
  }
  return [
    `Transcript preview: showing last ${maxLines} lines of ${lines.length}. Use /export [file] for the full transcript.`,
    "",
    ...lines.slice(-maxLines),
  ].join("\n");
}

function parseOnOff(value?: string) {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["on", "enable", "enabled", "yes", "true"].includes(normalized)) return true;
  if (["off", "disable", "disabled", "no", "false"].includes(normalized)) return false;
  return undefined;
}

export function workdirText(status: WorkbenchWorkdirStatus | null) {
  if (!status) return "Workdir summary is still loading.";
  return [
    `Workdir: ${status.root}`,
    `Files: ${status.fileCount}`,
    `Size: ${formatBytes(status.totalBytes)}`,
    `Scan truncated: ${status.scanTruncated ? "yes" : "no"}`,
  ].join("\n");
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function newMessage(role: WorkbenchRole, text: string, id = randomId(), kind?: WorkbenchMessageKind): WorkbenchMessage {
  return { id, kind, role, text };
}

function roleLabel(role: WorkbenchRole) {
  if (role === "user") return "You";
  if (role === "assistant") return "Agent";
  return "System";
}

function messageLabel(message: WorkbenchMessage) {
  if (message.kind === "tool") return "Tool";
  return roleLabel(message.role);
}

function newActivity(level: ActivityLevel, text: string): WorkbenchActivity {
  return {
    id: randomId(),
    level,
    text,
    timestamp: Date.now(),
  };
}

function randomId() {
  return Math.random().toString(36).slice(2);
}
