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
  createInputHistory,
  createInitialWorkbenchState,
  formatTranscript,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  workbenchReducer,
} from "../dist/tui/workbench.js";
import { authStatusText, createWorkbenchAuthController } from "../dist/workbench/auth-controller.js";
import { createWorkbenchEngine } from "../dist/workbench/engine.js";
import { createWorkbenchLocalController } from "../dist/workbench/local-controller.js";
import {
  createWorkbenchSettingsController,
  formatPresetList,
  UnknownPresetError,
} from "../dist/workbench/settings-controller.js";
import {
  createConversationName,
  createWorkbenchConversationController,
  defaultTranscriptExportPath,
} from "../dist/workbench/conversation-controller.js";
import { createWorkbenchTurnController } from "../dist/workbench/turn-controller.js";
import { compareVersions, formatUpdateNotice } from "../dist/update.js";

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

test("workdir status inspects a local directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-workdir-"));
  await writeFile(join(root, "README.md"), "# Test Workdir\n");

  const { stdout } = await execFileAsync("node", [bin, "workdir", "status", "--path", root]);
  const status = JSON.parse(stdout);

  assert.equal(status.root, root);
  assert.equal(status.name, basename(root));
  assert.equal(status.fileCount, 1);
  assert.equal(status.snapshotFiles, 1);
  assert.equal(status.scanTruncated, false);
});

test("workbench auth controller checks, logs in, deletes, and formats status", async () => {
  const calls = [];
  const controller = createWorkbenchAuthController({
    async refreshActiveProfileIfNeededImpl(profile, refreshWindowMs) {
      calls.push(["refresh", profile, refreshWindowMs]);
      return { profile: { name: profile || "default" }, refreshed: true };
    },
    async loginWithAPIKeyImpl(input) {
      calls.push(["api", input.profile, input.baseURL, input.apiKey]);
      return { name: input.profile };
    },
    async getAuthStatusImpl(profile) {
      calls.push(["status", profile]);
      return {
        profile: profile || "default",
        baseURL: "https://api.example.test",
        authType: "api_key",
        me: { user: { email: "user@example.test" } },
      };
    },
    async deleteProfileImpl(name) {
      calls.push(["delete", name]);
    },
  });

  assert.deepEqual(await controller.check("dev", 123), { profileName: "dev", refreshed: true });
  assert.deepEqual(await controller.loginAPIKey({ profile: "dev", baseURL: "https://api", apiKey: "sk-test" }), {
    profileName: "dev",
  });
  const status = await controller.statusText("dev");
  assert.match(status, /Profile: dev/);
  assert.match(status, /Account: user@example\.test/);
  await controller.deleteProfile("dev");

  assert.deepEqual(calls, [
    ["refresh", "dev", 123],
    ["api", "dev", "https://api", "sk-test"],
    ["status", "dev"],
    ["delete", "dev"],
  ]);
});

test("workbench auth controller drives browser login callbacks", async () => {
  const events = [];
  const challenges = [];
  const statuses = [];
  const controller = createWorkbenchAuthController({
    async startBrowserAuthChallengeImpl(input) {
      events.push(["start", input.baseURL, input.clientName]);
      return {
        verification_uri_complete: "https://login.example.test/device",
        user_code: "abcd1234",
        device_code: "device-test",
        interval_seconds: 0,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
    },
    async openBrowserURLImpl(url) {
      events.push(["open", url]);
    },
    async waitForBrowserAuthChallengeImpl(input) {
      events.push(["wait", input.baseURL, input.challenge.device_code]);
      input.on_poll?.({ status: "approved" });
      return {
        access_token: "access-test",
        refresh_token: "refresh-test",
        access_token_expires_at: 1,
        refresh_token_expires_at: 2,
      };
    },
    async saveBrowserProfileImpl(name, baseURL, session) {
      events.push(["save", name, baseURL, session.access_token]);
      return { name };
    },
  });

  assert.deepEqual(
    await controller.loginBrowser({
      profile: "browser",
      baseURL: "https://api.example.test",
      onChallenge: (challenge) => challenges.push(challenge),
      onStatus: (status) => statuses.push(status),
    }),
    { profileName: "browser" },
  );
  assert.deepEqual(challenges, [{ url: "https://login.example.test/device", code: "ABCD-1234" }]);
  assert.deepEqual(statuses, ["approved"]);
  assert.deepEqual(events, [
    ["start", "https://api.example.test", "Agent API TUI"],
    ["open", "https://login.example.test/device"],
    ["wait", "https://api.example.test", "device-test"],
    ["save", "browser", "https://api.example.test", "access-test"],
  ]);
});

test("auth status text falls back to account availability", () => {
  assert.match(
    authStatusText({
      profile: "default",
      baseURL: "https://api.example.test",
      authType: "browser",
      me: {},
    }),
    /Account: available/,
  );
});

test("top-level workdir argument must exist before launching TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-missing-workdir-"));
  const missing = join(root, "missing");

  await assert.rejects(
    execFileAsync("node", [bin, missing]),
    (error) => {
      assert.match(error.stderr, /Workdir does not exist/);
      return true;
    },
  );
});

