import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, type Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  LocalKnowledgeContext,
  LocalKnowledgeContextParams,
  LocalKnowledgeHit,
  LocalKnowledgeIngestMessage,
  LocalKnowledgeIngestWorkdirOptions,
  LocalKnowledgeSearchParams,
  LocalKnowledgeSearchResult,
  LocalKnowledgeService,
  LocalKnowledgeScope,
  LocalKnowledgeSourceType,
} from "@agent-api/sdk/local";

interface SearchRow {
  chunk_id: string;
  chunk_index: number;
  source_type: string;
  source_uri: string;
  title: string | null;
  text: string;
  conversation_id: string | null;
  workspace_id: string | null;
  profile: string | null;
  workdir: string | null;
  metadata_json: string | null;
  start_line: number | null;
  end_line: number | null;
  indexed_at: number;
  rank: number;
}

interface SourceStateRow {
  source_id: number;
  content_hash: string | null;
  size: number | null;
  mtime_ms: number | null;
}

interface SourcePruneRow {
  source_id: number;
  source_type: string;
  size: number | null;
  indexed_at: number;
  deleted_at: number | null;
}

interface SourceStatsRow {
  source_type: string;
  sources: number;
  chunks: number;
  bytes: number | null;
}

const schemaVersion = 3;
const defaultSearchLimit = 8;
const maxSearchLimit = 30;
const defaultContextBytes = 10 * 1024;
const maxContextBytes = 64 * 1024;
const defaultChunkBytes = 4 * 1024;
const defaultChunkOverlapLines = 4;
const maxTranscriptBytes = 64 * 1024;
const maxWorkdirFileBytes = 128 * 1024;
const secondsPerDay = 24 * 60 * 60;

export interface LocalKnowledgeRetentionPolicy {
  transcriptTtlSeconds?: number;
  workdirTtlSeconds?: number;
  maxBytes?: number;
  maxTranscriptSources?: number;
  maxWorkdirSources?: number;
  deletedTtlSeconds?: number;
}

export interface LocalKnowledgeRetrievalPolicy {
  defaultLimit?: number;
  maxLimit?: number;
  defaultContextBytes?: number;
  maxContextBytes?: number;
  scopeMode?: "prefer" | "filter";
  includeConversationSiblings?: boolean;
}

export interface LocalKnowledgeIngestionPolicy {
  maxTranscriptBytes?: number;
  maxWorkdirFiles?: number;
  maxWorkdirFileBytes?: number;
  maxChunkBytes?: number;
  includeWorkdir?: boolean;
  includeTranscripts?: boolean;
}

export interface LocalKnowledgePolicy {
  enabled?: boolean;
  retention?: LocalKnowledgeRetentionPolicy;
  retrieval?: LocalKnowledgeRetrievalPolicy;
  ingestion?: LocalKnowledgeIngestionPolicy;
}

export interface LocalKnowledgeStats {
  object: "local_knowledge_stats";
  sources: number;
  chunks: number;
  bytes: number;
  deletedSources: number;
  oldestIndexedAt?: number;
  newestIndexedAt?: number;
  bySourceType: Partial<Record<LocalKnowledgeSourceType, { sources: number; chunks: number; bytes: number }>>;
}

export interface LocalKnowledgePruneParams {
  policy?: LocalKnowledgePolicy;
  scope?: LocalKnowledgeScope;
  dryRun?: boolean;
}

export interface LocalKnowledgePruneResult {
  object: "local_knowledge_prune_result";
  dryRun?: boolean;
  deletedSources: number;
  deletedChunks: number;
  reclaimedBytes: number;
}

export interface LocalKnowledgeForgetParams {
  conversationId?: string;
  workspaceId?: string;
  profile?: string;
  workdir?: string;
  sourceUri?: string;
  sourceType?: LocalKnowledgeSourceType;
}

export interface SQLiteLocalKnowledgeService extends LocalKnowledgeService {
  forget(params: LocalKnowledgeForgetParams): void;
  prune(params?: LocalKnowledgePruneParams): LocalKnowledgePruneResult;
  stats(scope?: LocalKnowledgeScope): LocalKnowledgeStats;
}

interface NormalizedLocalKnowledgePolicy {
  enabled: boolean;
  retention: Required<LocalKnowledgeRetentionPolicy>;
  retrieval: Required<LocalKnowledgeRetrievalPolicy>;
  ingestion: Required<LocalKnowledgeIngestionPolicy>;
}

const defaultPolicy: NormalizedLocalKnowledgePolicy = {
  enabled: true,
  retention: {
    transcriptTtlSeconds: 90 * secondsPerDay,
    workdirTtlSeconds: 30 * secondsPerDay,
    maxBytes: 128 * 1024 * 1024,
    maxTranscriptSources: 20_000,
    maxWorkdirSources: 2_000,
    deletedTtlSeconds: 7 * secondsPerDay,
  },
  retrieval: {
    defaultLimit: defaultSearchLimit,
    maxLimit: maxSearchLimit,
    defaultContextBytes,
    maxContextBytes,
    scopeMode: "filter",
    includeConversationSiblings: true,
  },
  ingestion: {
    maxTranscriptBytes,
    maxWorkdirFiles: 80,
    maxWorkdirFileBytes,
    maxChunkBytes: defaultChunkBytes,
    includeWorkdir: true,
    includeTranscripts: true,
  },
};

