import type { LocalToolApprovalRequest, WorkspaceAccessMode } from "../agent.js";

export type WorkbenchRole = "user" | "assistant" | "system";

export interface WorkbenchMessage {
  id: string;
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

export interface WorkbenchWorkspaceStatus {
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

export interface WorkbenchState {
  messages: WorkbenchMessage[];
  activities: WorkbenchActivity[];
  busy: boolean;
  contextEnabled: boolean;
  workspace: WorkbenchWorkspaceStatus | null;
  activeAssistantMessageId: string | null;
  pendingLocalTool: LocalToolApproval | null;
  accessMode: WorkspaceAccessMode;
  currentConversation: string;
}

export type WorkbenchAction =
  | { type: "message.add"; role: WorkbenchRole; text: string; id?: string }
  | { type: "message.append"; id: string; delta: string }
  | { type: "messages.clear" }
  | { type: "activity.add"; level?: ActivityLevel; text: string }
  | { type: "busy.set"; busy: boolean }
  | { type: "context.toggle" }
  | { type: "context.set"; enabled: boolean }
  | { type: "workspace.set"; workspace: WorkbenchWorkspaceStatus }
  | { type: "assistant.active"; id: string | null }
  | { type: "local_tool.pending.set"; approval: LocalToolApprovalRequest }
  | { type: "local_tool.pending.clear" }
  | { type: "access.set"; mode: WorkspaceAccessMode }
  | { type: "conversation.set"; name: string };

export type WorkbenchCommand =
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "auth_status" }
  | { kind: "config" }
  | { kind: "context" }
  | { kind: "workspace" }
  | { kind: "access"; mode?: WorkspaceAccessMode }
  | { kind: "preset"; value?: string }
  | { kind: "model"; value?: string }
  | { kind: "summary" }
  | { kind: "search"; query: string }
  | { kind: "new_conversation"; name?: string }
  | { kind: "switch_conversation"; name: string }
  | { kind: "list_conversations" }
  | { kind: "refresh_catalog" }
  | { kind: "preview" }
  | { kind: "apply" }
  | { kind: "apply_all" }
  | { kind: "reject" };

export function createInitialWorkbenchState(options: { contextEnabled: boolean; accessMode?: WorkspaceAccessMode; conversation?: string }): WorkbenchState {
  return {
    messages: [
      newMessage("system", "Agent API Workbench is ready. Type /help for commands."),
    ],
    activities: [
      newActivity("info", "Workbench started"),
    ],
    busy: false,
    contextEnabled: options.contextEnabled,
    workspace: null,
    activeAssistantMessageId: null,
    pendingLocalTool: null,
    accessMode: options.accessMode ?? "approval",
    currentConversation: options.conversation || "default",
  };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "message.add":
      return {
        ...state,
        messages: [...state.messages, newMessage(action.role, action.text, action.id)],
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
      return {
        ...state,
        contextEnabled: !state.contextEnabled,
        activities: [
          ...state.activities,
          newActivity("info", `Local context ${state.contextEnabled ? "disabled" : "enabled"}`),
        ].slice(-20),
      };
    case "context.set":
      return { ...state, contextEnabled: action.enabled };
    case "workspace.set":
      return {
        ...state,
        workspace: action.workspace,
        activities: [...state.activities, newActivity("success", `Workspace loaded: ${action.workspace.name}`)].slice(-20),
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
    case "access.set":
      return {
        ...state,
        accessMode: action.mode,
        activities: [...state.activities, newActivity("warning", `Workspace access: ${action.mode}`)].slice(-20),
      };
    case "conversation.set":
      return {
        ...state,
        currentConversation: action.name,
        activities: [...state.activities, newActivity("info", `Conversation: ${action.name}`)].slice(-20),
      };
    default:
      return state;
  }
}

export function parseWorkbenchCommand(input: string): WorkbenchCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [name = "", ...rest] = trimmed.slice(1).split(/\s+/);
  switch (name) {
    case "exit":
    case "quit":
      return { kind: "exit" };
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
    case "auth":
      return { kind: "auth_status" };
    case "config":
    case "settings":
      return { kind: "config" };
    case "context":
      return { kind: "context" };
    case "access": {
      const mode = rest[0];
      if (mode === "approval" || mode === "full") return { kind: "access", mode };
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
    case "workspace":
      return { kind: "workspace" };
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
    case "search":
    case "grep":
      return { kind: "search", query: rest.join(" ").trim() };
    case "preview":
      return { kind: "preview" };
    case "apply":
      return { kind: "apply" };
    case "apply-all":
    case "yes-all":
      return { kind: "apply_all" };
    case "reject":
      return { kind: "reject" };
    default:
      return { kind: "help" };
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
    "/login           sign in or switch auth method",
    "/logout          delete current local auth profile and return to auth",
    "/config          show current run configuration",
    "/preset [name]   show or set preset; use none/off to clear",
    "/model [name]    show or set explicit model; use auto/none/off to clear",
    "/access [mode]   show or set local access: approval or full",
    "/workspace       show current local workspace status",
    "/new [name]      start a fresh conversation in this workbench",
    "/switch <name>   switch to an existing/new conversation handle",
    "/conversations   list saved local conversation handles",
    "/summary         show local workspace summary previews",
    "/search <query>  search text in the local workspace",
    "/preview         show pending local action preview",
    "/apply           apply pending local action",
    "/apply-all       apply pending action and allow future local actions",
    "/reject          reject pending local action",
    "/context         toggle local context packaging for each agent turn",
    "/clear           clear the visible terminal transcript",
    "/exit            leave the workbench",
  ].join("\n");
}

export function workspaceText(status: WorkbenchWorkspaceStatus | null) {
  if (!status) return "Workspace summary is still loading.";
  return [
    `Workspace: ${status.root}`,
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

export function activityColor(level: ActivityLevel) {
  if (level === "success") return "green";
  if (level === "warning") return "yellow";
  if (level === "error") return "red";
  return "gray";
}

function newMessage(role: WorkbenchRole, text: string, id = randomId()): WorkbenchMessage {
  return { id, role, text };
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
