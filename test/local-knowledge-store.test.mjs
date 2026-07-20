import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSQLiteLocalKnowledgeStore } from "../dist/tui/local-knowledge-store.js";

test("SQLite local knowledge indexes transcripts and workdir chunks with deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-local-knowledge-"));
  try {
    const store = createSQLiteLocalKnowledgeStore(join(root, "knowledge.sqlite3"), {
      maxChunkBytes: 36,
    });
    await writeFile(
      join(root, "AGENTS.md"),
      [
        "Repository instructions",
        "Use implicit local knowledge with lexical search.",
        "Prefer exact local provenance.",
      ].join("\n"),
      "utf8",
    );

    store.ingestMessage({
      conversationId: "conv_1",
      messageId: "msg_1",
      role: "user",
      text: "Decision: start local knowledge without embeddings.",
      scope: { workspaceId: "wrk_1", profile: "default" },
    });
    await store.ingestWorkdir({ root, scope: { workspaceId: "wrk_1", profile: "default" } });

    const result = await store.search({
      query: "implicit embeddings",
      scope: {
        conversationId: "conv_1",
        workspaceId: "wrk_1",
        profile: "default",
        workdir: root,
      },
    });
    assert.equal(result.object, "local_knowledge_search_result");
    assert.equal(result.data.length, 2);
    assert.ok(result.data.some((hit) => hit.sourceType === "transcript"));
    assert.ok(result.data.some((hit) =>
      hit.title === "AGENTS.md" &&
      hit.metadata?.workspace_id === "wrk_1" &&
      hit.metadata?.profile === "default" &&
      typeof hit.metadata?.start_line === "number"
    ));

    const context = await store.contextForPrompt({
      query: "local knowledge provenance",
      scope: { conversationId: "conv_1", workspaceId: "wrk_1", profile: "default", workdir: root },
      maxBytes: 2000,
    });
    assert.ok(context);
    assert.ok(context.text.includes("AGENTS.md"));

    store.forgetConversation?.("conv_1");
    const afterForget = await store.search({ query: "embeddings", conversationId: "conv_1", workdir: root });
    assert.equal(afterForget.data.length, 0);

    await unlink(join(root, "AGENTS.md"));
    await store.ingestWorkdir({ root });
    const afterDelete = await store.search({ query: "implicit", workdir: root });
    assert.equal(afterDelete.data.length, 0);

    store.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite local knowledge enforces retention policy and reports stats", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-local-knowledge-policy-"));
  try {
    const store = createSQLiteLocalKnowledgeStore(join(root, "knowledge.sqlite3"), {
      policy: {
        retention: {
          maxTranscriptSources: 2,
          maxWorkdirSources: 10,
          maxBytes: 1024 * 1024,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });

    for (const id of ["alphaone", "betatwo", "gammathree"]) {
      store.ingestMessage({
        conversationId: "conv_policy",
        messageId: `msg_${id}`,
        role: "user",
        text: `Retention ${id}`,
      });
    }

    const stats = store.stats();
    assert.equal(stats.object, "local_knowledge_stats");
    assert.equal(stats.bySourceType.transcript.sources, 2);
    assert.equal(stats.sources, 2);

    const pruned = await store.search({ query: "alphaone", conversationId: "conv_policy" });
    assert.equal(pruned.data.length, 0);
    const kept = await store.search({ query: "gammathree", conversationId: "conv_policy" });
    assert.equal(kept.data.length, 1);

    store.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite local knowledge supports scoped forget and dry-run pruning", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-local-knowledge-forget-"));
  try {
    const store = createSQLiteLocalKnowledgeStore(join(root, "knowledge.sqlite3"), {
      policy: {
        retention: {
          maxTranscriptSources: 100,
          maxWorkdirSources: 100,
          maxBytes: 1024 * 1024,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });

    store.ingestMessage({
      conversationId: "conv_a",
      messageId: "msg_a",
      role: "user",
      text: "Scoped forget alpha",
      scope: { workspaceId: "wrk_a" },
    });
    store.ingestMessage({
      conversationId: "conv_b",
      messageId: "msg_b",
      role: "user",
      text: "Scoped forget beta",
      scope: { workspaceId: "wrk_b" },
    });

    store.forget({ workspaceId: "wrk_a" });
    assert.equal((await store.search({ query: "alpha", scope: { workspaceId: "wrk_a" } })).data.length, 0);
    assert.equal((await store.search({ query: "beta", scope: { workspaceId: "wrk_b" } })).data.length, 1);
    assert.equal(store.stats().deletedSources, 1);

    const dryRun = store.prune({
      dryRun: true,
      policy: {
        retention: {
          maxBytes: 1,
          maxTranscriptSources: 100,
          maxWorkdirSources: 100,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });
    assert.equal(dryRun.dryRun, true);
    assert.ok(dryRun.deletedSources >= 1);
    assert.equal((await store.search({ query: "beta", scope: { workspaceId: "wrk_b" } })).data.length, 1);

    const actual = store.prune({
      policy: {
        retention: {
          maxBytes: 1,
          maxTranscriptSources: 100,
          maxWorkdirSources: 100,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });
    assert.ok(actual.reclaimedBytes > 0);
    assert.equal((await store.search({ query: "beta", scope: { workspaceId: "wrk_b" } })).data.length, 0);

    store.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite local knowledge filters retrieval by scope with optional conversation siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-local-knowledge-scope-"));
  try {
    const store = createSQLiteLocalKnowledgeStore(join(root, "knowledge.sqlite3"), {
      policy: {
        retention: {
          maxTranscriptSources: 100,
          maxWorkdirSources: 100,
          maxBytes: 1024 * 1024,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });

    store.ingestMessage({
      conversationId: "conv_a",
      messageId: "msg_a",
      role: "user",
      text: "Scoped retrieval sharedneedle alpha",
      scope: { workspaceId: "wrk_a", profile: "profile_a" },
    });
    store.ingestMessage({
      conversationId: "conv_b",
      messageId: "msg_b",
      role: "user",
      text: "Scoped retrieval sharedneedle sibling",
      scope: { workspaceId: "wrk_a", profile: "profile_a" },
    });
    store.ingestMessage({
      conversationId: "conv_c",
      messageId: "msg_c",
      role: "user",
      text: "Scoped retrieval sharedneedle foreign",
      scope: { workspaceId: "wrk_b", profile: "profile_b" },
    });

    const scoped = await store.search({
      query: "sharedneedle",
      scope: { conversationId: "conv_a", workspaceId: "wrk_a", profile: "profile_a" },
    });
    assert.deepEqual(scoped.data.map((hit) => hit.metadata?.message_id).sort(), ["msg_a", "msg_b"]);

    const noSiblings = store.prune({ dryRun: true });
    assert.equal(noSiblings.object, "local_knowledge_prune_result");
    const strictStore = createSQLiteLocalKnowledgeStore(join(root, "strict.sqlite3"), {
      policy: {
        retrieval: { includeConversationSiblings: false },
        retention: {
          maxTranscriptSources: 100,
          maxWorkdirSources: 100,
          maxBytes: 1024 * 1024,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });
    strictStore.ingestMessage({
      conversationId: "conv_a",
      messageId: "msg_a",
      role: "user",
      text: "Scoped retrieval strictneedle alpha",
      scope: { workspaceId: "wrk_a", profile: "profile_a" },
    });
    strictStore.ingestMessage({
      conversationId: "conv_b",
      messageId: "msg_b",
      role: "user",
      text: "Scoped retrieval strictneedle sibling",
      scope: { workspaceId: "wrk_a", profile: "profile_a" },
    });
    const strict = await strictStore.search({
      query: "strictneedle",
      scope: { conversationId: "conv_a", workspaceId: "wrk_a", profile: "profile_a" },
    });
    assert.deepEqual(strict.data.map((hit) => hit.metadata?.message_id), ["msg_a"]);

    store.dispose?.();
    strictStore.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite local knowledge prefer scope mode keeps broad retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-local-knowledge-prefer-"));
  try {
    const store = createSQLiteLocalKnowledgeStore(join(root, "knowledge.sqlite3"), {
      policy: {
        retrieval: { scopeMode: "prefer" },
        retention: {
          maxTranscriptSources: 100,
          maxWorkdirSources: 100,
          maxBytes: 1024 * 1024,
          transcriptTtlSeconds: 0,
          workdirTtlSeconds: 0,
          deletedTtlSeconds: 0,
        },
      },
    });
    store.ingestMessage({
      conversationId: "conv_a",
      messageId: "msg_a",
      role: "user",
      text: "Prefer retrieval widenoodle alpha",
      scope: { workspaceId: "wrk_a", profile: "profile_a" },
    });
    store.ingestMessage({
      conversationId: "conv_b",
      messageId: "msg_b",
      role: "user",
      text: "Prefer retrieval widenoodle foreign",
      scope: { workspaceId: "wrk_b", profile: "profile_b" },
    });

    const result = await store.search({
      query: "widenoodle",
      scope: { conversationId: "conv_a", workspaceId: "wrk_a", profile: "profile_a" },
    });
    assert.deepEqual(result.data.map((hit) => hit.metadata?.message_id).sort(), ["msg_a", "msg_b"]);

    store.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