const priorityFileNames = new Set([
  "AGENTS.md",
  "README.md",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Makefile",
  "tsconfig.json",
]);

export interface SQLiteLocalKnowledgeStoreOptions {
  maxChunkBytes?: number;
  policy?: LocalKnowledgePolicy;
}

export function createSQLiteLocalKnowledgeStore(
  file: string,
  options: SQLiteLocalKnowledgeStoreOptions = {},
): SQLiteLocalKnowledgeService {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 2500");
  migrate(db);

  const policy = normalizePolicy(options.policy, options.maxChunkBytes);

  const sourceByKey = db.prepare(`
    SELECT source_id, content_hash, size, mtime_ms
    FROM local_knowledge_sources
    WHERE source_key = ?
  `);
  const upsertSource = db.prepare(`
    INSERT INTO local_knowledge_sources (
      source_key, source_type, source_uri, title, conversation_id, workspace_id, profile, workdir,
      metadata_json, content_hash, size, mtime_ms, indexed_at, deleted_at
    ) VALUES (
      @sourceKey, @sourceType, @sourceUri, @title, @conversationId, @workspaceId, @profile, @workdir,
      @metadataJson, @contentHash, @size, @mtimeMs, @indexedAt, NULL
    )
    ON CONFLICT(source_key) DO UPDATE SET
      source_type = excluded.source_type,
      source_uri = excluded.source_uri,
      title = excluded.title,
      conversation_id = excluded.conversation_id,
      workspace_id = excluded.workspace_id,
      profile = excluded.profile,
      workdir = excluded.workdir,
      metadata_json = excluded.metadata_json,
      content_hash = excluded.content_hash,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at,
      deleted_at = NULL
    RETURNING source_id
  `);
  const deleteChunksForSource = db.prepare("DELETE FROM local_knowledge_chunks WHERE source_id = ?");
  const insertChunk = db.prepare(`
    INSERT INTO local_knowledge_chunks (
      chunk_id, source_id, chunk_index, text, start_line, end_line, char_count
    ) VALUES (
      @chunkId, @sourceId, @chunkIndex, @text, @startLine, @endLine, @charCount
    )
  `);
  const deleteConversationSources = db.prepare(`
    UPDATE local_knowledge_sources
    SET deleted_at = @deletedAt
    WHERE source_type = 'transcript' AND conversation_id = @conversationId
  `);
  const replaceSource = db.transaction((record: SourceRecord, chunks: TextChunk[]) => {
    const source = upsertSource.get({
      sourceKey: record.sourceKey,
      sourceType: record.sourceType,
      sourceUri: record.sourceUri,
      title: record.title ?? null,
      conversationId: record.scope.conversationId ?? null,
      workspaceId: record.scope.workspaceId ?? null,
      profile: record.scope.profile ?? null,
      workdir: record.workdir ? path.resolve(record.workdir) : null,
      metadataJson: record.metadata ? JSON.stringify(record.metadata) : null,
      contentHash: record.contentHash,
      size: record.size ?? null,
      mtimeMs: record.mtimeMs ?? null,
      indexedAt: nowSeconds(),
    }) as { source_id: number };
    deleteChunksForSource.run(source.source_id);
    for (const chunk of chunks) {
      insertChunk.run({
        chunkId: stableID(`${record.sourceKey}:${chunk.index}:${stableID(chunk.text)}`),
        sourceId: source.source_id,
        chunkIndex: chunk.index,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        charCount: chunk.text.length,
      });
    }
  });

  const service: SQLiteLocalKnowledgeService = {
    ingestMessage(message) {
      if (policy.enabled === false || policy.ingestion.includeTranscripts === false) return;
      const text = message.text.trim();
      if (!text || message.kind === "tool") return;
      const clipped = trimText(text, policy.ingestion.maxTranscriptBytes);
      const sourceKey = `transcript:${message.conversationId}:${message.messageId}`;
      const scope = normalizedScope({
        ...message.scope,
        conversationId: message.scope?.conversationId ?? message.conversationId,
      });
      replaceSource({
        sourceKey,
        sourceType: "transcript",
        sourceUri: sourceKey,
        title: `${message.role} message`,
        text: clipped,
        scope,
        metadata: {
          message_id: message.messageId,
          role: message.role,
          truncated: clipped.length !== text.length,
        },
        contentHash: stableID(clipped),
        size: Buffer.byteLength(clipped, "utf8"),
      }, chunkText(clipped, policy.ingestion.maxChunkBytes));
      pruneBestEffort();
    },
    async ingestWorkdir(ingestOptions) {
      if (policy.enabled === false || policy.ingestion.includeWorkdir === false) return;
      const root = path.resolve(ingestOptions.root);
      const scope = normalizedScope({
        ...ingestOptions.scope,
        workdir: ingestOptions.scope?.workdir ?? root,
      });
      const scan = await priorityFiles(root, ingestOptions.maxFiles ?? policy.ingestion.maxWorkdirFiles);
      const maxBytes = Math.min(positiveInt(ingestOptions.maxBytesPerFile, policy.ingestion.maxWorkdirFileBytes), policy.ingestion.maxWorkdirFileBytes);
      const seenKeys = new Set<string>();
      for (const relativePath of scan.files) {
        const sourceKey = `file:${root}:${relativePath}`;
        try {
          const fullPath = path.join(root, relativePath);
          const info = await stat(fullPath);
          if (!info.isFile() || info.size > maxBytes) continue;
          const raw = await readFile(fullPath, "utf8");
          const text = trimText(raw, maxBytes);
          const contentHash = stableID(text);
          const current = sourceByKey.get(sourceKey) as SourceStateRow | undefined;
          if (
            current?.content_hash === contentHash &&
            current.size === info.size &&
            current.mtime_ms === Math.trunc(info.mtimeMs)
          ) {
            seenKeys.add(sourceKey);
            continue;
          }
          replaceSource({
            sourceKey,
            sourceType: "workdir_file",
            sourceUri: `file://${fullPath}`,
            title: relativePath,
            text,
            workdir: root,
            scope,
            metadata: {
              path: relativePath,
              truncated: Buffer.byteLength(raw, "utf8") > maxBytes,
            },
            contentHash,
            size: info.size,
            mtimeMs: Math.trunc(info.mtimeMs),
          }, chunkText(text, policy.ingestion.maxChunkBytes));
          seenKeys.add(sourceKey);
        } catch {
          // Keep indexing best-effort; a locked or non-text file should not break a turn.
        }
      }
      markStaleWorkdirSources(root, seenKeys, scan.scanned);
      pruneBestEffort();
    },
    async search(params) {
      const match = ftsQuery(params.query);
      if (!match) return { object: "local_knowledge_search_result", data: [] };
      let rows: SearchRow[];
      const scope = normalizedScope(params.scope, params);
      const scopedSearch = searchStatementForScope(policy, scope);
      try {
        rows = scopedSearch.statement.all({
          match,
          limit: clampInt(params.limit, policy.retrieval.defaultLimit, 1, policy.retrieval.maxLimit),
          conversationId: scope.conversationId ?? "",
          workspaceId: scope.workspaceId ?? "",
          profile: scope.profile ?? "",
          workdir: scope.workdir ? path.resolve(scope.workdir) : "",
          ...scopedSearch.params,
        }) as SearchRow[];
      } catch {
        return { object: "local_knowledge_search_result", data: [] };
      }
      return {
        object: "local_knowledge_search_result",
        data: dedupeHits(rows.map(rowToHit)),
      };
    },
    async contextForPrompt(params) {
      const result = await service.search({
        query: params.query,
        limit: params.limit ?? 10,
        scope: normalizedScope(params.scope, params),
      });
      if (result.data.length === 0) return null;
      return buildContext(result, params, policy);
    },
    forgetConversation(conversationId: string) {
      deleteConversationSources.run({ conversationId, deletedAt: nowSeconds() });
    },
    forget(params) {
      softForget(params);
    },
    prune(params = {}) {
      return pruneLocalKnowledge(params);
    },
    stats(scope) {
      return localKnowledgeStats(scope);
    },
    dispose() {
      db.close();
    },
  };

  function pruneBestEffort() {
    try {
      pruneLocalKnowledge({ policy });
    } catch {
      // Retention is protective and should never break ingestion.
    }
  }

  function searchStatementForScope(
    effectivePolicy: NormalizedLocalKnowledgePolicy,
    scope: NormalizedLocalKnowledgeScope,
  ): { statement: Database.Statement; params: Record<string, unknown> } {
    const scoped = retrievalScopeWhere(effectivePolicy, scope);
    return {
      statement: db.prepare(`
        SELECT
          c.chunk_id,
          c.chunk_index,
          s.source_type,
          s.source_uri,
          s.title,
          c.text,
          s.conversation_id,
          s.workspace_id,
          s.profile,
          s.workdir,
          s.metadata_json,
          c.start_line,
          c.end_line,
          s.indexed_at,
          bm25(local_knowledge_chunks_fts) AS rank
        FROM local_knowledge_chunks_fts
        JOIN local_knowledge_chunks c ON c.rowid = local_knowledge_chunks_fts.rowid
        JOIN local_knowledge_sources s ON s.source_id = c.source_id
        WHERE local_knowledge_chunks_fts MATCH @match
          AND s.deleted_at IS NULL
          ${scoped.sql}
        ORDER BY
          CASE WHEN s.conversation_id = @conversationId THEN 0 ELSE 1 END,
          CASE WHEN s.workspace_id = @workspaceId THEN 0 ELSE 1 END,
          CASE WHEN s.profile = @profile THEN 0 ELSE 1 END,
          CASE WHEN s.workdir = @workdir THEN 0 ELSE 1 END,
          rank,
          s.indexed_at DESC
        LIMIT @limit
      `),
      params: scoped.params,
    };
  }

  function retrievalScopeWhere(
    effectivePolicy: NormalizedLocalKnowledgePolicy,
    scope: NormalizedLocalKnowledgeScope,
  ): { sql: string; params: Record<string, unknown> } {
    if (effectivePolicy.retrieval.scopeMode !== "filter") return { sql: "", params: {} };

    const branches: string[] = [];
    const params: Record<string, unknown> = {};
    if (scope.conversationId) {
      branches.push("s.conversation_id = @filterConversationId");
      params.filterConversationId = scope.conversationId;
    }

    const siblingClauses: string[] = [];
    if (!scope.conversationId || effectivePolicy.retrieval.includeConversationSiblings) {
      if (scope.workspaceId) {
        siblingClauses.push("s.workspace_id = @filterWorkspaceId");
        params.filterWorkspaceId = scope.workspaceId;
      }
      if (scope.profile) {
        siblingClauses.push("s.profile = @filterProfile");
        params.filterProfile = scope.profile;
      }
      if (scope.workdir) {
        siblingClauses.push("(s.source_type != 'workdir_file' OR s.workdir = @filterWorkdir)");
        params.filterWorkdir = path.resolve(scope.workdir);
      }
      if (siblingClauses.length > 0) {
        branches.push(`(${siblingClauses.join(" AND ")})`);
      }
    }

    if (branches.length === 0) return { sql: "", params };
    return { sql: `AND (${branches.join(" OR ")})`, params };
  }

  function localKnowledgeStats(scope?: LocalKnowledgeScope): LocalKnowledgeStats {
    const filter = sourceFilter(normalizedScope(scope), "s");
    const total = db.prepare(`
      SELECT
        COUNT(*) AS sources,
        COALESCE(SUM(s.size), 0) AS bytes,
        MIN(s.indexed_at) AS oldestIndexedAt,
        MAX(s.indexed_at) AS newestIndexedAt,
        COALESCE(SUM((SELECT COUNT(*) FROM local_knowledge_chunks c WHERE c.source_id = s.source_id)), 0) AS chunks
      FROM local_knowledge_sources s
      WHERE s.deleted_at IS NULL${filter.sql}
    `).get(...filter.params) as {
      sources: number;
      chunks: number;
      bytes: number | null;
      oldestIndexedAt: number | null;
      newestIndexedAt: number | null;
    };
    const deleted = db.prepare(`
      SELECT COUNT(*) AS count
      FROM local_knowledge_sources s
      WHERE s.deleted_at IS NOT NULL${filter.sql}
    `).get(...filter.params) as { count: number };
    const rows = db.prepare(`
      SELECT
        s.source_type,
        COUNT(*) AS sources,
        COALESCE(SUM(s.size), 0) AS bytes,
        COALESCE(SUM((SELECT COUNT(*) FROM local_knowledge_chunks c WHERE c.source_id = s.source_id)), 0) AS chunks
      FROM local_knowledge_sources s
      WHERE s.deleted_at IS NULL${filter.sql}
      GROUP BY s.source_type
    `).all(...filter.params) as SourceStatsRow[];
    const bySourceType: LocalKnowledgeStats["bySourceType"] = {};
    for (const row of rows) {
      bySourceType[sourceType(row.source_type)] = {
        sources: row.sources,
        chunks: row.chunks,
        bytes: row.bytes ?? 0,
      };
    }
    return {
      object: "local_knowledge_stats",
      sources: total.sources,
      chunks: total.chunks,
      bytes: total.bytes ?? 0,
      deletedSources: deleted.count,
      ...(total.oldestIndexedAt ? { oldestIndexedAt: total.oldestIndexedAt } : {}),
      ...(total.newestIndexedAt ? { newestIndexedAt: total.newestIndexedAt } : {}),
      bySourceType,
    };
  }

  function pruneLocalKnowledge(params: LocalKnowledgePruneParams): LocalKnowledgePruneResult {
    const effective = mergePolicy(policy, params.policy);
    const scope = normalizedScope(params.scope);
    const dryRun = Boolean(params.dryRun);
    const sourceIds = new Set<number>();
    const now = nowSeconds();

    if (effective.retention.deletedTtlSeconds > 0) {
      for (const row of selectSources({
        scope,
        where: "deleted_at IS NOT NULL AND deleted_at <= ?",
        params: [now - effective.retention.deletedTtlSeconds],
      })) sourceIds.add(row.source_id);
    }
    if (effective.retention.transcriptTtlSeconds > 0) {
      for (const row of selectSources({
        scope,
        where: "deleted_at IS NULL AND source_type = 'transcript' AND indexed_at <= ?",
        params: [now - effective.retention.transcriptTtlSeconds],
      })) sourceIds.add(row.source_id);
    }
    if (effective.retention.workdirTtlSeconds > 0) {
      for (const row of selectSources({
        scope,
        where: "deleted_at IS NULL AND source_type = 'workdir_file' AND indexed_at <= ?",
        params: [now - effective.retention.workdirTtlSeconds],
      })) sourceIds.add(row.source_id);
    }
    addOverLimitSources(sourceIds, "transcript", effective.retention.maxTranscriptSources, scope);
    addOverLimitSources(sourceIds, "workdir_file", effective.retention.maxWorkdirSources, scope);
    addOverBudgetSources(sourceIds, effective.retention.maxBytes, scope);

    return deleteSources([...sourceIds], dryRun);
  }

  function addOverLimitSources(target: Set<number>, sourceTypeName: LocalKnowledgeSourceType, maxSources: number, scope: NormalizedLocalKnowledgeScope) {
    if (maxSources <= 0) return;
    const filter = sourceFilter(scope);
    const rows = db.prepare(`
      SELECT source_id, source_type, size, indexed_at, deleted_at
      FROM local_knowledge_sources
      WHERE deleted_at IS NULL AND source_type = ?${filter.sql}
      ORDER BY indexed_at DESC, source_id DESC
      LIMIT -1 OFFSET ?
    `).all(sourceTypeName, ...filter.params, maxSources) as SourcePruneRow[];
    for (const row of rows) target.add(row.source_id);
  }

  function addOverBudgetSources(target: Set<number>, maxBytes: number, scope: NormalizedLocalKnowledgeScope) {
    if (maxBytes <= 0) return;
    const filter = sourceFilter(scope);
    const rows = db.prepare(`
      SELECT source_id, source_type, size, indexed_at, deleted_at
      FROM local_knowledge_sources
      WHERE deleted_at IS NULL${filter.sql}
      ORDER BY indexed_at DESC, source_id DESC
    `).all(...filter.params) as SourcePruneRow[];
    let kept = 0;
    for (const row of rows) {
      const size = Math.max(0, row.size ?? 0);
      if (kept + size <= maxBytes) {
        kept += size;
      } else {
        target.add(row.source_id);
      }
    }
  }

  function selectSources(input: {
    scope: NormalizedLocalKnowledgeScope;
    where: string;
    params: unknown[];
  }) {
    const filter = sourceFilter(input.scope);
    return db.prepare(`
      SELECT source_id, source_type, size, indexed_at, deleted_at
      FROM local_knowledge_sources
      WHERE ${input.where}${filter.sql}
    `).all(...input.params, ...filter.params) as SourcePruneRow[];
  }

  function deleteSources(sourceIds: number[], dryRun: boolean): LocalKnowledgePruneResult {
    if (sourceIds.length === 0) {
      return { object: "local_knowledge_prune_result", ...(dryRun ? { dryRun } : {}), deletedSources: 0, deletedChunks: 0, reclaimedBytes: 0 };
    }
    const placeholders = sourceIds.map(() => "?").join(",");
    const summary = db.prepare(`
      SELECT COUNT(DISTINCT s.source_id) AS sources,
        COALESCE(SUM(s.size), 0) AS bytes,
        COALESCE(SUM((SELECT COUNT(*) FROM local_knowledge_chunks c WHERE c.source_id = s.source_id)), 0) AS chunks
      FROM local_knowledge_sources s
      WHERE s.source_id IN (${placeholders})
    `).get(...sourceIds) as { sources: number; bytes: number | null; chunks: number };
    if (!dryRun) {
      db.prepare(`DELETE FROM local_knowledge_sources WHERE source_id IN (${placeholders})`).run(...sourceIds);
    }
    return {
      object: "local_knowledge_prune_result",
      ...(dryRun ? { dryRun } : {}),
      deletedSources: summary.sources,
      deletedChunks: summary.chunks,
      reclaimedBytes: summary.bytes ?? 0,
    };
  }

  function softForget(params: LocalKnowledgeForgetParams) {
    const scope = normalizedScope({
      conversationId: params.conversationId,
      workspaceId: params.workspaceId,
      profile: params.profile,
      workdir: params.workdir,
    });
    const filters: string[] = [];
    const values: unknown[] = [];
    const scoped = sourceFilter(scope);
    if (scoped.sql) {
      filters.push(scoped.sql.replace(/^ AND /, ""));
      values.push(...scoped.params);
    }
    if (params.sourceUri) {
      filters.push("source_uri = ?");
      values.push(params.sourceUri);
    }
    if (params.sourceType) {
      filters.push("source_type = ?");
      values.push(params.sourceType);
    }
    if (filters.length === 0) return;
    db.prepare(`
      UPDATE local_knowledge_sources
      SET deleted_at = ?
      WHERE deleted_at IS NULL AND ${filters.join(" AND ")}
    `).run(nowSeconds(), ...values);
  }

  function sourceFilter(scope: NormalizedLocalKnowledgeScope, alias = ""): { sql: string; params: unknown[] } {
    const prefix = alias ? `${alias}.` : "";
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scope.conversationId) {
      clauses.push(`${prefix}conversation_id = ?`);
      params.push(scope.conversationId);
    }
    if (scope.workspaceId) {
      clauses.push(`${prefix}workspace_id = ?`);
      params.push(scope.workspaceId);
    }
    if (scope.profile) {
      clauses.push(`${prefix}profile = ?`);
      params.push(scope.profile);
    }
    if (scope.workdir) {
      clauses.push(`${prefix}workdir = ?`);
      params.push(path.resolve(scope.workdir));
    }
    return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
  }

  function markStaleWorkdirSources(root: string, seenKeys: Set<string>, scanned: boolean) {
    if (seenKeys.size === 0) {
      if (!scanned) return;
      db.prepare(`
        UPDATE local_knowledge_sources
        SET deleted_at = ?
        WHERE source_type = 'workdir_file' AND workdir = ?
      `).run(nowSeconds(), root);
      return;
    }
    const placeholders = [...seenKeys].map(() => "?").join(",");
    db.prepare(`
      UPDATE local_knowledge_sources
      SET deleted_at = ?
      WHERE source_type = 'workdir_file'
        AND workdir = ?
        AND source_key NOT IN (${placeholders})
    `).run(nowSeconds(), root, ...seenKeys);
  }

  return service;
}

