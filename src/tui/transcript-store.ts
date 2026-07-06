import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  currentAgentAppRuntime,
} from "@agent-api/app-engine/core";
import {
  createFileTranscriptStore,
  formatTranscript,
  summarizeMessages,
  type WorkbenchMessage,
  type WorkbenchTranscriptStore,
} from "@agent-api/app-engine/workbench";

export function createDefaultTranscriptStore(): WorkbenchTranscriptStore {
  const dataDir = currentAgentAppRuntime().runtime.dirs.data;
  mkdirSync(dataDir, { recursive: true });
  try {
    return createSQLiteTranscriptStore(path.join(dataDir, "transcripts.sqlite3"));
  } catch {
    return createFileTranscriptStore(path.join(dataDir, "transcripts"));
  }
}

export function createSQLiteTranscriptStore(file: string): WorkbenchTranscriptStore {
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
    },
    async appendMessageDelta(conversationId, messageId, delta) {
      if (!delta) return;
      appendDelta.run({
        conversationId,
        messageId,
        delta,
        now: nowSeconds(),
      });
    },
    async clearConversation(conversationId) {
      deleteConversation.run(conversationId);
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
      db.close();
    },
  };
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
