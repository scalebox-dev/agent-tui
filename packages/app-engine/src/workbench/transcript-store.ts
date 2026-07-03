import { formatTranscript, type WorkbenchMessage } from "./state.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkbenchTranscriptStore {
  appendMessage(conversationId: string, message: WorkbenchMessage): Promise<void>;
  appendMessageDelta(conversationId: string, messageId: string, delta: string): Promise<void>;
  clearConversation(conversationId: string): Promise<void>;
  exportConversation(conversationId: string): Promise<string>;
  loadAfterMessages(conversationId: string, afterSeq: number, limit: number): Promise<WorkbenchMessage[]>;
  loadBeforeMessages(conversationId: string, beforeSeq: number, limit: number): Promise<WorkbenchMessage[]>;
  loadRecentMessages(conversationId: string, limit: number): Promise<WorkbenchMessage[]>;
  dispose?(): void;
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
      const messages = await loadMessages(root, conversationId);
      const index = messages.findIndex((item) => item.id === message.id);
      if (index >= 0) messages[index] = cloneMessage(message);
      else messages.push(cloneMessage(message));
      await saveMessages(root, conversationId, messages);
    },
    async appendMessageDelta(conversationId, messageId, delta) {
      const messages = await loadMessages(root, conversationId);
      const index = messages.findIndex((item) => item.id === messageId);
      if (index >= 0) {
        messages[index] = { ...messages[index], text: messages[index].text + delta };
        await saveMessages(root, conversationId, messages);
      }
    },
    async clearConversation(conversationId) {
      await rm(transcriptFile(root, conversationId), { force: true });
    },
    async exportConversation(conversationId) {
      return formatTranscript(await loadMessages(root, conversationId));
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

function cloneMessage(message: WorkbenchMessage): WorkbenchMessage {
  return { ...message };
}

async function loadMessages(root: string, conversationId: string): Promise<WorkbenchMessage[]> {
  try {
    return parseTranscriptLines(await readFile(transcriptFile(root, conversationId), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function saveMessages(root: string, conversationId: string, messages: WorkbenchMessage[]) {
  await mkdir(root, { recursive: true });
  await writeFile(transcriptFile(root, conversationId), `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
}

function parseTranscriptLines(text: string): WorkbenchMessage[] {
  return text.split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => ({ ...normalizeMessage(JSON.parse(line)), transcriptSeq: index + 1 }));
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