interface SourceRecord {
  sourceKey: string;
  sourceType: LocalKnowledgeSourceType;
  sourceUri: string;
  title?: string;
  text: string;
  scope: NormalizedLocalKnowledgeScope;
  workdir?: string;
  metadata?: Record<string, unknown>;
  contentHash: string;
  size?: number;
  mtimeMs?: number;
}

interface NormalizedLocalKnowledgeScope {
  conversationId?: string;
  workspaceId?: string;
  profile?: string;
  workdir?: string;
}

interface TextChunk {
  index: number;
  text: string;
  startLine: number;
  endLine: number;
}

function migrate(db: Database.Database) {
  const current = Number(db.pragma("user_version", { simple: true }) || 0);
  if (current > 0 && current < schemaVersion) {
    db.exec(`
      DROP TABLE IF EXISTS local_knowledge_chunks_fts;
      DROP TABLE IF EXISTS local_knowledge_chunks;
      DROP TABLE IF EXISTS local_knowledge_sources;
      DROP TABLE IF EXISTS local_knowledge_records;
      DROP TABLE IF EXISTS local_knowledge_fts;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_knowledge_sources (
      source_id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      title TEXT,
      conversation_id TEXT,
      workspace_id TEXT,
      profile TEXT,
      workdir TEXT,
      metadata_json TEXT,
      content_hash TEXT,
      size INTEGER,
      mtime_ms INTEGER,
      indexed_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS local_knowledge_chunks (
      rowid INTEGER PRIMARY KEY,
      chunk_id TEXT NOT NULL UNIQUE,
      source_id INTEGER NOT NULL REFERENCES local_knowledge_sources(source_id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      char_count INTEGER NOT NULL,
      UNIQUE(source_id, chunk_index)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS local_knowledge_chunks_fts USING fts5(
      text,
      title UNINDEXED,
      source_uri UNINDEXED,
      content='local_knowledge_chunks',
      content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS local_knowledge_chunks_ai AFTER INSERT ON local_knowledge_chunks BEGIN
      INSERT INTO local_knowledge_chunks_fts(rowid, text, title, source_uri)
      SELECT new.rowid, new.text, s.title, s.source_uri
      FROM local_knowledge_sources s WHERE s.source_id = new.source_id;
    END;
    CREATE TRIGGER IF NOT EXISTS local_knowledge_chunks_ad AFTER DELETE ON local_knowledge_chunks BEGIN
      INSERT INTO local_knowledge_chunks_fts(local_knowledge_chunks_fts, rowid, text, title, source_uri)
      VALUES('delete', old.rowid, old.text, '', '');
    END;
    CREATE TRIGGER IF NOT EXISTS local_knowledge_chunks_au AFTER UPDATE ON local_knowledge_chunks BEGIN
      INSERT INTO local_knowledge_chunks_fts(local_knowledge_chunks_fts, rowid, text, title, source_uri)
      VALUES('delete', old.rowid, old.text, '', '');
      INSERT INTO local_knowledge_chunks_fts(rowid, text, title, source_uri)
      SELECT new.rowid, new.text, s.title, s.source_uri
      FROM local_knowledge_sources s WHERE s.source_id = new.source_id;
    END;
    CREATE INDEX IF NOT EXISTS idx_local_knowledge_sources_conversation
      ON local_knowledge_sources(conversation_id, indexed_at);
    CREATE INDEX IF NOT EXISTS idx_local_knowledge_sources_workspace
      ON local_knowledge_sources(workspace_id, indexed_at);
    CREATE INDEX IF NOT EXISTS idx_local_knowledge_sources_profile
      ON local_knowledge_sources(profile, indexed_at);
    CREATE INDEX IF NOT EXISTS idx_local_knowledge_sources_workdir
      ON local_knowledge_sources(workdir, indexed_at);
    CREATE INDEX IF NOT EXISTS idx_local_knowledge_chunks_source
      ON local_knowledge_chunks(source_id, chunk_index);
  `);
  db.pragma(`user_version = ${schemaVersion}`);
}

function buildContext(
  result: LocalKnowledgeSearchResult,
  params: LocalKnowledgeContextParams,
  policy: NormalizedLocalKnowledgePolicy,
): LocalKnowledgeContext | null {
  const maxBytes = clampInt(params.maxBytes, policy.retrieval.defaultContextBytes, 1024, policy.retrieval.maxContextBytes);
  let used = 0;
  const hits: LocalKnowledgeHit[] = [];
  const sections: string[] = [];
  for (const hit of result.data) {
    const lines = lineLabel(hit);
    const header = `- ${hit.title || hit.sourceUri}${lines ? ` ${lines}` : ""} (${hit.sourceType})`;
    const body = indent(trimText(hit.text, 1400));
    const section = `${header}\n${body}`;
    const size = Buffer.byteLength(section, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    hits.push(hit);
    sections.push(section);
  }
  if (hits.length === 0) return null;
  return { hits, text: sections.join("\n") };
}

async function priorityFiles(root: string, maxFiles: number): Promise<{ files: string[]; scanned: boolean }> {
  const out: string[] = [];
  let scanned = false;
  async function visit(relativeDir: string, depth: number) {
    if (out.length >= maxFiles || depth > 4) return;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
      scanned = true;
    } catch {
      return;
    }
    entries.sort((a, b) => priorityScore(a.name) - priorityScore(b.name) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles || ignoredName(entry.name)) continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "docs" || entry.name === ".github" || depth < 1) await visit(relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isPriorityFile(relativePath)) continue;
      out.push(relativePath.split(path.sep).join("/"));
    }
  }
  await visit("", 0);
  return { files: out, scanned };
}

