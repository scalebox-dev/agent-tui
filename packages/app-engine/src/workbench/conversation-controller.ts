import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  conversationSummary,
  deleteWorkspaceConversation,
  ensureConversation,
  listConversations,
  renameConversation,
  startFreshConversation,
  updateConversationRunSettings,
} from "../agent.js";
import { runtime } from "../runtime/index.js";
import type { ConversationRunSettings } from "../config.js";

export interface WorkbenchConversationController {
  resolveConversation(name: string, profileName?: string, workspaceId?: string, workspaceName?: string): Promise<ConversationSelection>;
  startNewConversation(name: string | undefined, profileName?: string, workspaceId?: string, workspaceName?: string): Promise<ConversationSelection>;
  switchConversation(name: string, profileName?: string, workspaceId?: string, workspaceName?: string): Promise<ConversationSelection>;
  renameConversation(name: string, nextName: string, profileName?: string, workspaceId?: string): Promise<ConversationSelection>;
  deleteConversation(name: string, profileName?: string, workspaceId?: string): Promise<ConversationDeletion>;
  listConversationSelections(profileName?: string, workspaceId?: string): Promise<ConversationSelection[]>;
  listConversations(profileName?: string, query?: string, workspaceId?: string): Promise<string>;
  updateRunSettings(name: string, runSettings: ConversationRunSettings, profileName?: string, workspaceId?: string): Promise<void>;
  exportTranscript(input: { path?: string; transcript: string; conversation: string }): Promise<string>;
}

export interface ConversationSelection {
  createdAt?: number;
  id: string;
  name: string;
  previousResponseId?: string;
  profile?: string;
  runSettings?: ConversationRunSettings;
  status: "fresh" | "continued";
  updatedAt?: number;
  workspaceId?: string;
  workspaceName?: string;
  message: string;
}

export interface ConversationDeletion {
  message: string;
  name: string;
}

export interface WorkbenchConversationControllerOptions {
  deleteWorkspaceConversationImpl?: typeof deleteWorkspaceConversation;
  listConversationsImpl?: typeof listConversations;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
  now?: () => Date;
  dataDir?: string;
  ensureConversationImpl?: typeof ensureConversation;
  renameConversationImpl?: typeof renameConversation;
  startFreshConversationImpl?: typeof startFreshConversation;
  updateConversationRunSettingsImpl?: typeof updateConversationRunSettings;
}