test("workbench command parser and reducer handle local workflow state", () => {
  assert.deepEqual(parseWorkbenchCommand("/search auth flow"), {
    kind: "search",
    query: "auth flow",
  });
  assert.deepEqual(parseWorkbenchCommand("/unknown"), { kind: "invalid", command: "unknown" });
  assert.deepEqual(parseWorkbenchCommand("/context"), { kind: "context", enabled: undefined });
  assert.deepEqual(parseWorkbenchCommand("/context on"), { kind: "context", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/context off"), { kind: "context", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/new release notes"), { kind: "new_conversation", name: "release notes" });
  assert.deepEqual(parseWorkbenchCommand("/new"), { kind: "new_conversation", name: undefined });
  assert.deepEqual(parseWorkbenchCommand("/switch release"), { kind: "switch_conversation", name: "release" });
  assert.deepEqual(parseWorkbenchCommand("/conversation"), { kind: "list_conversations" });
  assert.deepEqual(parseWorkbenchCommand("/conversations"), { kind: "list_conversations" });
  assert.deepEqual(parseWorkbenchCommand("/refresh"), { kind: "refresh_catalog" });
  assert.deepEqual(parseWorkbenchCommand("/auth"), { kind: "auth_status" });
  assert.deepEqual(parseWorkbenchCommand("/abort"), { kind: "abort" });
  assert.deepEqual(parseWorkbenchCommand("/cancel"), { kind: "abort" });
  assert.deepEqual(parseWorkbenchCommand("/login"), { kind: "login" });
  assert.deepEqual(parseWorkbenchCommand("/logout"), { kind: "logout" });
  assert.deepEqual(parseWorkbenchCommand("/quit"), { kind: "quit" });
  assert.deepEqual(parseWorkbenchCommand("/exit"), { kind: "quit" });
  assert.deepEqual(parseWorkbenchCommand("/delete-profile"), { kind: "delete_profile" });
  assert.deepEqual(parseWorkbenchCommand("/switch-profile work"), { kind: "switch_profile", name: "work" });
  assert.deepEqual(parseWorkbenchCommand("/switch-profile"), { kind: "switch_profile", name: undefined });
  assert.deepEqual(parseWorkbenchCommand("/config"), { kind: "config" });
  assert.deepEqual(parseWorkbenchCommand("/config preset pro-search"), { kind: "config", field: "preset", value: "pro-search" });
  assert.deepEqual(parseWorkbenchCommand("/config preset none"), { kind: "config", field: "preset", value: "none" });
  assert.deepEqual(parseWorkbenchCommand("/config nope"), { kind: "invalid", command: "config nope" });
  assert.deepEqual(parseWorkbenchCommand("/render"), { kind: "render" });
  assert.deepEqual(parseWorkbenchCommand("/render raw"), { kind: "render", mode: "raw" });
  assert.deepEqual(parseWorkbenchCommand("/render markdown"), { kind: "render", mode: "markdown" });
  assert.deepEqual(parseWorkbenchCommand("/transcript"), { kind: "transcript" });
  assert.deepEqual(parseWorkbenchCommand("/export"), { kind: "export", path: undefined });
  assert.deepEqual(parseWorkbenchCommand("/export ./notes/transcript.txt"), { kind: "export", path: "./notes/transcript.txt" });
  assert.deepEqual(parseWorkbenchCommand("/access"), { kind: "access" });
  assert.deepEqual(parseWorkbenchCommand("/access off"), { kind: "access", mode: "off" });
  assert.deepEqual(parseWorkbenchCommand("/access full"), { kind: "access", mode: "full" });
  assert.deepEqual(parseWorkbenchCommand("/access approval"), { kind: "access", mode: "approval" });
  assert.deepEqual(parseWorkbenchCommand("/preset pro-search"), { kind: "preset", value: "pro-search" });
  assert.deepEqual(parseWorkbenchCommand("/model auto"), { kind: "model", value: "auto" });
  assert.deepEqual(parseWorkbenchCommand("/workdir"), { kind: "workdir", enabled: undefined });
  assert.deepEqual(parseWorkbenchCommand("/workdir on"), { kind: "workdir", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/workdir off"), { kind: "workdir", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/local on"), { kind: "workdir", enabled: true });
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

  const initial = createInitialWorkbenchState({ contextEnabled: false, accessMode: "off" });
  assert.equal(initial.currentConversation, "default");
  assert.equal(initial.contextEnabled, false);
  assert.equal(initial.renderMode, "markdown");
  assert.equal(initial.runPreset, undefined);
  assert.equal(initial.runModel, undefined);
  const approvalAccess = workbenchReducer(initial, { type: "access.set", mode: "approval" });
  assert.equal(approvalAccess.contextEnabled, true);
  const fullAccess = workbenchReducer(approvalAccess, { type: "access.set", mode: "full" });
  assert.equal(fullAccess.accessMode, "full");
  assert.equal(fullAccess.contextEnabled, true);
  const offAccess = workbenchReducer(fullAccess, { type: "access.set", mode: "off" });
  assert.equal(offAccess.contextEnabled, false);
  const toggled = workbenchReducer(offAccess, { type: "context.toggle" });
  assert.equal(toggled.accessMode, "approval");
  assert.equal(toggled.contextEnabled, true);
  const switchedConversation = workbenchReducer(fullAccess, { type: "conversation.set", name: "release" });
  assert.equal(switchedConversation.currentConversation, "release");
  const withSettings = workbenchReducer(switchedConversation, {
    type: "settings.set",
    settings: {
      defaultPreset: "pro-search",
      renderMode: "raw",
      runModel: "provider/model",
      runPreset: "code-agent",
    },
  });
  assert.equal(withSettings.defaultPreset, "pro-search");
  assert.equal(withSettings.renderMode, "raw");
  assert.equal(withSettings.runModel, "provider/model");
  assert.equal(withSettings.runPreset, "code-agent");

  const pendingLocalTool = workbenchReducer(switchedConversation, {
    type: "local_tool.pending.set",
    approval: {
      name: "local_workdir",
      action: "write",
      arguments: { action: "write", path: "notes.txt", content: "hello\n" },
      preview: undefined,
      callID: "call_local",
      responseID: "resp_local",
    },
  });
  assert.equal(pendingLocalTool.pendingLocalTool?.name, "local_workdir");
  assert.equal(pendingLocalTool.pendingLocalTool?.action, "write");
  const clearedLocalTool = workbenchReducer(pendingLocalTool, { type: "local_tool.pending.clear" });
  assert.equal(clearedLocalTool.pendingLocalTool, null);

  const withWorkdir = workbenchReducer(clearedLocalTool, {
    type: "workdir.set",
    workdir: {
      root: "/tmp/example",
      name: "example",
      fileCount: 2,
      totalBytes: 42,
      scanTruncated: false,
    },
  });
  assert.equal(withWorkdir.workdir?.name, "example");
  assert.match(withWorkdir.activities.at(-1)?.text ?? "", /Workdir loaded/);
});