function chunkText(text: string, maxBytes: number): TextChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let bytes = 0;
    while (end < lines.length) {
      const nextBytes = Buffer.byteLength(`${lines[end]}\n`, "utf8");
      if (end > start && bytes + nextBytes > maxBytes) break;
      bytes += nextBytes;
      end += 1;
    }
    const chunkLines = lines.slice(start, Math.max(end, start + 1));
    chunks.push({
      index: chunks.length,
      text: chunkLines.join("\n").trim(),
      startLine: start + 1,
      endLine: Math.max(end, start + 1),
    });
    if (end >= lines.length) break;
    start = Math.max(end - defaultChunkOverlapLines, start + 1);
  }
  return chunks.filter((chunk) => chunk.text.trim());
}

function isPriorityFile(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const base = path.basename(relativePath);
  if (priorityFileNames.has(base)) return true;
  if (normalized.startsWith("docs/") && base.endsWith(".md")) return true;
  if (normalized.startsWith(".github/") && (base.endsWith(".yml") || base.endsWith(".yaml") || base.endsWith(".md"))) return true;
  return false;
}

function ignoredName(name: string): boolean {
  return name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "dist-cjs" ||
    name === ".cache" ||
    name === "coverage" ||
    name === ".next";
}

function priorityScore(name: string): number {
  if (name === "AGENTS.md") return 0;
  if (name === "README.md") return 1;
  if (priorityFileNames.has(name)) return 2;
  if (name === "docs") return 3;
  if (name === ".github") return 4;
  return 10;
}

