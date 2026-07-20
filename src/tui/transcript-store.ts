import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  currentAgentAppRuntime,
} from "@agent-api/app-engine/core";
import type { LocalKnowledgeService } from "@agent-api/sdk/local";
import {
  createFileTranscriptStore,
  formatTranscript,
  summarizeMessages,
  type WorkbenchMessage,
  type WorkbenchTranscriptStore,
} from "@agent-api/app-engine/workbench";

export interface DefaultTranscriptStoreOptions {
  localKnowledge?: LocalKnowledgeService;
  localKnowledgeIngestDelayMs?: number;
}

export function createDefaultTranscriptStore(options: DefaultTranscriptStoreOptions = {}): WorkbenchTranscriptStore {
  const dataDir = currentAgentAppRuntime().runtime.dirs.data;
  mkdirSync(dataDir, { recursive: true });
  try {
    return createSQLiteTranscriptStore(path.join(dataDir, "transcripts.sqlite3"), options);
  } catch {
    return createFileTranscriptStore(path.join(dataDir, "transcripts"));
  }
}

export function createSQLiteTranscriptStore(file: string, options: DefaultTranscriptStoreOptions = {}): WorkbenchTranscriptStore {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_messages_conversation_seq
      ON transcript_messages(conversation_id, seq);
  `);

  const insertMessage = db.prepare(`
    INSERT INTO transcript_messages (
      conversation_id, message_id, role, kind, text, created_at, updated_at
    ) VALUES (
      @conversationId, @messageId, @role, @kind, @text, @now, @now
    )
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET
      role = excluded.role,
      kind = excluded.kind,
      text = excluded.text,
      updated_at = excluded.updated_at
  `);
  const appendDelta = db.prepare(`
    UPDATE transcript_messages
    SET text = text || @delta, updated_at = @now
    WHERE conversation_id = @conversationId AND message_id = @messageId
  `);
  const recentMessages = db.prepare(`
    SELECT seq, message_id, role, kind, text
    FROM transcript_messages
    WHERE conversation_id = ?
    ORDER BY seq DESC
    LIMIT ?
  `);
  const beforeMessages = db.prepare(`
    SELECT seq, message_id, role, kind, text
    FROM transcript_messages
    WHERE conversation_id = ? AND seq < ?
    ORDER BY seq DESC
    LIMIT ?
  `);
  const afterMessages = db.prepare(`
    SELECT seq, message_id, role, kind, text
    FROM transcript_messages
    WHERE conversation_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `);
  const allMessages = db.prepare(`
    SELECT seq, message_id, role, kind, text
    FROM transcript_messages
    WHERE conversation_id = ?
    ORDER BY seq ASC
  `);
  const conversationUpdatedAt = db.prepare(`
    SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at
    FROM transcript_messages
    WHERE conversation_id = ?
  `);
  const deleteConversation = db.prepare("DELETE FROM transcript_messages WHERE conversation_id = ?");
  const messageByID = db.prepare(`
    SELECT seq, message_id, role, kind, text
    FROM transcript_messages
    WHERE conversation_id = ? AND message_id = ?
  `);
  const knowledgeIngestDelayMs = Math.max(0, options.localKnowledgeIngestDelayMs ?? 1500);
  const pendingKnowledgeIngests = new Map<string, {
    conversationId: string;
    message: WorkbenchMessage;
    timer: ReturnType<typeof setTimeout>;
  }>();

  return {
    async appendMessage(conversationId, message) {
      insertMessage.run({
        conversationId,
        messageId: message.id,
        role: message.role,
        kind: message.kind ?? null,
        text: message.text,
        now: nowSeconds(),
      });
      cancelPendingKnowledgeIngest(conversationId, message.id);
      ingestKnowledgeMessage(options.localKnowledge, conversationId, message);
    },
    async appendMessageDelta(conversationId, messageId, delta) {
      if (!delta) return;
      appendDelta.run({
        conversationId,
        messageId,
        delta,
        now: nowSeconds(),
      });
      const pending = pendingKnowledgeIngests.get(knowledgeIngestKey(conversationId, messageId));
      if (pending) {
        scheduleKnowledgeIngest(conversationId, { ...pending.message, text: pending.message.text + delta });
        return;
      }
      const rows = rowsToMessages([messageByID.get(conversationId, messageId)].filter(Boolean));
      if (rows[0]) scheduleKnowledgeIngest(conversationId, rows[0]);
    },
    async clearConversation(conversationId) {
      cancelConversationKnowledgeIngests(conversationId);
      deleteConversation.run(conversationId);
      try {
        await options.localKnowledge?.forgetConversation?.(conversationId);
      } catch {
        // The transcript store remains the source of truth for deletion.
      }
    },
    async exportConversation(conversationId) {
      return formatTranscript(rowsToMessages(allMessages.all(conversationId)));
    },
    async getConversationSummary(conversationId) {
      const stats = conversationUpdatedAt.get(conversationId) as Record<string, unknown> | undefined;
      return summarizeMessages(rowsToMessages(allMessages.all(conversationId)), {
        updatedAt: typeof stats?.updated_at === "number" ? stats.updated_at : undefined,
      });
    },
    async loadAfterMessages(conversationId, afterSeq, limit) {
      return rowsToMessages(afterMessages.all(conversationId, afterSeq, Math.max(0, limit)));
    },
    async loadBeforeMessages(conversationId, beforeSeq, limit) {
      return rowsToMessages(beforeMessages.all(conversationId, beforeSeq, Math.max(0, limit))).reverse();
    },
    async loadRecentMessages(conversationId, limit) {
      return rowsToMessages(recentMessages.all(conversationId, Math.max(0, limit))).reverse();
    },
    dispose() {
      flushPendingKnowledgeIngests();
      db.close();
    },
  };

  function scheduleKnowledgeIngest(conversationId: string, message: WorkbenchMessage) {
    if (!isKnowledgeIngestible(options.localKnowledge, message)) return;
    const key = knowledgeIngestKey(conversationId, message.id);
    const pending = pendingKnowledgeIngests.get(key);
    if (pending) clearTimeout(pending.timer);
    if (knowledgeIngestDelayMs === 0) {
      ingestKnowledgeMessage(options.localKnowledge, conversationId, message);
      return;
    }
    const timer = setTimeout(() => flushPendingKnowledgeIngest(key), knowledgeIngestDelayMs);
    pendingKnowledgeIngests.set(key, {
      conversationId,
      message: { ...message },
      timer,
    });
  }

  function flushPendingKnowledgeIngest(key: string) {
    const pending = pendingKnowledgeIngests.get(key);
    if (!pending) return;
    pendingKnowledgeIngests.delete(key);
    clearTimeout(pending.timer);
    ingestKnowledgeMessage(options.localKnowledge, pending.conversationId, pending.message);
  }

  function flushPendingKnowledgeIngests() {
    for (const key of [...pendingKnowledgeIngests.keys()]) {
      flushPendingKnowledgeIngest(key);
    }
  }

  function cancelPendingKnowledgeIngest(conversationId: string, messageId: string) {
    const key = knowledgeIngestKey(conversationId, messageId);
    const pending = pendingKnowledgeIngests.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingKnowledgeIngests.delete(key);
  }

  function cancelConversationKnowledgeIngests(conversationId: string) {
    const prefix = `${conversationId}\0`;
    for (const [key, pending] of pendingKnowledgeIngests.entries()) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(pending.timer);
      pendingKnowledgeIngests.delete(key);
    }
  }
}

function ingestKnowledgeMessage(
  localKnowledge: LocalKnowledgeService | undefined,
  conversationId: string,
  message: WorkbenchMessage,
) {
  if (!isKnowledgeIngestible(localKnowledge, message)) return;
  try {
    const ingestMessage = localKnowledge?.ingestMessage;
    if (!ingestMessage) return;
    const result = ingestMessage({
      conversationId,
      messageId: message.id,
      role: message.role,
      kind: message.kind,
      text: message.text,
    });
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Transcript persistence should not fail because the opportunistic local index is unavailable.
  }
}

function isKnowledgeIngestible(localKnowledge: LocalKnowledgeService | undefined, message: WorkbenchMessage) {
  return Boolean(localKnowledge?.ingestMessage && message.kind !== "tool" && message.text.trim());
}

function knowledgeIngestKey(conversationId: string, messageId: string) {
  return `${conversationId}\0${messageId}`;
}

function rowsToMessages(rows: unknown[]): WorkbenchMessage[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    const message: WorkbenchMessage = {
      id: String(record.message_id ?? ""),
      role: roleValue(record.role),
      text: String(record.text ?? ""),
    };
    if (typeof record.seq === "number") message.transcriptSeq = record.seq;
    if (record.kind === "tool") message.kind = "tool";
    return message;
  });
}

function roleValue(value: unknown): WorkbenchMessage["role"] {
  return value === "user" || value === "assistant" || value === "system" ? value : "system";
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