test("chat options default to pro-search unless model or preset is explicit", () => {
  const defaultOptions = normalizeChatOptions(["hi"], {});
  assert.equal(defaultOptions.preset, "pro-search");
  assert.equal(defaultOptions.presetExplicit, false);
  assert.equal(defaultOptions.modelExplicit, false);

  const presetOptions = normalizeChatOptions(["hi"], { preset: "code-agent" });
  assert.equal(presetOptions.preset, "code-agent");
  assert.equal(presetOptions.presetExplicit, true);

  const modelOptions = normalizeChatOptions(["hi"], { model: "provider/model" });
  assert.equal(modelOptions.preset, undefined);
  assert.equal(modelOptions.model, "provider/model");
  assert.equal(modelOptions.modelExplicit, true);
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

test("agent request tools preserve preset tools when appending local workdir tools", async () => {
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
      name: "local_workdir",
      description: "Local workdir",
      parameters: { type: "object" },
    },
    {
      type: "function",
      name: "local_shell",
      description: "Local shell",
      parameters: { type: "object" },
    },
  ]);

  assert.deepEqual(calls, ["presets", "tools"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["smart_web_search", "fetch_url", "local_workdir", "local_shell"]);
  assert.equal(tools[0].type, "search");
  assert.equal(tools[2].type, "function");
  assert.equal(tools[3].type, "function");
});

