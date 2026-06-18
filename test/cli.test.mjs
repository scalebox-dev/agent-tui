import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { agentResponseFailureMessage, agentTurnEventFromStreamEvent, clearPresetToolCatalogCache, resolveAgentRequestTools } from "../dist/agent.js";
import { normalizeChatOptions } from "../dist/chat-options.js";
import {
  createInitialWorkbenchState,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  workbenchReducer,
} from "../dist/tui/workbench.js";

const execFileAsync = promisify(execFile);
const bin = new URL("../dist/index.js", import.meta.url).pathname;

function isolatedEnv(root) {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local", "share"),
    XDG_CACHE_HOME: join(root, ".cache"),
  };
}

test("api-key login creates and selects profiles in isolated config", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-test-"));
  const apiKey = "sk-test-abcdefghijklmnopqrstuvwxyz";
  const env = isolatedEnv(root);

  await execFileAsync("node", [bin, "auth", "login", "--profile", "test", "--api-key", apiKey, "--base-url", "https://api.test"], { env });
  const { stdout: listOut } = await execFileAsync("node", [bin, "profiles", "list"], { env });
  assert.match(listOut, /\* test\s+https:\/\/api\.test\s+api_key sk-tes…wxyz/);

  const { stdout: showOut } = await execFileAsync("node", [bin, "profiles", "show", "test"], { env });
  const shown = JSON.parse(showOut);
  assert.equal(shown.name, "test");
  assert.equal(shown.baseURL, "https://api.test");
  assert.equal(shown.auth.type, "api_key");
});

test("agent conversation manager lists, shows, and deletes local conversation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-test-"));
  const env = isolatedEnv(root);

  await execFileAsync("node", [bin, "auth", "login", "--profile", "test", "--api-key", "sk-test-abcdefghijklmnopqrstuvwxyz", "--base-url", "https://api.test"], { env });

  const configPath = join(root, ".config", "agent-api-cli", "profiles.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.conversations["test:release"] = {
    name: "release",
    profile: "test",
    previousResponseId: "resp_test",
    updatedAt: 4102444800,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const { stdout: listOut } = await execFileAsync("node", [bin, "agent", "list"], { env });
  assert.match(listOut, /release\s+test\s+2100-01-01T00:00:00\.000Z response=resp_test/);

  const { stdout: showOut } = await execFileAsync("node", [bin, "agent", "show", "release"], { env });
  assert.equal(JSON.parse(showOut).previousResponseId, "resp_test");

  await execFileAsync("node", [bin, "agent", "delete", "release"], { env });
  const { stdout: emptyOut } = await execFileAsync("node", [bin, "agent", "list"], { env });
  assert.match(emptyOut, /No agent conversations yet/);
});

test("workspace status inspects a local directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-workspace-"));
  await writeFile(join(root, "README.md"), "# Test Workspace\n");

  const { stdout } = await execFileAsync("node", [bin, "workspace", "status", "--path", root]);
  const status = JSON.parse(stdout);

  assert.equal(status.root, root);
  assert.equal(status.name, basename(root));
  assert.equal(status.fileCount, 1);
  assert.equal(status.snapshotFiles, 1);
  assert.equal(status.scanTruncated, false);
});

