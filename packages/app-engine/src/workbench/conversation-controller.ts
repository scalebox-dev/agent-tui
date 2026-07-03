import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  conversationSummary,
  deleteConversation,
  ensureConversation,
  listConversations,
  startFreshConversation,
} from "../agent.js";
import { runtime } from "../runtime/index.js";

export interface WorkbenchConversationController {
  resolveConversation(name: string, profileName?: string): Promise<ConversationSelection>;
  startNewConversation(name: string | undefined, profileName?: string): Promise<ConversationSelection>;
  switchConversation(name: string, profileName?: string): Promise<ConversationSelection>;
  listConversationSelections(profileName?: string): Promise<ConversationSelection[]>;
  listConversations(profileName?: string): Promise<string>;
  exportTranscript(input: { path?: string; transcript: string; conversation: string }): Promise<string>;
}

export interface ConversationSelection {
  createdAt?: number;
  id: string;
  name: string;
  previousResponseId?: string;
  profile?: string;
  status: "fresh" | "continued";
  updatedAt?: number;
  message: string;
}

export interface WorkbenchConversationControllerOptions {
  deleteConversationImpl?: typeof deleteConversation;
  listConversationsImpl?: typeof listConversations;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
  now?: () => Date;
  dataDir?: string;
  ensureConversationImpl?: typeof ensureConversation;
  startFreshConversationImpl?: typeof startFreshConversation;
}

export function createWorkbenchConversationController(
  options: WorkbenchConversationControllerOptions = {},
): WorkbenchConversationController {
  const deleteConversationImpl = options.deleteConversationImpl ?? deleteConversation;
  const listConversationsImpl = options.listConversationsImpl ?? listConversations;
  const ensureConversationImpl = options.ensureConversationImpl ?? ensureConversation;
  const startFreshConversationImpl = options.startFreshConversationImpl ?? startFreshConversation;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const now = options.now ?? (() => new Date());

  return {
    async resolveConversation(name, profileName) {
      const conversation = await ensureConversationImpl(name, profileName);
      return conversationSelection(conversation, `Conversation "${conversation.name}" is ${conversation.previousResponseId ? `continuing from ${conversation.previousResponseId}` : "fresh"}.`);
    },

    async startNewConversation(name, profileName) {
      const nameToUse = name || createConversationName(now());
      await deleteConversationImpl(nameToUse, profileName);
      const conversation = await startFreshConversationImpl(nameToUse, profileName);
      return conversationSelection(conversation, `Started fresh conversation "${conversation.name}" (${conversation.id}).`);
    },

    async switchConversation(name, profileName) {
      const conversation = await ensureConversationImpl(name, profileName);
      return conversationSelection(
        conversation,
        conversation.previousResponseId
          ? `Switched to conversation "${name}" (${conversation.id}). Continuing from ${conversation.previousResponseId}.`
          : `Switched to fresh conversation "${name}" (${conversation.id}).`,
      );
    },

    async listConversations(profileName) {
      const conversations = await listConversationsImpl(profileName);
      return conversations.length === 0
        ? "No saved conversations yet."
        : conversations.map(conversationSummary).join("\n");
    },

    async listConversationSelections(profileName) {
      const conversations = await listConversationsImpl(profileName);
      return conversations.map((conversation) => conversationSelection(conversation, ""));
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

function conversationSelection(
  conversation: {
    createdAt?: number;
    id: string;
    name: string;
    previousResponseId?: string;
    profile?: string;
    updatedAt?: number;
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
