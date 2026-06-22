import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  conversationSummary,
  deleteConversation,
  listConversations,
} from "../agent.js";
import { runtime } from "../runtime/index.js";

export interface WorkbenchConversationController {
  startNewConversation(name: string | undefined, profileName?: string): Promise<{ name: string; message: string }>;
  switchConversation(name: string): { name: string; message: string };
  listConversations(profileName?: string): Promise<string>;
  exportTranscript(input: { path?: string; transcript: string; conversation: string }): Promise<string>;
}

export interface WorkbenchConversationControllerOptions {
  deleteConversationImpl?: typeof deleteConversation;
  listConversationsImpl?: typeof listConversations;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
  now?: () => Date;
  dataDir?: string;
}

export function createWorkbenchConversationController(
  options: WorkbenchConversationControllerOptions = {},
): WorkbenchConversationController {
  const deleteConversationImpl = options.deleteConversationImpl ?? deleteConversation;
  const listConversationsImpl = options.listConversationsImpl ?? listConversations;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const now = options.now ?? (() => new Date());

  return {
    async startNewConversation(name, profileName) {
      const conversation = name || createConversationName(now());
      await deleteConversationImpl(conversation, profileName);
      return {
        name: conversation,
        message: `Started fresh conversation "${conversation}".`,
      };
    },

    switchConversation(name) {
      return {
        name,
        message: `Switched to conversation "${name}". Future turns will continue this handle when history exists.`,
      };
    },

    async listConversations(profileName) {
      const conversations = await listConversationsImpl(profileName);
      return conversations.length === 0
        ? "No saved conversations yet."
        : conversations.map(conversationSummary).join("\n");
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
