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
