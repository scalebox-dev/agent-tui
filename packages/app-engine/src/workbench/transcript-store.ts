import { formatTranscript, type WorkbenchMessage } from "./state.js";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export interface WorkbenchTranscriptStore {
  appendMessage(conversationId: string, message: WorkbenchMessage): Promise<void>;
  appendMessageDelta(conversationId: string, messageId: string, delta: string): Promise<void>;
  clearConversation(conversationId: string): Promise<void>;
  exportConversation(conversationId: string): Promise<string>;
  getConversationSummary(conversationId: string): Promise<WorkbenchTranscriptSummary>;
  loadAfterMessages(conversationId: string, afterSeq: number, limit: number): Promise<WorkbenchMessage[]>;
  loadBeforeMessages(conversationId: string, beforeSeq: number, limit: number): Promise<WorkbenchMessage[]>;
  loadRecentMessages(conversationId: string, limit: number): Promise<WorkbenchMessage[]>;
  dispose?(): void;
}

export interface WorkbenchTranscriptSummary {
  latestSnippet: string;
  messageCount: number;
  titleSnippet: string;
  updatedAt?: number;
}

export function createMemoryTranscriptStore(): WorkbenchTranscriptStore {
  const conversations = new Map<string, WorkbenchMessage[]>();
  return {
    async appendMessage(conversationId, message) {
      const messages = messagesFor(conversationId);
      const index = messages.findIndex((item) => item.id === message.id);
      if (index >= 0) {
        conversations.set(conversationId, messages.map((item, itemIndex) =>
          itemIndex === index ? cloneMessage(message) : item,
        ));
      } else {
        conversations.set(conversationId, [...messages, cloneMessage(message)]);
      }
    },
    async appendMessageDelta(conversationId, messageId, delta) {
      conversations.set(conversationId, messagesFor(conversationId).map((message) =>
        message.id === messageId ? { ...message, text: message.text + delta } : message,
      ));
    },
    async clearConversation(conversationId) {
      conversations.delete(conversationId);
    },
    async exportConversation(conversationId) {
      return formatTranscript(messagesFor(conversationId));
    },
    async getConversationSummary(conversationId) {
      return summarizeMessages(messagesFor(conversationId));
    },
    async loadAfterMessages(conversationId, afterSeq, limit) {
      return messagesFor(conversationId)
        .map((message, index) => ({ ...cloneMessage(message), transcriptSeq: index + 1 }))
        .filter((message) => (message.transcriptSeq ?? 0) > afterSeq)
        .slice(0, Math.max(0, limit));
    },
    async loadBeforeMessages(conversationId, beforeSeq, limit) {
      return messagesFor(conversationId)
        .map((message, index) => ({ ...cloneMessage(message), transcriptSeq: index + 1 }))
        .filter((message) => (message.transcriptSeq ?? 0) < beforeSeq)
        .slice(-Math.max(0, limit));
    },
    async loadRecentMessages(conversationId, limit) {
      const messages = messagesFor(conversationId);
      return messages.slice(-Math.max(0, limit)).map((message, index, sliced) => ({
        ...cloneMessage(message),
        transcriptSeq: messages.length - sliced.length + index + 1,
      }));
    },
  };

  function messagesFor(conversationId: string) {
    return conversations.get(conversationId) ?? [];
  }
}