test("agent request tools do not fetch catalogs without a preset", async () => {
  const client = {
    presets: { async list() { throw new Error("should not fetch presets"); } },
    tools: { async list() { throw new Error("should not fetch tools"); } },
  };
  const localTools = [{ type: "function", name: "local_workdir" }];

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
      name: "local_workdir",
      description: "Local workdir",
      parameters: { type: "object" },
    },
  ];

  await resolveAgentRequestTools(client, "pro-search", localTools, { baseURL: "https://api.test" });
  const tools = await resolveAgentRequestTools(client, "pro-search", localTools, { baseURL: "https://api.test/" });

  assert.deepEqual(calls, ["presets", "tools"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["smart_web_search", "local_workdir"]);
  clearPresetToolCatalogCache("https://api.test");
});

test("update helper compares semver-ish CLI versions and formats npm notice", () => {
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.2", "1.2.2"), 0);
  assert.equal(compareVersions("1.2.1", "1.2.2"), -1);
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(formatUpdateNotice({
    current: "0.1.0",
    latest: "0.1.1",
    packageName: "@agent-api/cli",
    updateAvailable: true,
  }), "Update available: @agent-api/cli 0.1.0 -> 0.1.1. Run: npm install -g @agent-api/cli@latest");
});

test("preset list marks the current preset", () => {
  assert.deepEqual(formatPresetList([
    { preset: "pro-search", description: "Search preset" },
    { preset: "code-agent", description: "Code preset" },
  ], "pro-search"), [
    "* pro-search (current) - Search preset",
    "- code-agent - Code preset",
  ]);
});

test("workbench settings controller loads and saves default preset settings", async () => {
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      calls.push(["load"]);
      return { defaultPreset: "code-agent" };
    },
    async isAvailablePresetImpl(profile, preset) {
      calls.push(["validate", profile, preset]);
      return preset === "pro-search";
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(["update", patch.defaultPreset]);
      return { defaultPreset: patch.defaultPreset };
    },
  });

  assert.deepEqual(await controller.loadInitial({ modelExplicit: false, preset: "pro-search", presetExplicit: false }), {
    defaultPreset: "code-agent",
    runPreset: "code-agent",
  });

  assert.deepEqual(
    await controller.saveDefaultPreset({
      value: "pro-search",
      profileName: "dev",
      options: { modelExplicit: false, preset: "code-agent", presetExplicit: false },
    }),
    {
      defaultPreset: "pro-search",
      runPreset: "pro-search",
      message: "Saved default preset: pro-search.",
      activity: "Default preset saved: pro-search",
    },
  );

  assert.deepEqual(calls, [
    ["load"],
    ["validate", "dev", "pro-search"],
    ["update", "pro-search"],
  ]);
});

test("workbench settings controller reports unknown presets with catalog text", async () => {
  const controller = createWorkbenchSettingsController({
    async isAvailablePresetImpl() {
      return false;
    },
    async listAvailablePresetsImpl() {
      return [{ preset: "pro-search", description: "Search preset" }];
    },
  });

  await assert.rejects(
    controller.saveDefaultPreset({
      value: "missing",
      profileName: "dev",
      options: { modelExplicit: false, preset: "pro-search", presetExplicit: false },
    }),
    UnknownPresetError,
  );
  assert.match(
    await controller.presetListText({ profileName: "dev", currentPreset: "pro-search", prefix: "Unknown preset: missing" }),
    /\* pro-search \(current\) - Search preset/,
  );
});