function ftsQuery(query: string): string {
  const terms = [...query.matchAll(/[\p{L}\p{N}_./:-]+/gu)]
    .map((match) => match[0].trim())
    .filter((term) => term.length > 1)
    .slice(0, 12);
  return terms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
}

function rowToHit(row: SearchRow): LocalKnowledgeHit {
  const metadata = parseMetadata(row.metadata_json) ?? {};
  if (row.start_line != null) metadata.start_line = row.start_line;
  if (row.end_line != null) metadata.end_line = row.end_line;
  metadata.chunk_index = row.chunk_index;
  if (row.workspace_id) metadata.workspace_id = row.workspace_id;
  if (row.profile) metadata.profile = row.profile;
  return {
    id: row.chunk_id,
    sourceType: sourceType(row.source_type),
    sourceUri: row.source_uri,
    title: row.title ?? undefined,
    text: row.text,
    score: row.rank,
    updatedAt: row.indexed_at,
    metadata,
  };
}

function normalizedScope(
  scope?: LocalKnowledgeScope,
  fallback?: Pick<LocalKnowledgeSearchParams, "conversationId" | "workdir">,
): NormalizedLocalKnowledgeScope {
  const conversationId = nonEmpty(scope?.conversationId ?? fallback?.conversationId);
  const workspaceId = nonEmpty(scope?.workspaceId);
  const profile = nonEmpty(scope?.profile);
  const workdir = nonEmpty(scope?.workdir ?? fallback?.workdir);
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(profile ? { profile } : {}),
    ...(workdir ? { workdir: path.resolve(workdir) } : {}),
  };
}