test("workbench command parser and reducer handle local workflow state", () => {
  assert.deepEqual(parseWorkbenchCommand("/search auth flow"), {
    kind: "search",
    query: "auth flow",
  });
  assert.deepEqual(parseWorkbenchCommand("/unknown"), { kind: "help" });
  assert.deepEqual(parseWorkbenchCommand("/context"), { kind: "context" });
  assert.deepEqual(parseWorkbenchCommand("/new release notes"), { kind: "new_conversation", name: "release notes" });
  assert.deepEqual(parseWorkbenchCommand("/new"), { kind: "new_conversation", name: undefined });
  assert.deepEqual(parseWorkbenchCommand("/switch release"), { kind: "switch_conversation", name: "release" });
  assert.deepEqual(parseWorkbenchCommand("/conversation"), { kind: "list_conversations" });
  assert.deepEqual(parseWorkbenchCommand("/conversations"), { kind: "list_conversations" });
  assert.deepEqual(parseWorkbenchCommand("/refresh"), { kind: "refresh_catalog" });
  assert.deepEqual(parseWorkbenchCommand("/auth"), { kind: "auth_status" });
  assert.deepEqual(parseWorkbenchCommand("/login"), { kind: "login" });
  assert.deepEqual(parseWorkbenchCommand("/logout"), { kind: "logout" });
  assert.deepEqual(parseWorkbenchCommand("/quit"), { kind: "quit" });
  assert.deepEqual(parseWorkbenchCommand("/exit"), { kind: "quit" });
  assert.deepEqual(parseWorkbenchCommand("/delete-profile"), { kind: "delete_profile" });
  assert.deepEqual(parseWorkbenchCommand("/switch-profile work"), { kind: "switch_profile", name: "work" });
  assert.deepEqual(parseWorkbenchCommand("/switch-profile"), { kind: "switch_profile", name: undefined });
  assert.deepEqual(parseWorkbenchCommand("/config"), { kind: "config" });
  assert.deepEqual(parseWorkbenchCommand("/access"), { kind: "access" });
  assert.deepEqual(parseWorkbenchCommand("/access full"), { kind: "access", mode: "full" });
  assert.deepEqual(parseWorkbenchCommand("/access approval"), { kind: "access", mode: "approval" });
  assert.deepEqual(parseWorkbenchCommand("/preset pro-search"), { kind: "preset", value: "pro-search" });
  assert.deepEqual(parseWorkbenchCommand("/model auto"), { kind: "model", value: "auto" });
  assert.equal(parseWorkbenchCommand("plain prompt"), null);
  assert.deepEqual(parsePendingApprovalCommand("/apply"), { kind: "apply" });
  assert.deepEqual(parsePendingApprovalCommand("/yes"), { kind: "apply" });
  assert.deepEqual(parsePendingApprovalCommand("/apply-all"), { kind: "apply_all" });
  assert.deepEqual(parsePendingApprovalCommand("/yes-all"), { kind: "apply_all" });
  assert.deepEqual(parsePendingApprovalCommand("/reject"), { kind: "reject" });
  assert.deepEqual(parsePendingApprovalCommand("/no"), { kind: "reject" });
  assert.equal(parsePendingApprovalCommand("apply"), null);
  assert.equal(parsePendingApprovalCommand("yes"), null);
  assert.equal(parsePendingApprovalCommand("apply-all"), null);
  assert.equal(parsePendingApprovalCommand("/preview"), null);
  assert.equal(parsePendingApprovalCommand("plain prompt"), null);

  const initial = createInitialWorkbenchState({ contextEnabled: false, accessMode: "approval" });
  assert.equal(initial.currentConversation, "default");
  const toggled = workbenchReducer(initial, { type: "context.toggle" });
  assert.equal(toggled.contextEnabled, true);
  const fullAccess = workbenchReducer(toggled, { type: "access.set", mode: "full" });
  assert.equal(fullAccess.accessMode, "full");
  const switchedConversation = workbenchReducer(fullAccess, { type: "conversation.set", name: "release" });
  assert.equal(switchedConversation.currentConversation, "release");

  const pendingLocalTool = workbenchReducer(switchedConversation, {
    type: "local_tool.pending.set",
    approval: {
      name: "local_workspace",
      action: "write",
      arguments: { action: "write", path: "notes.txt", content: "hello\n" },
      preview: undefined,
      callID: "call_local",
      responseID: "resp_local",
    },
  });
  assert.equal(pendingLocalTool.pendingLocalTool?.name, "local_workspace");
  assert.equal(pendingLocalTool.pendingLocalTool?.action, "write");
  const clearedLocalTool = workbenchReducer(pendingLocalTool, { type: "local_tool.pending.clear" });
  assert.equal(clearedLocalTool.pendingLocalTool, null);

  const withWorkspace = workbenchReducer(clearedLocalTool, {
    type: "workspace.set",
    workspace: {
      root: "/tmp/example",
      name: "example",
      fileCount: 2,
      totalBytes: 42,
      scanTruncated: false,
    },
  });
  assert.equal(withWorkspace.workspace?.name, "example");
  assert.match(withWorkspace.activities.at(-1)?.text ?? "", /Workspace loaded/);
});