export function createFileTranscriptStore(root: string): WorkbenchTranscriptStore {
  return {
    async appendMessage(conversationId, message) {
      await appendTranscriptEvent(root, conversationId, {
        type: "message",
        message: cloneMessage(message),
      });
    },
    async appendMessageDelta(conversationId, messageId, delta) {
      if (!delta) return;
      await appendTranscriptEvent(root, conversationId, {
        type: "delta",
        delta,
        messageId,
      });
    },
    async clearConversation(conversationId) {
      await rm(transcriptFile(root, conversationId), { force: true });
    },
    async exportConversation(conversationId) {
      return formatTranscript(await loadMessages(root, conversationId));
    },
    async getConversationSummary(conversationId) {
      return summarizeMessages(await loadMessages(root, conversationId));
    },
    async loadAfterMessages(conversationId, afterSeq, limit) {
      return (await loadMessages(root, conversationId))
        .filter((message) => (message.transcriptSeq ?? 0) > afterSeq)
        .slice(0, Math.max(0, limit));
    },
    async loadBeforeMessages(conversationId, beforeSeq, limit) {
      return (await loadMessages(root, conversationId))
        .filter((message) => (message.transcriptSeq ?? 0) < beforeSeq)
        .slice(-Math.max(0, limit));
    },
    async loadRecentMessages(conversationId, limit) {
      return (await loadMessages(root, conversationId)).slice(-Math.max(0, limit));
    },
  };
}

export function shouldPersistTranscriptMessage(message: WorkbenchMessage) {
  return message.role === "user" || message.role === "assistant" || message.kind === "tool";
}

export function summarizeMessages(
  messages: readonly WorkbenchMessage[],
  options: { updatedAt?: number } = {},
): WorkbenchTranscriptSummary {
  const meaningful = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const firstUser = meaningful.find((message) => message.role === "user" && snippetText(message.text));
  const latest = [...meaningful].reverse().find((message) => snippetText(message.text));
  return {
    latestSnippet: snippetText(latest?.text) || "",
    messageCount: messages.length,
    titleSnippet: snippetText(firstUser?.text) || snippetText(latest?.text) || "",
    updatedAt: options.updatedAt,
  };
}

function cloneMessage(message: WorkbenchMessage): WorkbenchMessage {
  return { ...message };
}

function snippetText(text?: string) {
  const normalized = (text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

async function loadMessages(root: string, conversationId: string): Promise<WorkbenchMessage[]> {
  try {
    return parseTranscriptLines(await readFile(transcriptFile(root, conversationId), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

type FileTranscriptEvent =
  | { type: "delta"; delta: string; messageId: string }
  | { type: "message"; message: WorkbenchMessage };

async function appendTranscriptEvent(root: string, conversationId: string, event: FileTranscriptEvent) {
  await mkdir(root, { recursive: true });
  await appendFile(transcriptFile(root, conversationId), `${JSON.stringify(event)}\n`, "utf8");
}

function parseTranscriptLines(text: string): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line) as unknown;
    const event = normalizeFileTranscriptEvent(record);
    if (event.type === "message") {
      const message = normalizeMessage(event.message);
      const index = messages.findIndex((item) => item.id === message.id);
      if (index >= 0) messages[index] = message;
      else messages.push(message);
    } else if (event.type === "delta") {
      const index = messages.findIndex((item) => item.id === event.messageId);
      if (index >= 0) messages[index] = { ...messages[index], text: messages[index].text + event.delta };
    }
  }
  return messages.map((message, index) => ({ ...message, transcriptSeq: index + 1 }));
}

function normalizeFileTranscriptEvent(value: unknown): FileTranscriptEvent {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (record.type === "delta") {
    return {
      type: "delta",
      delta: typeof record.delta === "string" ? record.delta : "",
      messageId: typeof record.messageId === "string" ? record.messageId : "",
    };
  }
  if (record.type === "message") {
    return {
      type: "message",
      message: normalizeMessage(record.message),
    };
  }
  return {
    type: "message",
    message: normalizeMessage(record),
  };
}

function normalizeMessage(value: unknown): WorkbenchMessage {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const message: WorkbenchMessage = {
    id: typeof record.id === "string" ? record.id : "",
    role: roleValue(record.role),
    text: typeof record.text === "string" ? record.text : "",
  };
  if (record.kind === "tool") message.kind = "tool";
  return message;
}

function roleValue(value: unknown): WorkbenchMessage["role"] {
  return value === "user" || value === "assistant" || value === "system" ? value : "system";
}

function transcriptFile(root: string, conversationId: string) {
  return path.join(root, `${safeFileName(conversationId)}.jsonl`);
}

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "conversation";
}