function dedupeHits(hits: LocalKnowledgeHit[]): LocalKnowledgeHit[] {
  const seen = new Set<string>();
  const out: LocalKnowledgeHit[] = [];
  for (const hit of hits) {
    const key = `${hit.sourceUri}:${hit.metadata?.chunk_index ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function sourceType(value: string): LocalKnowledgeSourceType {
  if (value === "transcript" || value === "workdir_file" || value === "note" || value === "tool_output") return value;
  return "note";
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function lineLabel(hit: LocalKnowledgeHit): string {
  const start = hit.metadata?.start_line;
  const end = hit.metadata?.end_line;
  if (typeof start !== "number" || typeof end !== "number") return "";
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function stableID(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, positiveInt(value, fallback)));
}

function normalizePolicy(policy: LocalKnowledgePolicy | undefined, legacyMaxChunkBytes?: number): NormalizedLocalKnowledgePolicy {
  return mergePolicy({
    ...defaultPolicy,
    ingestion: {
      ...defaultPolicy.ingestion,
      maxChunkBytes: positiveInt(legacyMaxChunkBytes, defaultPolicy.ingestion.maxChunkBytes),
    },
  }, policy);
}

function mergePolicy(
  base: NormalizedLocalKnowledgePolicy,
  patch: LocalKnowledgePolicy | undefined,
): NormalizedLocalKnowledgePolicy {
  const retentionPatch = patch?.retention ?? {};
  const retrievalPatch = patch?.retrieval ?? {};
  const ingestionPatch = patch?.ingestion ?? {};
  const retrievalMaxLimit = positiveInt(retrievalPatch.maxLimit, base.retrieval.maxLimit);
  const maxContext = positiveInt(retrievalPatch.maxContextBytes, base.retrieval.maxContextBytes);
  return {
    enabled: patch?.enabled ?? base.enabled,
    retention: {
      transcriptTtlSeconds: nonNegativeInt(retentionPatch.transcriptTtlSeconds, base.retention.transcriptTtlSeconds),
      workdirTtlSeconds: nonNegativeInt(retentionPatch.workdirTtlSeconds, base.retention.workdirTtlSeconds),
      maxBytes: nonNegativeInt(retentionPatch.maxBytes, base.retention.maxBytes),
      maxTranscriptSources: nonNegativeInt(retentionPatch.maxTranscriptSources, base.retention.maxTranscriptSources),
      maxWorkdirSources: nonNegativeInt(retentionPatch.maxWorkdirSources, base.retention.maxWorkdirSources),
      deletedTtlSeconds: nonNegativeInt(retentionPatch.deletedTtlSeconds, base.retention.deletedTtlSeconds),
    },
    retrieval: {
      defaultLimit: clampInt(retrievalPatch.defaultLimit, base.retrieval.defaultLimit, 1, retrievalMaxLimit),
      maxLimit: retrievalMaxLimit,
      defaultContextBytes: clampInt(retrievalPatch.defaultContextBytes, base.retrieval.defaultContextBytes, 1024, maxContext),
      maxContextBytes: maxContext,
      scopeMode: retrievalPatch.scopeMode === "prefer" ? "prefer" : retrievalPatch.scopeMode === "filter" ? "filter" : base.retrieval.scopeMode,
      includeConversationSiblings: retrievalPatch.includeConversationSiblings ?? base.retrieval.includeConversationSiblings,
    },
    ingestion: {
      maxTranscriptBytes: positiveInt(ingestionPatch.maxTranscriptBytes, base.ingestion.maxTranscriptBytes),
      maxWorkdirFiles: positiveInt(ingestionPatch.maxWorkdirFiles, base.ingestion.maxWorkdirFiles),
      maxWorkdirFileBytes: positiveInt(ingestionPatch.maxWorkdirFileBytes, base.ingestion.maxWorkdirFileBytes),
      maxChunkBytes: positiveInt(ingestionPatch.maxChunkBytes, base.ingestion.maxChunkBytes),
      includeWorkdir: ingestionPatch.includeWorkdir ?? base.ingestion.includeWorkdir,
      includeTranscripts: ingestionPatch.includeTranscripts ?? base.ingestion.includeTranscripts,
    },
  };
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : fallback;
}

function trimText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text).subarray(0, maxBytes).toString("utf8");
}

function indent(text: string): string {
  return text.split(/\r?\n/).slice(0, 40).map((line) => `  ${line}`).join("\n");
}