test("workbench conversation controller manages handles and transcript export", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-conversation-"));
  const calls = [];
  const now = () => new Date("2026-06-22T12:34:56.000Z");
  const controller = createWorkbenchConversationController({
    dataDir: root,
    now,
    async deleteConversationImpl(name, profile) {
      calls.push(["delete", name, profile]);
    },
    async listConversationsImpl(profile) {
      calls.push(["list", profile]);
      return [
        {
          name: "release",
          profile: profile || "default",
          previousResponseId: "resp_test",
          updatedAt: 4102444800,
        },
      ];
    },
  });

  assert.deepEqual(await controller.startNewConversation(undefined, "dev"), {
    name: "thread-20260622-123456",
    message: 'Started fresh conversation "thread-20260622-123456".',
  });
  assert.deepEqual(controller.switchConversation("release"), {
    name: "release",
    message: 'Switched to conversation "release". Future turns will continue this handle when history exists.',
  });
  assert.match(await controller.listConversations("dev"), /release\tdev\t2100-01-01T00:00:00\.000Z response=resp_test/);

  const exported = await controller.exportTranscript({
    conversation: "release notes",
    transcript: "System:\nReady.\n",
  });
  assert.equal(exported, join(root, "transcripts", "release-notes-2026-06-22T12-34-56-000Z.txt"));
  assert.equal(await readFile(exported, "utf8"), "System:\nReady.\n");
  assert.deepEqual(calls, [
    ["delete", "thread-20260622-123456", "dev"],
    ["list", "dev"],
  ]);
});

test("workbench conversation naming helpers sanitize generated paths", () => {
  const now = new Date("2026-06-22T01:02:03.000Z");
  assert.equal(createConversationName(now), "thread-20260622-010203");
  assert.equal(
    defaultTranscriptExportPath("Release Notes!", { dataDir: "/tmp/agent-tui", now: () => now }),
    "/tmp/agent-tui/transcripts/Release-Notes-2026-06-22T01-02-03-000Z.txt",
  );
});

test("input history navigates submitted prompts like a shell", () => {
  const history = createInputHistory(2);
  history.record("first");
  history.record("second");
  history.record("second");
  history.record("third");

  assert.deepEqual(history.values(), ["second", "third"]);
  assert.equal(history.previous("draft"), "third");
  assert.equal(history.previous("third"), "second");
  assert.equal(history.previous("second"), "second");
  assert.equal(history.next("second"), "third");
  assert.equal(history.next("third"), "draft");
  assert.equal(history.next("draft"), "draft");

  history.record("fourth");
  assert.deepEqual(history.values(), ["third", "fourth"]);
});

test("workbench transcript formatter produces readable plain text", () => {
  assert.equal(formatTranscript([
    { id: "1", role: "system", text: "Ready." },
    { id: "2", role: "user", text: "Hello" },
    { id: "3", role: "assistant", text: "Hi there\n" },
  ]), "System:\nReady.\n\nYou:\nHello\n\nAgent:\nHi there\n");
});


test("workbench engine exposes renderer-neutral state snapshots", () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, accessMode: "off", conversation: "demo" });
  const seen = [];
  const unsubscribe = engine.subscribe(() => seen.push(engine.snapshot()));

  assert.equal(engine.snapshot().currentConversation, "demo");
  assert.equal(engine.snapshot().contextEnabled, false);

  engine.dispatch({ type: "access.set", mode: "approval" });
  assert.equal(engine.snapshot().accessMode, "approval");
  assert.equal(engine.snapshot().contextEnabled, true);
  assert.equal(seen.length, 1);

  unsubscribe();
  engine.dispatch({ type: "message.add", role: "user", text: "hello" });
  assert.equal(engine.snapshot().messages.at(-1).text, "hello");
  assert.equal(seen.length, 1);
});

test("workbench engine routes submitted input into prompts and commands", () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, accessMode: "off" });

  assert.deepEqual(engine.submit("  "), { kind: "handled" });
  assert.deepEqual(engine.submit("/help"), { kind: "command", command: { kind: "help" } });
  assert.deepEqual(engine.submit("hello agent"), { kind: "prompt", prompt: "hello agent" });
});