export function createWorkbenchConversationController(
  options: WorkbenchConversationControllerOptions = {},
): WorkbenchConversationController {
  const deleteWorkspaceConversationImpl = options.deleteWorkspaceConversationImpl ?? deleteWorkspaceConversation;
  const listConversationsImpl = options.listConversationsImpl ?? listConversations;
  const ensureConversationImpl = options.ensureConversationImpl ?? ensureConversation;
  const renameConversationImpl = options.renameConversationImpl ?? renameConversation;
  const startFreshConversationImpl = options.startFreshConversationImpl ?? startFreshConversation;
  const updateConversationRunSettingsImpl = options.updateConversationRunSettingsImpl ?? updateConversationRunSettings;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const now = options.now ?? (() => new Date());

  return {
    async resolveConversation(name, profileName, workspaceId, workspaceName) {
      const conversation = await ensureConversationImpl(name, profileName, workspaceId, workspaceName);
      return conversationSelection(conversation, `Conversation "${conversation.name}" is ${conversation.previousResponseId ? `continuing from ${conversation.previousResponseId}` : "fresh"}.`);
    },

    async startNewConversation(name, profileName, workspaceId, workspaceName) {
      const nameToUse = name || createConversationName(now());
      await deleteWorkspaceConversationImpl(nameToUse, profileName, workspaceId);
      const conversation = await startFreshConversationImpl(nameToUse, profileName, workspaceId, workspaceName);
      return conversationSelection(conversation, `Started fresh conversation "${conversation.name}" (${conversation.id}).`);
    },

    async switchConversation(name, profileName, workspaceId, workspaceName) {
      const conversation = await ensureConversationImpl(name, profileName, workspaceId, workspaceName);
      return conversationSelection(
        conversation,
        conversation.previousResponseId
          ? `Switched to conversation "${name}" (${conversation.id}). Continuing from ${conversation.previousResponseId}.`
          : `Switched to fresh conversation "${name}" (${conversation.id}).`,
      );
    },

    async renameConversation(name, nextName, profileName, workspaceId) {
      const conversation = await renameConversationImpl(name, nextName, profileName, workspaceId);
      return conversationSelection(
        conversation,
        `Renamed conversation "${name}" to "${conversation.name}".`,
      );
    },

    async deleteConversation(name, profileName, workspaceId) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Conversation name is required.");
      await deleteWorkspaceConversationImpl(trimmed, profileName, workspaceId);
      return {
        name: trimmed,
        message: `Deleted conversation "${trimmed}".`,
      };
    },

    async listConversations(profileName, query, workspaceId) {
      const conversations = await listConversationsImpl(profileName, workspaceId);
      const filtered = filterConversations(conversations, query);
      if (conversations.length === 0) return "No saved conversations yet.";
      if (filtered.length === 0) return `No conversations match: ${query}`;
      return filtered.map(conversationSummary).join("\n");
    },

    async listConversationSelections(profileName, workspaceId) {
      const conversations = await listConversationsImpl(profileName, workspaceId);
      return conversations.map((conversation) => conversationSelection(conversation, ""));
    },

    async updateRunSettings(name, runSettings, profileName, workspaceId) {
      await updateConversationRunSettingsImpl({ conversation: name, profile: profileName, workspaceId }, runSettings);
    },

    async exportTranscript(input) {
      const file = input.path?.trim()
        ? path.resolve(process.cwd(), input.path.trim())
        : defaultTranscriptExportPath(input.conversation, {
          dataDir: options.dataDir,
          now,
        });
      await mkdirImpl(path.dirname(file), { recursive: true });
      await writeFileImpl(file, input.transcript, "utf8");
      return file;
    },
  };
}

function filterConversations<T extends {
    id: string;
    name: string;
    previousResponseId?: string;
    profile: string;
    workspaceId?: string;
    workspaceName?: string;
  }>(
  conversations: T[],
  query?: string,
): T[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return conversations;
  return conversations.filter((conversation) =>
    [
      conversation.id,
      conversation.name,
      conversation.previousResponseId ?? "",
      conversation.profile,
      conversation.workspaceId ?? "",
      conversation.workspaceName ?? "",
    ].some((value) => value.toLowerCase().includes(needle)),
  );
}

function conversationSelection(
  conversation: {
    createdAt?: number;
    id: string;
    name: string;
    previousResponseId?: string;
    profile?: string;
    runSettings?: ConversationRunSettings;
    updatedAt?: number;
    workspaceId?: string;
    workspaceName?: string;
  },
  message: string,
): ConversationSelection {
  const selection: ConversationSelection = {
    createdAt: conversation.createdAt,
    id: conversation.id,
    name: conversation.name,
    profile: conversation.profile,
    status: conversation.previousResponseId ? "continued" : "fresh",
    updatedAt: conversation.updatedAt,
    message,
  };
  if (conversation.previousResponseId) selection.previousResponseId = conversation.previousResponseId;
  if (conversation.runSettings) selection.runSettings = conversation.runSettings;
  if (conversation.workspaceId) selection.workspaceId = conversation.workspaceId;
  if (conversation.workspaceName) selection.workspaceName = conversation.workspaceName;
  return selection;
}

export function defaultTranscriptExportPath(
  conversation: string,
  options: { dataDir?: string; now?: () => Date } = {},
) {
  const safeConversation = conversation.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "conversation";
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return path.join(options.dataDir ?? runtime.dirs.data, "transcripts", `${safeConversation}-${stamp}.txt`);
}

export function createConversationName(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `thread-${stamp}`;
}