test("chat options default to pro-search unless model or preset is explicit", () => {
  assert.equal(normalizeChatOptions(["hi"], {}).preset, "pro-search");
  assert.equal(normalizeChatOptions(["hi"], { preset: "code-agent" }).preset, "code-agent");
  assert.equal(normalizeChatOptions(["hi"], { model: "provider/model" }).preset, undefined);
  assert.equal(normalizeChatOptions(["hi"], { model: "provider/model" }).model, "provider/model");
});

test("agent stream events map into workbench turn events", () => {
  assert.deepEqual(agentTurnEventFromStreamEvent({
    type: "response.output_text.delta",
    sequence_number: 1,
    delta: "hello",
  }), {
    type: "text.delta",
    delta: "hello",
  });

  assert.deepEqual(agentTurnEventFromStreamEvent({
    type: "response.reasoning.search_queries",
    sequence_number: 2,
    queries: ["agent api"],
  }), {
    type: "reasoning.search_queries",
    queries: ["agent api"],
  });

  assert.deepEqual(agentTurnEventFromStreamEvent({
    type: "response.tool.invocation.completed",
    sequence_number: 3,
    tool_result: {
      tool_name: "web_search",
      status: "completed",
    },
  }), {
    type: "tool.completed",
    name: "web_search",
    status: "completed",
  });
});

test("agent failed response message includes response identity and code", () => {
  assert.equal(agentResponseFailureMessage({
    id: "resp_failed",
    object: "response",
    created_at: 1,
    status: "failed",
    model: "provider/model",
    output: [],
    error: {
      code: "model_call_failed",
      message: "The model request failed. Please try again.",
      type: "server_error",
    },
  }), "Agent response resp_failed model=provider/model failed: The model request failed. Please try again. (model_call_failed)");
});

test("agent request tools preserve preset tools when appending local workspace tools", async () => {
  const calls = [];
  const client = {
    presets: {
      async list() {
        calls.push("presets");
        return {
          object: "list",
          data: [
            {
              preset: "pro-search",
              policy: { allowed_tools: ["smart_web_search", "fetch_url"] },
            },
          ],
        };
      },
    },
    tools: {
      async list() {
        calls.push("tools");
        return {
          object: "list",
          data: [
            { object: "tool", name: "smart_web_search", type: "search", max_tokens: 4096 },
            { object: "tool", name: "fetch_url", type: "url_reader" },
          ],
        };
      },
    },
  };

  const tools = await resolveAgentRequestTools(client, "pro-search", [
    {
      type: "function",
      name: "local_workspace",
      description: "Local workspace",
      parameters: { type: "object" },
    },
  ]);

  assert.deepEqual(calls, ["presets", "tools"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["smart_web_search", "fetch_url", "local_workspace"]);
  assert.equal(tools[0].type, "search");
  assert.equal(tools[2].type, "function");
});

test("agent request tools do not fetch catalogs without a preset", async () => {
  const client = {
    presets: { async list() { throw new Error("should not fetch presets"); } },
    tools: { async list() { throw new Error("should not fetch tools"); } },
  };
  const localTools = [{ type: "function", name: "local_workspace" }];

  const tools = await resolveAgentRequestTools(client, undefined, localTools);

  assert.deepEqual(tools, localTools);
});

test("agent request tools cache platform preset and tool catalogs by base URL", async () => {
  clearPresetToolCatalogCache("https://api.test");
  const calls = [];
  const client = {
    presets: {
      async list() {
        calls.push("presets");
        return {
          object: "list",
          data: [
            {
              preset: "pro-search",
              policy: { allowed_tools: ["smart_web_search"] },
            },
          ],
        };
      },
    },
    tools: {
      async list() {
        calls.push("tools");
        return {
          object: "list",
          data: [
            { object: "tool", name: "smart_web_search", type: "search" },
          ],
        };
      },
    },
  };
  const localTools = [
    {
      type: "function",
      name: "local_workspace",
      description: "Local workspace",
      parameters: { type: "object" },
    },
  ];

  await resolveAgentRequestTools(client, "pro-search", localTools, { baseURL: "https://api.test" });
  const tools = await resolveAgentRequestTools(client, "pro-search", localTools, { baseURL: "https://api.test/" });

  assert.deepEqual(calls, ["presets", "tools"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["smart_web_search", "local_workspace"]);
  clearPresetToolCatalogCache("https://api.test");
});