test("workbench engine handles renderer-neutral commands", () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, accessMode: "off" });

  assert.equal(engine.handleCommand({ kind: "render", mode: "raw" }).handled, true);
  assert.equal(engine.snapshot().renderMode, "raw");
  assert.match(engine.snapshot().messages.at(-1).text, /Render mode set to raw/);

  assert.equal(engine.handleCommand({ kind: "model", value: "provider/model" }).handled, true);
  assert.equal(engine.snapshot().runModel, "provider/model");
  assert.equal(engine.handleCommand({ kind: "model", value: "auto" }).handled, true);
  assert.equal(engine.snapshot().runModel, undefined);

  assert.equal(engine.handleCommand({ kind: "access", mode: "full" }).handled, true);
  assert.equal(engine.snapshot().accessMode, "full");
  assert.equal(engine.snapshot().contextEnabled, true);

  assert.equal(engine.handleCommand({ kind: "workdir" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /local_shell tool: on/);

  assert.equal(engine.handleCommand({ kind: "transcript" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /Transcript preview/);

  assert.equal(engine.handleCommand({ kind: "invalid", command: "wat" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /Unknown command: \/wat/);

  const exportResult = engine.handleCommand({ kind: "export" });
  assert.equal(exportResult.handled, true);
  assert.deepEqual(exportResult.effects.map((effect) => effect.type), ["export_transcript"]);
  assert.match(exportResult.effects[0].type === "export_transcript" ? exportResult.effects[0].transcript : "", /System:/);

  const refreshResult = engine.handleCommand({ kind: "refresh_catalog" });
  assert.equal(refreshResult.handled, true);
  assert.deepEqual(refreshResult.effects, [{ type: "clear_preset_tool_catalog_cache" }]);
  assert.match(engine.snapshot().messages.at(-1).text, /Cleared cached preset/);

  const summaryResult = engine.handleCommand({ kind: "summary" });
  assert.equal(summaryResult.handled, false);
  assert.deepEqual(summaryResult.effects, []);
});

test("workbench engine maps agent events into state and runtime effects", () => {
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "approval" });

  assert.deepEqual(engine.handleAgentEvent({ type: "text.delta", delta: "hello" }).effects, [
    { type: "append_text_delta", delta: "hello" },
  ]);

  assert.deepEqual(engine.handleAgentEvent({ type: "response.started", responseID: "resp_123" }).effects, [
    { type: "set_active_response_id", responseID: "resp_123" },
  ]);
  assert.match(engine.snapshot().activities.at(-1).text, /Response started: resp_123/);

  assert.deepEqual(engine.handleAgentEvent({ type: "response.completed", responseID: "resp_123" }).effects, [
    { type: "flush_text_delta_buffer" },
  ]);
  assert.match(engine.snapshot().activities.at(-1).text, /Response completed: resp_123/);

  assert.deepEqual(engine.handleAgentEvent({ type: "model.requested", model: "model", provider: "provider" }).effects, []);
  assert.match(engine.snapshot().activities.at(-1).text, /provider\/model/);

  assert.deepEqual(engine.handleAgentEvent({
    type: "local_tool.approval_requested",
    name: "local_workdir",
    action: "write",
    arguments: { action: "write", path: "notes.txt", content: "hello\n" },
    callID: "call_local",
    responseID: "resp_local",
  }).effects, []);
  assert.equal(engine.snapshot().pendingLocalTool?.name, "local_workdir");
  assert.match(engine.snapshot().messages.at(-1).text, /Local action requires approval/);
});

test("workbench local controller loads, summarizes, and searches a workdir", async () => {
  const fakeWorkdir = {
    root: "/tmp/project",
    name: "project",
    workdir: {
      async grep() {
        return {
          matches: [
            { path: "README.md", line_number: 2, line: "  hello agent  " },
          ],
        };
      },
    },
    async summarize() {
      return {
        file_count: 2,
        total_bytes: 2048,
        scan_truncated: false,
        text_previews: [
          { path: "README.md", size: 120 },
        ],
      };
    },
  };
  const controller = createWorkbenchLocalController({
    async openWorkdirImpl() {
      return fakeWorkdir;
    },
  });

  assert.equal(controller.isLoaded(), false);
  assert.deepEqual(await controller.load("/tmp/project"), {
    root: "/tmp/project",
    name: "project",
    fileCount: 2,
    totalBytes: 2048,
    scanTruncated: false,
  });
  assert.equal(controller.isLoaded(), true);
  assert.match(await controller.summaryText(), /Workdir summary for project/);
  assert.deepEqual(await controller.searchText("hello"), {
    text: "README.md:2: hello agent",
    count: 1,
  });
  assert.match(controller.approvalPreview({
    name: "local_workdir",
    action: "write",
    arguments: { action: "write", path: "NOTES.md" },
  }), /Local approval requested: local_workdir\.write/);
});

test("workbench turn controller runs prompt turns through engine state", async () => {
  const engine = createWorkbenchEngine({
    accessMode: "approval",
    contextEnabled: true,
    conversation: "demo",
    model: "provider/model",
    preset: "pro-search",
  });
  const runtimeEffects = [];
  const seenOptions = [];
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {
      runtimeEffects.push({ type: "flush" });
    },
    getState: engine.snapshot,
    runRuntimeEffects(effects, assistantId) {
      runtimeEffects.push({ assistantId, effects });
    },
    async runAgentTurnImpl(options, onEvent) {
      seenOptions.push(options);
      onEvent?.({ type: "response.started", responseID: "resp_turn" });
      onEvent?.({ type: "text.delta", delta: "hello" });
      onEvent?.({ type: "response.completed", responseID: "resp_turn" });
      return { text: "hello", responseID: "resp_turn" };
    },
  });

  await controller.startPrompt("hello agent");

  assert.equal(seenOptions[0].preset, "pro-search");
  assert.equal(seenOptions[0].model, "provider/model");
  assert.equal(seenOptions[0].conversation, "demo");
  assert.equal(seenOptions[0].includeLocalContext, true);
  assert.equal(seenOptions[0].accessMode, "approval");
  assert.equal(engine.snapshot().busy, false);
  assert.equal(engine.snapshot().activeAssistantMessageId, null);
  assert.match(engine.snapshot().activities.at(-1).text, /Agent turn completed: resp_turn/);
  assert.equal(runtimeEffects.some((entry) => Array.isArray(entry.effects) && entry.effects.some((effect) => effect.type === "append_text_delta")), true);
  assert.equal(runtimeEffects.some((entry) => entry.type === "flush"), true);
});

test("workbench turn controller aborts active remote responses", async () => {
  const engine = createWorkbenchEngine({ accessMode: "approval", contextEnabled: true });
  let releaseTurn;
  let cancelledResponseID = "";
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {},
    getState: engine.snapshot,
    runRuntimeEffects() {},
    async runAgentTurnImpl(_options, onEvent) {
      onEvent?.({ type: "response.started", responseID: "resp_abort" });
      await new Promise((resolve) => {
        releaseTurn = resolve;
      });
      return { text: "", responseID: "resp_abort" };
    },
    async resolveRuntimeProfileImpl() {
      return {
        client: {
          responses: {
            async cancel(responseID) {
              cancelledResponseID = responseID;
              return { interrupted: true };
            },
          },
        },
      };
    },
  });

  const turn = controller.startPrompt("long task");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.abort("Abort requested.");
  releaseTurn();
  await turn;

  assert.equal(cancelledResponseID, "resp_abort");
  assert.equal(engine.snapshot().busy, false);
  assert.equal(engine.snapshot().messages.some((message) => /Abort requested for response resp_abort/.test(message.text)), true);
});

test("workbench engine owns pending local approval input policy", () => {
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "approval" });
  engine.dispatch({
    type: "local_tool.pending.set",
    approval: {
      name: "local_workdir",
      action: "write",
      arguments: { action: "write", path: "notes.txt", content: "hello\n" },
      callID: "call_local",
      responseID: "resp_local",
    },
  });

  assert.deepEqual(engine.submit("approve"), { kind: "handled" });
  assert.match(engine.snapshot().messages.at(-1).text, /Invalid input 1\/3/);
  assert.equal(engine.snapshot().pendingLocalTool?.name, "local_workdir");

  assert.deepEqual(engine.submit("/apply"), { kind: "command", command: { kind: "apply" } });

  engine.dispatch({
    type: "local_tool.pending.set",
    approval: {
      name: "local_workdir",
      action: "write",
      arguments: { action: "write", path: "notes.txt", content: "hello\n" },
      callID: "call_local",
      responseID: "resp_local",
    },
  });
  engine.submit("bad one");
  engine.submit("bad two");
  engine.submit("bad three");

  assert.equal(engine.snapshot().pendingLocalTool, null);
  assert.match(engine.snapshot().messages.at(-1).text, /aborted after too many invalid inputs/);
});
