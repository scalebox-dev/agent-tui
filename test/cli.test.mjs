import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import {
  bindLineDelimitedAgentEngineRpcHandler,
  agentResponseFailureMessage,
  agentTurnEventFromStreamEvent,
  checkForUpdate,
  clearPresetToolCatalogCache,
  compareVersions,
  configureAgentAppRuntime,
  createAgentEngine,
  createAgentEngineRpcClient,
  createAgentEngineRpcHandler,
  createInProcessAgentEngineClient,
  createLineDelimitedAgentEngineRpcTransport,
  formatUpdateNotice,
  listProfileWorkspaces,
  loadConfig,
  loginWithAPIKey,
  localToolExecutionErrorResult,
  normalizeChatOptions,
  resolveAgentRequestTools,
  localUpdateInstallPlan,
} from "@agent-api/app-engine/core";
import {
  authStatusText,
  createConversationName,
  createInputHistory,
  createFileTranscriptStore,
  createInitialWorkbenchState,
  createMemoryTranscriptStore,
  createWorkbenchAuthController,
  createWorkbenchAuthGateController,
  createWorkbenchCommandController,
  createWorkbenchConversationController,
  createWorkbenchEngine,
  createWorkbenchEngine as createWorkbenchEngineFromBoundary,
  createWorkbenchLifecycleController,
  createWorkbenchLocalController,
  createWorkbenchRuntimeController,
  createWorkbenchSession,
  createWorkbenchSession as createWorkbenchSessionFromBoundary,
  createWorkbenchSettingsController,
  createWorkbenchTurnController,
  defaultTranscriptExportPath,
  formatPresetList,
  formatTranscript,
  helpText,
  installConfiguredIsolator,
  localShellIsolationOptions,
  localShellIsolationOptions as localShellIsolationOptionsFromBoundary,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  selectedConversationPendingLocalTool,
  sessionState,
  summarizeMessages,
  UnknownPresetError,
  updateNoticeEffects,
  workbenchReducer,
} from "@agent-api/app-engine/workbench";
import {
  buildTranscriptLines,
  buildTranscriptViewModel,
  buildWorkbenchRenderModel,
  copyTextFromTranscriptSelection,
  copyTextFromRenderModel,
  createWorkbenchInputController,
  createWorkbenchTerminalController,
  elapsedDots,
  initialWorkbenchTerminalState,
  pendingLocalLabel,
  selectedPanelRange,
  spinnerGlyph,
} from "@agent-api/app-engine/terminal";
import {
  createKeychainStorage,
  createKeyValueStorage,
  createMemoryStorage,
  createMySQLStorage,
  createPostgresStorage,
  createSQLiteStorage,
} from "@agent-api/app-engine/storage";
import { localAppDirs } from "@agent-api/sdk/local";
import { parseMouseEvent } from "../dist/tui/mouse.js";

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

function testConfigDir(root, appName = "agent-tui") {
  return localAppDirs({
    appName,
    home: root,
    env: isolatedEnv(root),
  }).config;
}

function lineReader(stream) {
  stream.setEncoding("utf8");
  const lines = [];
  const waiters = [];
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  return () => {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

function stubAuthController() {
  return {
    async check() { return { profileName: "default", refreshed: false }; },
    async loginAPIKey() { return { profileName: "default" }; },
    async loginBrowser() { return { profileName: "default" }; },
    async deleteProfile() {},
    async statusText() { return "Profile: default"; },
    async refresh() { return { refreshed: false }; },
  };
}

function stubConversationController() {
  return {
    async resolveConversation(name) {
      return { id: "conv_stub", name, status: "fresh", message: "Fresh." };
    },
    async startNewConversation(name) {
      return { id: "conv_stub", name: name || "new", status: "fresh", message: "Started." };
    },
    async switchConversation(name) {
      return { id: "conv_stub", name, status: "fresh", message: "Switched." };
    },
    async renameConversation(_name, nextName) {
      return { id: "conv_stub", name: nextName, status: "fresh", message: "Renamed." };
    },
    async deleteConversation(name) {
      return { name, message: `Deleted ${name}.` };
    },
    async listConversations() {
      return "No conversations.";
    },
    async updateRunSettings() {},
    async exportTranscript() {
      return "/tmp/transcript.txt";
    },
  };
}

function stubWorkspaceController() {
  return {
    async load() {
      return {
        authType: "browser",
        current: { id: "wrk_stub", name: "Stub Workspace", role: "owner", userId: "user_stub" },
        switchable: true,
        workspaces: [
          { id: "wrk_stub", name: "Stub Workspace", role: "owner", status: "active", membershipStatus: "active" },
          { id: "wrk_other", name: "Other Workspace", role: "member", status: "active", membershipStatus: "active" },
        ],
      };
    },
    async switchWorkspace(_profile, workspaceId) {
      return {
        authType: "browser",
        current: { id: workspaceId, name: workspaceId === "wrk_other" ? "Other Workspace" : "Stub Workspace", role: "owner", userId: "user_stub" },
        switchable: true,
        workspaces: [
          { id: "wrk_stub", name: "Stub Workspace", role: "owner", status: "active", membershipStatus: "active" },
          { id: "wrk_other", name: "Other Workspace", role: "member", status: "active", membershipStatus: "active" },
        ],
      };
    },
  };
}

function stubLocalController() {
  return {
    async load() {
      return { root: "/tmp/workdir", name: "workdir", fileCount: 0, totalBytes: 0, scanTruncated: false };
    },
    isLoaded() { return false; },
    async summaryText() { return "summary"; },
    async searchText() { return { text: "matches", count: 1 }; },
    approvalPreview() { return "preview"; },
    async applyApproval() { return { ok: true }; },
  };
}

function stubSettingsController() {
  return {
    async loadInitial() { return {}; },
    async saveDefaultPreset() { return { defaultPreset: "pro-search", runPreset: "pro-search", message: "saved", activity: "saved" }; },
    async saveAutomaticContinuationLimit() { return { automaticContinuationLimit: 8, message: "saved", activity: "saved" }; },
    async saveShellIsolationMode() { return { shellIsolation: { mode: "auto" }, message: "saved", activity: "saved" }; },
    async saveIsolatorPath() { return { shellIsolation: { executablePath: "/opt/agent-isolator" }, message: "saved", activity: "saved" }; },
    async saveIsolatorSource() { return { shellIsolation: { sourceURL: "https://example.test/agent-isolator" }, message: "saved", activity: "saved" }; },
    async validatePreset() { return true; },
    async presetListText(input) { return input.prefix; },
    configText() { return "config"; },
    defaultPresetHelp() { return "default preset help"; },
    automaticContinuationLimitHelp() { return "automatic continuation limit help"; },
    shellIsolationHelp() { return "shell isolation help"; },
    isolatorPathHelp() { return "isolator path help"; },
    clearPresetToolCatalogCache() {},
  };
}

function stubTurnController() {
  return {
    async startPrompt() {},
    async continueAfterLocalApproval() {},
    async continueAfterAutomaticContinuation() {},
    async abort() {},
    resumeTimedPause() { return false; },
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

test("agent engine boundary exports reusable workbench primitives", () => {
  assert.equal(typeof createAgentEngine, "function");
  assert.equal(typeof createInProcessAgentEngineClient, "function");
  assert.equal(typeof createAgentEngineRpcClient, "function");
  assert.equal(typeof createAgentEngineRpcHandler, "function");
  assert.equal(createWorkbenchEngineFromBoundary, createWorkbenchEngine);
  assert.equal(createWorkbenchSessionFromBoundary, createWorkbenchSession);
  assert.equal(localShellIsolationOptionsFromBoundary, localShellIsolationOptions);
});

test("app engine package is importable through package exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-engine-export-"));
  const scope = join(root, "node_modules", "@agent-api");
  await mkdir(scope, { recursive: true });
  await symlink(new URL("../packages/app-engine", import.meta.url).pathname, join(scope, "app-engine"), "dir");

  const rootExport = await execFileAsync("node", [
    "--input-type=module",
    "-e",
    "import * as appEngine from '@agent-api/app-engine'; console.log(String(Object.keys(appEngine).length));",
  ], { cwd: root });
  const subpathExports = await execFileAsync("node", [
    "--input-type=module",
    "-e",
    [
      "import { createAgentEngine } from '@agent-api/app-engine/core';",
      "import { createWorkbenchEngine } from '@agent-api/app-engine/workbench';",
      "import { buildWorkbenchRenderModel } from '@agent-api/app-engine/terminal';",
      "import { createMemoryStorage } from '@agent-api/app-engine/storage';",
      "console.log([typeof createAgentEngine, typeof createWorkbenchEngine, typeof buildWorkbenchRenderModel, typeof createMemoryStorage].join(','));",
    ].join(" "),
  ], { cwd: root });

  assert.equal(rootExport.stdout.trim(), "0");
  assert.equal(subpathExports.stdout.trim(), "function,function,function,function");
});

test("app engine runtime identity is configurable by host apps", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-app-engine-runtime-"));
  const env = isolatedEnv(root);

  const { stdout } = await execFileAsync("node", [
    "--input-type=module",
    "-e",
    [
      "import { configureAgentAppRuntime, loginWithAPIKey, runtime } from '@agent-api/app-engine/core';",
      "configureAgentAppRuntime({ appName: 'desktop-shell', appAuthor: 'AgentsWay', appVersion: '9.8.7', legacyAppName: null });",
      "await loginWithAPIKey({ profile: 'desktop', baseURL: 'https://api.test', apiKey: 'sk-desktop' });",
      "console.log(JSON.stringify({ appName: runtime.appName, configDir: runtime.dirs.config }));",
    ].join(" "),
  ], { cwd: new URL("..", import.meta.url).pathname, env });

  const result = JSON.parse(stdout);
  assert.equal(result.appName, "desktop-shell");
  assert.match(result.configDir, /desktop-shell/);
  const config = JSON.parse(await readFile(join(result.configDir, "profiles.json"), "utf8"));
  assert.equal(config.profiles.desktop.baseURL, "https://api.test");
});

test("agent engine facade submits prompts and commands without renderer dependencies", async () => {
  const prompts = [];
  const aborts = [];
  let exited = false;
  const app = createAgentEngine({
    authController: stubAuthController(),
    baseOptions: { accessMode: "off", conversation: "default", promptParts: ["initial", "prompt"] },
    profileName: "default",
    services: {
      conversation: {
        async resolveConversation(name) {
          return {
            id: "conv_existing",
            name,
            previousResponseId: "resp_previous",
            status: "continued",
            message: "Continuing.",
          };
        },
        async startNewConversation(name) {
          return { id: "conv_new", name: name || "new", status: "fresh", message: "Started." };
        },
        async switchConversation(name) {
          return { id: "conv_switch", name, status: "fresh", message: "Switched." };
        },
        async listConversations() {
          return "No conversations.";
        },
        async exportTranscript() {
          return "/tmp/transcript.txt";
        },
      },
      turn: {
        async startPrompt(prompt) {
          prompts.push(prompt);
        },
        async continueAfterLocalApproval() {},
        async abort(message) {
          aborts.push(message);
        },
      },
      workspace: stubWorkspaceController(),
    },
    async onDeleteProfile() {},
    onExit() {
      exited = true;
    },
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await app.loadWorkspaceContext();
  await app.loadInitialConversation();
  assert.equal(app.snapshot().conversationId, "conv_existing");
  assert.equal(app.snapshot().conversationStatus, "continued");
  assert.equal(app.snapshot().conversationPreviousResponseId, "resp_previous");
  assert.match(app.snapshot().messages.at(-1).text, /Continuing conversation "default" from resp_previous/);

  await app.startInitialPrompt();
  await app.startInitialPrompt();
  assert.deepEqual(prompts, ["initial prompt"]);

  await app.submit("hello");
  assert.deepEqual(prompts, ["initial prompt", "hello"]);

  await app.abortActiveTurn("stop");
  assert.deepEqual(aborts, ["stop"]);

  await app.submit("/quit");
  assert.equal(exited, true);
  app.dispose();
});

test("agent engine RPC handler drives the in-process client boundary", async () => {
  const client = createInProcessAgentEngineClient({
    authController: stubAuthController(),
    baseOptions: { accessMode: "off", conversation: "default", promptParts: [] },
    profileName: "default",
    services: {
      workspace: stubWorkspaceController(),
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });
  const handler = createAgentEngineRpcHandler(client);
  const events = [];
  const unsubscribe = handler.subscribe((event) => events.push(event));

  const dispatchResponse = await handler.handle({
    id: 1,
    method: "dispatch",
    params: { action: { type: "activity.add", level: "success", text: "RPC activity" } },
  });
  assert.deepEqual(dispatchResponse, { id: 1, ok: true, result: null });
  assert.equal(handler.snapshot().activities.at(-1)?.text, "RPC activity");
  assert.equal(events.at(-1)?.type, "state");

  const snapshotResponse = await handler.handle({ id: "snapshot", method: "snapshot" });
  assert.equal(snapshotResponse.ok, true);
  assert.equal(snapshotResponse.id, "snapshot");
  assert.equal(snapshotResponse.result.activities.at(-1)?.text, "RPC activity");

  const invalidResponse = await handler.handle({ id: 2, method: "submit", params: {} });
  assert.equal(invalidResponse.ok, false);
  assert.match(invalidResponse.error.message, /Missing RPC parameter: input/);

  unsubscribe();
  client.dispose();
});

test("agent engine RPC client consumes a transport-backed state stream", async () => {
  const inProcessClient = createInProcessAgentEngineClient({
    authController: stubAuthController(),
    baseOptions: { accessMode: "off", conversation: "default", promptParts: [] },
    profileName: "default",
    services: {
      workspace: stubWorkspaceController(),
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });
  const handler = createAgentEngineRpcHandler(inProcessClient);
  const transportListeners = new Set();
  const unsubscribeHandler = handler.subscribe((event) => {
    for (const listener of transportListeners) listener(event);
  });
  let nextId = 1;
  const transport = {
    async request(method, params) {
      const response = await handler.handle({ id: nextId++, method, params });
      if (!response.ok) throw new Error(response.error.message);
      return response.result;
    },
    subscribe(listener) {
      transportListeners.add(listener);
      return () => transportListeners.delete(listener);
    },
    dispose() {
      unsubscribeHandler();
    },
  };
  const rpcClient = createAgentEngineRpcClient(transport, handler.snapshot());
  const updates = [];
  const unsubscribeClient = rpcClient.subscribe(() => updates.push(rpcClient.snapshot()));

  await rpcClient.dispatch({ type: "activity.add", level: "success", text: "Transport activity" });
  assert.equal(rpcClient.snapshot().activities.at(-1)?.text, "Transport activity");
  assert.equal(updates.at(-1)?.activities.at(-1)?.text, "Transport activity");

  await assert.rejects(
    () => rpcClient.submit(42),
    /Invalid RPC parameter: input/,
  );

  unsubscribeClient();
  rpcClient.dispose();
  inProcessClient.dispose();
});

test("agent engine line transport carries requests, responses, and state events", async () => {
  const inProcessClient = createInProcessAgentEngineClient({
    authController: stubAuthController(),
    baseOptions: { accessMode: "off", conversation: "default", promptParts: [] },
    profileName: "default",
    services: {
      workspace: stubWorkspaceController(),
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });
  const handler = createAgentEngineRpcHandler(inProcessClient);
  const clientToHost = new PassThrough();
  const hostToClient = new PassThrough();
  const errors = [];
  const connection = bindLineDelimitedAgentEngineRpcHandler(handler, {
    input: clientToHost,
    output: hostToClient,
    onError(error) {
      errors.push(error);
    },
  });
  const transport = createLineDelimitedAgentEngineRpcTransport({
    input: hostToClient,
    output: clientToHost,
    onError(error) {
      errors.push(error);
    },
  });
  const rpcClient = createAgentEngineRpcClient(transport, handler.snapshot());
  const updates = [];
  const unsubscribe = rpcClient.subscribe(() => updates.push(rpcClient.snapshot()));

  await rpcClient.dispatch({ type: "activity.add", level: "success", text: "Line transport activity" });
  assert.equal(rpcClient.snapshot().activities.at(-1)?.text, "Line transport activity");
  assert.equal(updates.at(-1)?.activities.at(-1)?.text, "Line transport activity");
  assert.deepEqual(errors, []);

  unsubscribe();
  rpcClient.dispose();
  connection.dispose();
  inProcessClient.dispose();
});

test("agent engine restores latest saved conversation when conversation is implicit", async () => {
  let resolvedName = "";
  const loadedTranscripts = [];
  const app = createAgentEngine({
    authController: stubAuthController(),
    baseOptions: {
      accessMode: "off",
      conversation: "default",
      conversationExplicit: false,
      promptParts: [],
    },
    profileName: "default",
    services: {
      conversation: {
        async resolveConversation(name) {
          resolvedName = name;
          return {
            id: name === "latest" ? "conv_latest" : "conv_default",
            name,
            previousResponseId: "resp_latest",
            runSettings: {
              accessMode: "full",
              memoryRead: true,
              model: "provider/saved",
              preset: "saved-preset",
              workspaceSkillsEnabled: true,
            },
            status: "continued",
            message: "Continuing.",
          };
        },
        async startNewConversation(name) {
          return { id: "conv_new", name: name || "new", status: "fresh", message: "Started." };
        },
        async switchConversation(name) {
          return { id: "conv_switch", name, status: "fresh", message: "Switched." };
        },
        async listConversationSelections() {
          return [
            { id: "conv_latest", name: "latest", status: "continued", previousResponseId: "resp_latest", updatedAt: 20, message: "" },
            { id: "conv_default", name: "default", status: "continued", previousResponseId: "resp_old", updatedAt: 10, message: "" },
          ];
        },
        async listConversations() {
          return "latest";
        },
        async exportTranscript() {
          return "/tmp/transcript.txt";
        },
      },
      transcriptStore: {
        async appendMessage() {},
        async appendMessageDelta() {},
        async clearConversation() {},
        async exportConversation() { return ""; },
        async getConversationSummary() { return { latestSnippet: "", messageCount: 0, titleSnippet: "" }; },
        async loadAfterMessages() { return []; },
        async loadBeforeMessages() { return []; },
        async loadRecentMessages(conversationId) {
          loadedTranscripts.push(conversationId);
          return [{ id: "m_latest", role: "user", text: "latest transcript", transcriptSeq: 1 }];
        },
      },
      turn: {
        async startPrompt() {},
        async continueAfterLocalApproval() {},
        async abort() {},
      },
      workspace: stubWorkspaceController(),
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await app.loadWorkspaceContext();
  await app.loadInitialConversation();

  assert.equal(resolvedName, "latest");
  assert.equal(app.snapshot().currentConversation, "latest");
  assert.equal(app.snapshot().conversationId, "conv_latest");
  assert.equal(app.snapshot().accessMode, "full");
  assert.equal(app.snapshot().memoryRead, true);
  assert.equal(app.snapshot().runModel, "provider/saved");
  assert.equal(app.snapshot().runPreset, "saved-preset");
  assert.equal(app.snapshot().workspaceSkillsEnabled, true);
  assert.deepEqual(loadedTranscripts, ["conv_latest"]);
  assert.equal(app.snapshot().messages.some((message) => message.text === "latest transcript"), true);
  app.dispose();
});

test("agent conversation manager lists, shows, and deletes local conversation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-test-"));
  const env = isolatedEnv(root);

  await execFileAsync("node", [bin, "auth", "login", "--profile", "test", "--api-key", "sk-test-abcdefghijklmnopqrstuvwxyz", "--base-url", "https://api.test"], { env });

  const configDir = testConfigDir(root);
  const conversationsPath = join(configDir, "conversations.json");
  const conversations = { conversations: {} };
  conversations.conversations["test:release"] = {
    id: "conv_release",
    name: "release",
    profile: "test",
    previousResponseId: "resp_test",
    createdAt: 4102444700,
    updatedAt: 4102444800,
  };
  await writeFile(conversationsPath, JSON.stringify(conversations, null, 2));

  const { stdout: listOut } = await execFileAsync("node", [bin, "agent", "list"], { env });
  assert.match(listOut, /release\s+test\s+2100-01-01T00:00:00\.000Z\s+conv_release response=resp_test/);

  const { stdout: showOut } = await execFileAsync("node", [bin, "agent", "show", "release"], { env });
  assert.equal(JSON.parse(showOut).previousResponseId, "resp_test");

  await execFileAsync("node", [bin, "agent", "delete", "release"], { env });
  const { stdout: emptyOut } = await execFileAsync("node", [bin, "agent", "list"], { env });
  assert.match(emptyOut, /No agent conversations yet/);
});

test("workbench configuration is stored separately from profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-config-split-"));
  const env = isolatedEnv(root);

  await execFileAsync("node", [bin, "auth", "login", "--profile", "test", "--api-key", "sk-test-abcdefghijklmnopqrstuvwxyz", "--base-url", "https://api.test"], { env });

  const configDir = testConfigDir(root);
  const profilesPath = join(configDir, "profiles.json");
  const appConfigPath = join(configDir, "configuration.json");
  const conversationsPath = join(configDir, "conversations.json");
  const profiles = JSON.parse(await readFile(profilesPath, "utf8"));
  assert.equal(profiles.workbench, undefined);
  assert.equal(profiles.conversations, undefined);
  profiles.workbench = { defaultPreset: "stale-profile-config" };
  profiles.conversations = {
    "test:stale": {
      name: "stale",
      profile: "test",
      previousResponseId: "resp_stale",
      updatedAt: 4102444800,
    },
  };
  await writeFile(profilesPath, JSON.stringify(profiles, null, 2));

  await execFileAsync("node", [
    "--input-type=module",
    "-e",
    "import { updateWorkbenchPreferences } from '@agent-api/app-engine/core'; await updateWorkbenchPreferences({ defaultPreset: 'pro-search', automaticContinuationLimit: 12, isolation: { mode: 'required', executablePath: '/opt/agent-isolator' } });",
  ], { cwd: new URL("..", import.meta.url).pathname, env });

  const updatedProfiles = JSON.parse(await readFile(profilesPath, "utf8"));
  const appConfig = JSON.parse(await readFile(appConfigPath, "utf8"));
  const conversationConfig = JSON.parse(await readFile(conversationsPath, "utf8"));
  assert.equal(updatedProfiles.workbench, undefined);
  assert.equal(updatedProfiles.conversations, undefined);
  assert.deepEqual(appConfig.workbench, {
    defaultPreset: "pro-search",
    automaticContinuationLimit: 12,
    isolation: { mode: "required", executablePath: "/opt/agent-isolator" },
  });
  assert.deepEqual(conversationConfig.conversations, profiles.conversations);

  const { stdout: loadedPreferences } = await execFileAsync("node", [
    "--input-type=module",
    "-e",
    "import { loadWorkbenchPreferences } from '@agent-api/app-engine/core'; console.log(JSON.stringify(await loadWorkbenchPreferences()));",
  ], { cwd: new URL("..", import.meta.url).pathname, env });
  assert.deepEqual(JSON.parse(loadedPreferences), appConfig.workbench);

  await execFileAsync("node", [bin, "auth", "login", "--profile", "test", "--api-key", "sk-test-updated-abcdefghijklmnopqrstuvwxyz", "--base-url", "https://api.test"], { env });
  const afterProfileSave = JSON.parse(await readFile(profilesPath, "utf8"));
  assert.equal(afterProfileSave.workbench, undefined);
  assert.equal(afterProfileSave.conversations, undefined);
});

test("legacy agent-api-cli config merges into agent-tui config and removes old dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-legacy-config-"));
  const env = isolatedEnv(root);
  const legacyConfigDir = testConfigDir(root, "agent-api-cli");
  const configDir = testConfigDir(root);
  await mkdir(legacyConfigDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(legacyConfigDir, "profiles.json"), JSON.stringify({
    activeProfile: "legacy",
    profiles: {
      legacy: {
        name: "legacy",
        baseURL: "https://legacy.test",
        auth: { type: "api_key", apiKey: "sk-legacy" },
        createdAt: 1,
        updatedAt: 1,
      },
    },
    workbench: { defaultPreset: "legacy-preset" },
    conversations: {
      "legacy:old": {
        name: "old",
        profile: "legacy",
        previousResponseId: "resp_old",
        updatedAt: 2,
      },
    },
  }, null, 2));
  await writeFile(join(configDir, "profiles.json"), JSON.stringify({
    activeProfile: "new",
    profiles: {
      new: {
        name: "new",
        baseURL: "https://new.test",
        auth: { type: "api_key", apiKey: "sk-new" },
        createdAt: 3,
        updatedAt: 3,
      },
    },
  }, null, 2));

  await execFileAsync("node", [
    "--input-type=module",
    "-e",
    "import { loadConfig } from '@agent-api/app-engine/core'; console.log(JSON.stringify(await loadConfig()));",
  ], { cwd: new URL("..", import.meta.url).pathname, env });

  const migratedProfiles = JSON.parse(await readFile(join(configDir, "profiles.json"), "utf8"));
  const migratedAppConfig = JSON.parse(await readFile(join(configDir, "configuration.json"), "utf8"));
  const migratedConversations = JSON.parse(await readFile(join(configDir, "conversations.json"), "utf8"));
  assert.equal(migratedProfiles.activeProfile, "new");
  assert.deepEqual(Object.keys(migratedProfiles.profiles).sort(), ["legacy", "new"]);
  assert.deepEqual(migratedAppConfig, { workbench: { defaultPreset: "legacy-preset" } });
  assert.deepEqual(Object.keys(migratedConversations.conversations), ["legacy:old"]);
  await assert.rejects(() => stat(legacyConfigDir), /ENOENT/);
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

test("workbench auth gate controller handles selection and API key login", async () => {
  const calls = [];
  const controller = createWorkbenchAuthGateController({
    authController: {
      async check() {
        return { profileName: "default", refreshed: false };
      },
      async loginAPIKey(input) {
        calls.push(["api", input.profile, input.baseURL, input.apiKey]);
        return { profileName: input.profile };
      },
      async loginBrowser() {
        throw new Error("not used");
      },
      async deleteProfile() {},
      async statusText() {
        return "";
      },
      async refresh() {
        return { refreshed: false };
      },
    },
  });

  let state = controller.initialState({ profile: "dev", baseURL: "https://api.test" });
  assert.equal(state.status, "checking");
  state = controller.requestLogin(state, "dev");
  assert.equal(state.status, "select");
  state = controller.handleInput("", { downArrow: true }, state).state;
  assert.equal(state.selectedMethod, 1);
  state = controller.handleInput("", { return: true }, state).state;
  assert.equal(state.status, "api_profile");
  state = (await controller.submit(state)).state;
  assert.equal(state.status, "api_base_url");
  state = (await controller.submit(state)).state;
  assert.equal(state.status, "api_key");
  state = controller.handleInput("s", {}, state).state;
  state = controller.handleInput("k", {}, state).state;
  const result = await controller.submit(state);

  assert.equal(result.profileName, "dev");
  assert.equal(result.state.status, "ready");
  assert.deepEqual(calls, [["api", "dev", "https://api.test", "sk"]]);
});

test("workbench auth gate controller reports browser challenge states", async () => {
  const controller = createWorkbenchAuthGateController({
    authController: {
      async check() {
        return { profileName: "default", refreshed: false };
      },
      async loginAPIKey() {
        throw new Error("not used");
      },
      async loginBrowser(input) {
        input.onChallenge?.({ url: "https://login.test", code: "ABCD-1234" });
        input.onStatus?.("approved");
        return { profileName: input.profile };
      },
      async deleteProfile() {},
      async statusText() {
        return "";
      },
      async refresh() {
        return { refreshed: false };
      },
    },
  });
  const states = [];
  let state = controller.requestLogin(controller.initialState({ profile: "dev", baseURL: "https://api.test" }), "dev");
  state = controller.handleInput("", { return: true }, state).state;
  assert.equal(state.status, "browser_profile");
  state = (await controller.submit(state)).state;
  assert.equal(state.status, "browser_base_url");
  const result = await controller.submit(state, { onState: (next) => states.push(next) });

  assert.equal(result.profileName, "dev");
  assert.equal(result.state.status, "ready");
  assert.equal(states[0].status, "browser_waiting");
  assert.equal(states[1].browserURL, "https://login.test");
  assert.equal(states[2].message, "Browser auth status: approved");
});

test("run workdir option must exist before launching TUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-missing-workdir-"));
  const missing = join(root, "missing");

  await assert.rejects(
    execFileAsync("node", [bin, "--workdir", missing]),
    (error) => {
      assert.match(error.stderr, /Workdir does not exist/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync("node", [bin, "run", "--workdir", missing]),
    (error) => {
      assert.match(error.stderr, /Workdir does not exist/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync("node", [bin, "run", missing]),
    (error) => {
      assert.match(error.stderr, /Workdir does not exist/);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync("node", [bin, "run", missing, "--workdir", missing]),
    (error) => {
      assert.match(error.stderr, /Use either run \[workdir\] or -w\/--workdir, not both/);
      return true;
    },
  );
});

test("root command grammar uses explicit run and update commands", async () => {
  const { stdout } = await execFileAsync("node", [bin, "--help"]);
  assert.match(stdout, /-w, --workdir <path>\s+shortcut for run with a local workdir/);
  assert.match(stdout, /--update\s+check for and install a CLI update/);
  assert.match(stdout, /^\s+run \[workdir\]\s+Open the interactive workbench/m);
  assert.match(stdout, /^\s+update\s+Check for and install a CLI update/m);
  assert.match(stdout, /^\s+version\s+Print the CLI version/m);
  assert.match(stdout, /^\s+help \[command\]\s+Display help for command/m);
  assert.match(stdout, /No command defaults to "run"\. A bare first argument is always a command\./);
  assert.match(stdout, /\$ agent-tui run \./);

  await assert.rejects(
    execFileAsync("node", [bin, "missing-workdir-name"]),
    (error) => {
      assert.match(error.stderr, /too many arguments/);
      return true;
    },
  );
});

test("version command mirrors version option", async () => {
  const { stdout: commandOut } = await execFileAsync("node", [bin, "version"]);
  const { stdout: optionOut } = await execFileAsync("node", [bin, "--version"]);
  assert.equal(commandOut, optionOut);
});

test("engine host command speaks newline-delimited Agent Engine Protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-engine-host-"));
  const env = isolatedEnv(root);
  const child = spawn("node", [bin, "engine", "host", "--access", "off"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const nextLine = lineReader(child.stdout);
  const hello = JSON.parse(await nextLine());
  assert.deepEqual(hello, { type: "hello", protocolVersion: 1 });

  child.stdin.write(`${JSON.stringify({ id: 1, method: "snapshot", params: {} })}\n`);
  const response = JSON.parse(await nextLine());
  assert.equal(response.id, 1);
  assert.equal(response.ok, true);
  assert.equal(response.result.currentConversation, "default");

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
});

test("run and update command help describe their shortcuts", async () => {
  const { stdout: runHelp } = await execFileAsync("node", [bin, "run", "--help"]);
  assert.match(runHelp, /Usage: agent-api run \[options\] \[workdir\]/);
  assert.match(runHelp, /\$ agent-tui -w \./);

  const { stdout: updateHelp } = await execFileAsync("node", [bin, "update", "--help"]);
  assert.match(updateHelp, /Equivalent shortcut: agent-tui --update/);
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
  assert.deepEqual(parseWorkbenchCommand("/rename release notes"), { kind: "rename_conversation", name: "release notes" });
  assert.deepEqual(parseWorkbenchCommand("/rename"), { kind: "rename_conversation", name: undefined });
  assert.deepEqual(parseWorkbenchCommand("/delete release"), { kind: "delete_conversation", name: "release" });
  assert.deepEqual(parseWorkbenchCommand("/delete"), { kind: "delete_conversation", name: undefined });
  assert.deepEqual(parseWorkbenchCommand("/conversation"), { kind: "list_conversations" });
  assert.deepEqual(parseWorkbenchCommand("/conversations"), { kind: "list_conversations" });
  assert.deepEqual(parseWorkbenchCommand("/conversations release"), { kind: "list_conversations", query: "release" });
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
  assert.deepEqual(parseWorkbenchCommand("/config continuation-limit 12"), { kind: "config", field: "continuation-limit", value: "12" });
  assert.deepEqual(parseWorkbenchCommand("/config automatic-continuation-limit unlimited"), { kind: "config", field: "continuation-limit", value: "unlimited" });
  assert.deepEqual(parseWorkbenchCommand("/config isolation required"), { kind: "config", field: "isolation", value: "required" });
  assert.deepEqual(parseWorkbenchCommand("/config isolator /opt/agent-isolator"), { kind: "config", field: "isolator", value: "/opt/agent-isolator" });
  assert.deepEqual(parseWorkbenchCommand("/config nope"), { kind: "invalid", command: "config nope" });
  assert.deepEqual(parseWorkbenchCommand("/render"), { kind: "render" });
  assert.deepEqual(parseWorkbenchCommand("/render raw"), { kind: "render", mode: "raw" });
  assert.deepEqual(parseWorkbenchCommand("/render markdown"), { kind: "render", mode: "markdown" });
  assert.deepEqual(parseWorkbenchCommand("/transcript"), { kind: "transcript" });
  assert.deepEqual(parseWorkbenchCommand("/copy"), { kind: "copy", target: "page" });
  assert.deepEqual(parseWorkbenchCommand("/copy page"), { kind: "copy", target: "page" });
  assert.deepEqual(parseWorkbenchCommand("/copy visible"), { kind: "copy", target: "page" });
  assert.deepEqual(parseWorkbenchCommand("/copy transcript"), { kind: "copy", target: "transcript" });
  assert.deepEqual(parseWorkbenchCommand("/copy all"), { kind: "copy", target: "transcript" });
  assert.deepEqual(parseWorkbenchCommand("/copy header"), { kind: "copy", target: "header" });
  assert.deepEqual(parseWorkbenchCommand("/copy conversation"), { kind: "copy", target: "conversation" });
  assert.deepEqual(parseWorkbenchCommand("/copy workdir"), { kind: "copy", target: "workdir" });
  assert.deepEqual(parseWorkbenchCommand("/copy workspace"), { kind: "copy", target: "workspace" });
  assert.deepEqual(parseWorkbenchCommand("/copy activity"), { kind: "copy", target: "activity" });
  assert.deepEqual(parseWorkbenchCommand("/copy activities"), { kind: "copy", target: "activity" });
  assert.deepEqual(parseWorkbenchCommand("/copy sidebar"), { kind: "invalid", command: "copy sidebar" });
  assert.deepEqual(parseWorkbenchCommand("/export"), { kind: "export", path: undefined });
  assert.deepEqual(parseWorkbenchCommand("/export ./notes/transcript.txt"), { kind: "export", path: "./notes/transcript.txt" });
  assert.deepEqual(parseWorkbenchCommand("/access"), { kind: "access" });
  assert.deepEqual(parseWorkbenchCommand("/access off"), { kind: "access", mode: "off" });
  assert.deepEqual(parseWorkbenchCommand("/access full"), { kind: "access", mode: "full" });
  assert.deepEqual(parseWorkbenchCommand("/access approval"), { kind: "access", mode: "approval" });
  assert.deepEqual(parseWorkbenchCommand("/preset pro-search"), { kind: "preset", value: "pro-search" });
  assert.deepEqual(parseWorkbenchCommand("/model auto"), { kind: "model", value: "auto" });
  assert.deepEqual(parseWorkbenchCommand("/continuation-limit unlimited"), { kind: "continuation_limit", value: "unlimited" });
  assert.deepEqual(parseWorkbenchCommand("/memory"), { kind: "memory", enabled: undefined });
  assert.deepEqual(parseWorkbenchCommand("/memory on"), { kind: "invalid", command: "memory on" });
  assert.deepEqual(parseWorkbenchCommand("/memory off"), { kind: "memory", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/memory read off"), { kind: "memory", field: "read", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/memory read workspace"), { kind: "memory", field: "workspace", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/memory read workspace off"), { kind: "memory", field: "workspace", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/memory write on"), { kind: "memory", field: "write", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/memory workspace on"), { kind: "invalid", command: "memory workspace" });
  assert.deepEqual(parseWorkbenchCommand("/skills"), { kind: "skills", enabled: undefined });
  assert.deepEqual(parseWorkbenchCommand("/skills local off"), { kind: "skills", field: "local", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/skills workspace on"), { kind: "skills", field: "workspace", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/local-skills off"), { kind: "skills", field: "local", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/workspace-skills on"), { kind: "skills", field: "workspace", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/workdir"), { kind: "workdir", enabled: undefined });
  assert.deepEqual(parseWorkbenchCommand("/workdir on"), { kind: "workdir", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/workdir off"), { kind: "workdir", enabled: false });
  assert.deepEqual(parseWorkbenchCommand("/local on"), { kind: "workdir", enabled: true });
  assert.deepEqual(parseWorkbenchCommand("/update"), { kind: "update" });
  assert.deepEqual(parseWorkbenchCommand("/upgrade"), { kind: "update" });
  assert.deepEqual(parseWorkbenchCommand("/resume"), { kind: "resume", message: undefined });
  assert.deepEqual(parseWorkbenchCommand("/resume rollout is probably ready"), { kind: "resume", message: "rollout is probably ready" });
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
      automaticContinuationLimit: 12,
      renderMode: "raw",
      runModel: "provider/model",
      runPreset: "code-agent",
      memoryRead: true,
      localSkillsEnabled: false,
      workspaceSkillsEnabled: true,
    },
  });
  assert.equal(withSettings.defaultPreset, "pro-search");
  assert.equal(withSettings.automaticContinuationLimit, 12);
  assert.equal(withSettings.renderMode, "raw");
  assert.equal(withSettings.runModel, "provider/model");
  assert.equal(withSettings.runPreset, "code-agent");
  assert.equal(withSettings.memoryRead, true);
  assert.equal(withSettings.localSkillsEnabled, false);
  assert.equal(withSettings.workspaceSkillsEnabled, true);

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
  const pendingContinuation = workbenchReducer(clearedLocalTool, {
    type: "automatic_continuation.pending.set",
    pause: {
      reason: "automatic_continuation_limit",
      message: "Automatic workflow paused.",
      continuation: {
        input: [{ type: "function_call_output", call_id: "call_local", output: "ok" }],
        previousResponseID: "resp_local",
        automaticContinuationCount: 8,
      },
      count: 8,
      limit: 8,
      responseID: "resp_local",
    },
  });
  assert.equal(pendingContinuation.pendingAutomaticContinuation?.reason, "automatic_continuation_limit");
  assert.equal(pendingContinuation.pendingAutomaticContinuation?.count, 8);
  const clearedContinuation = workbenchReducer(pendingContinuation, { type: "automatic_continuation.pending.clear" });
  assert.equal(clearedContinuation.pendingAutomaticContinuation, null);
  const pendingUpdate = workbenchReducer(clearedContinuation, {
    type: "update.pending.set",
    result: {
      current: "0.4.10",
      latest: "0.4.11",
      packageName: "@agent-api/cli",
      updateAvailable: true,
    },
  });
  assert.equal(pendingUpdate.pendingUpdate?.result.latest, "0.4.11");
  assert.equal(pendingUpdate.activities.at(-1).level, "warning");
  const clearedUpdate = workbenchReducer(pendingUpdate, { type: "update.pending.clear" });
  assert.equal(clearedUpdate.pendingUpdate, null);

  const withWorkdir = workbenchReducer(clearedUpdate, {
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
  assert.equal(defaultOptions.conversation, "default");
  assert.equal(defaultOptions.conversationExplicit, false);
  assert.equal(defaultOptions.automaticContinuationLimit, undefined);
  assert.equal(normalizeChatOptions(["hi"], { automaticContinuationLimit: "12" }).automaticContinuationLimit, 12);
  assert.equal(
    normalizeChatOptions(["hi"], { automaticContinuationLimit: "unlimited" }).automaticContinuationLimit,
    Number.MAX_SAFE_INTEGER,
  );

  const presetOptions = normalizeChatOptions(["hi"], { preset: "code-agent" });
  assert.equal(presetOptions.preset, "code-agent");
  assert.equal(presetOptions.presetExplicit, true);

  const modelOptions = normalizeChatOptions(["hi"], { model: "provider/model" });
  assert.equal(modelOptions.preset, undefined);
  assert.equal(modelOptions.model, "provider/model");
  assert.equal(modelOptions.modelExplicit, true);

  const conversationOptions = normalizeChatOptions(["hi"], { conversation: "release" });
  assert.equal(conversationOptions.conversation, "release");
  assert.equal(conversationOptions.conversationExplicit, true);
});

test("chat options expose local skills, memory, and workspace skill scopes", () => {
  const options = normalizeChatOptions(["hi"], {
    workdir: ".",
    localSkill: ["./skills/release", "./skills/review"],
    localSkills: false,
    memoryRead: true,
    memoryTenantSearch: true,
    workspaceSkills: true,
  });

  assert.deepEqual(options.localSkillPaths, ["./skills/release", "./skills/review"]);
  assert.equal(options.discoverLocalSkills, false);
  assert.deepEqual(options.memory, {
    read: true,
    tenant_search: true,
  });
  assert.deepEqual(options.skillTool, { tenant_search: true });

  assert.equal(normalizeChatOptions(["hi"], {}).memory, undefined);
  assert.deepEqual(normalizeChatOptions(["hi"], { memory: true }).memory, { read: true });
  assert.deepEqual(normalizeChatOptions(["hi"], { memoryWrite: true }).memory, {
    write: true,
  });
  assert.deepEqual(normalizeChatOptions(["hi"], { memoryTenantSearch: true }).memory, {
    read: true,
    tenant_search: true,
  });
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

test("local tool execution errors are encoded as tool results", () => {
  const error = new Error("ENOENT: no such file or directory, scandir 'missing'");
  error.code = "ENOENT";

  assert.deepEqual(localToolExecutionErrorResult("local_workdir", { action: "grep", path: "missing" }, error), {
    ok: false,
    tool: "local_workdir",
    action: "grep",
    error: {
      message: "ENOENT: no such file or directory, scandir 'missing'",
      name: "Error",
      code: "ENOENT",
    },
  });
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

test("local shell isolation leaves isolator path explicit", () => {
  const previousPath = process.env.AGENT_ISOLATOR_PATH;
  delete process.env.AGENT_ISOLATOR_PATH;
  try {
    assert.deepEqual(localShellIsolationOptions(), {
      isolation: "auto",
      isolationOptions: {
        filesystem: "workdir-readwrite",
        network: "allowed",
        env: "inherit",
      },
    });

    process.env.AGENT_ISOLATOR_PATH = "/opt/agent-isolator";
    assert.deepEqual(localShellIsolationOptions(), {
      isolation: "auto",
      isolationOptions: {
        filesystem: "workdir-readwrite",
        network: "allowed",
        env: "inherit",
      },
      isolator: { executablePath: "/opt/agent-isolator" },
    });
  } finally {
    if (previousPath == null) {
      delete process.env.AGENT_ISOLATOR_PATH;
    } else {
      process.env.AGENT_ISOLATOR_PATH = previousPath;
    }
  }
});

test("isolator installer installs atomically after download and probe", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "agent-tui-isolator-install-"));
  const target = join(root, "bin", "agent-isolator");
  const script = [
    "#!/bin/sh",
    "cat >/dev/null",
    "printf '%s\\n' '{\"id\":\"status\",\"result\":{\"driver\":\"fake\",\"status\":{\"executor\":\"isolator\",\"driver\":\"fake\",\"isolated\":true,\"fallback\":false,\"requested\":{\"filesystem\":\"host\",\"network\":\"allowed\",\"env\":\"inherit\",\"resources\":{}},\"guarantees\":{\"filesystem\":\"policy-enforced\",\"network\":\"allowed\",\"user\":\"namespace-user\",\"process\":\"pid-namespace\",\"resources\":\"timeout-only\"},\"warnings\":[]}}}'",
  ].join("\n");
  const body = Buffer.from(`${script}\n`);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const result = await installConfiguredIsolator({
    sourceURL: "https://example.test/agent-isolator",
    executablePath: target,
    sha256,
  }, {
    fetchImpl: async () => new Response(body),
  });

  assert.equal(result.executablePath, target);
  assert.equal(result.sha256, sha256);
  assert.equal(await readFile(target, "utf8"), `${script}\n`);
});

test("isolator installer leaves existing binary intact on failed refresh", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "agent-tui-isolator-install-fail-"));
  const target = join(root, "bin", "agent-isolator");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(target, "existing-binary");
  await chmod(target, 0o700);

  await assert.rejects(
    () => installConfiguredIsolator({
      sourceURL: "https://example.test/agent-isolator",
      executablePath: target,
      sha256: "0".repeat(64),
    }, {
      fetchImpl: async () => new Response("new-binary"),
    }),
    /checksum mismatch/,
  );

  assert.equal(await readFile(target, "utf8"), "existing-binary");
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

test("update helper formats explicit local install plans", () => {
  const result = {
    current: "0.1.0",
    latest: "0.1.1",
    packageName: "@agent-api/cli",
    updateAvailable: true,
  };
  const plan = localUpdateInstallPlan(result, "/tmp/agent-project");
  assert.equal(plan.scope, "local");
  assert.equal(plan.cwd, "/tmp/agent-project");
  assert.deepEqual(plan.args, ["install", "@agent-api/cli@latest"]);
  assert.equal(
    formatUpdateNotice(result, { installPlan: plan }),
    "Update available: @agent-api/cli 0.1.0 -> 0.1.1. Run: npm install @agent-api/cli@latest --prefix /tmp/agent-project",
  );
});

test("update helper honors env timeout override", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = process.env.AGENT_TUI_UPDATE_TIMEOUT_MS;
  process.env.AGENT_TUI_UPDATE_TIMEOUT_MS = "1";
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  try {
    const result = await checkForUpdate({ currentVersion: "0.1.0", packageName: "@agent-api/cli" });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.AGENT_TUI_UPDATE_TIMEOUT_MS;
    else process.env.AGENT_TUI_UPDATE_TIMEOUT_MS = originalTimeout;
  }
});

test("workbench lifecycle controller emits update notice once", async () => {
  const controller = createWorkbenchLifecycleController({
    authController: {
      async check() { return { profileName: "default", refreshed: false }; },
      async loginAPIKey() { return { profileName: "default" }; },
      async loginBrowser() { return { profileName: "default" }; },
      async deleteProfile() {},
      async statusText() { return ""; },
      async refresh() { return { refreshed: false }; },
    },
    async checkForUpdateImpl() {
      return {
        current: "0.1.0",
        latest: "0.1.1",
        packageName: "@agent-api/cli",
        updateAvailable: true,
      };
    },
  });

  const effects = await controller.maybeCheckForUpdate();
  assert.deepEqual(effects.map((effect) => effect.type), ["dispatch", "dispatch"]);
  assert.match(effects[0].type === "dispatch" ? effects[0].action.text : "", /Update available: 0.1.1/);
  assert.deepEqual(await controller.maybeCheckForUpdate(), []);
});

test("workbench lifecycle controller maps auth refresh and failure", async () => {
  let mode = "refreshed";
  const controller = createWorkbenchLifecycleController({
    authController: {
      async check() { return { profileName: "default", refreshed: false }; },
      async loginAPIKey() { return { profileName: "default" }; },
      async loginBrowser() { return { profileName: "default" }; },
      async deleteProfile() {},
      async statusText() { return ""; },
      async refresh() {
        if (mode === "fail") throw new Error("invalid refresh token");
        return { refreshed: mode === "refreshed" };
      },
    },
    refreshWindowMs: 123,
  });

  assert.deepEqual(await controller.refreshAuth("dev"), [
    { type: "dispatch", action: { type: "activity.add", level: "success", text: "Auth session refreshed" } },
  ]);
  mode = "unchanged";
  assert.deepEqual(await controller.refreshAuth("dev"), []);
  mode = "fail";
  const failed = await controller.refreshAuth("dev");
  assert.deepEqual(failed.map((effect) => effect.type), ["dispatch", "dispatch", "close"]);
  assert.match(failed[0].type === "dispatch" ? failed[0].action.text : "", /invalid refresh token/);
  assert.deepEqual(await controller.refreshAuth("dev"), []);
});

test("workbench lifecycle controller starts initial prompt immediately unless workdir is required", () => {
  const controller = createWorkbenchLifecycleController({
    authController: {
      async check() { return { profileName: "default", refreshed: false }; },
      async loginAPIKey() { return { profileName: "default" }; },
      async loginBrowser() { return { profileName: "default" }; },
      async deleteProfile() {},
      async statusText() { return ""; },
      async refresh() { return { refreshed: false }; },
    },
  });
  const workdir = { root: "/tmp/example", name: "example", fileCount: 1, totalBytes: 1, scanTruncated: false };

  assert.equal(controller.initialPrompt({ busy: false, promptParts: ["hello", "agent"], workdir: null }), "hello agent");
  assert.equal(controller.initialPrompt({ busy: false, promptParts: ["again"], workdir }), undefined);
});

test("workbench lifecycle controller waits for workdir when local tools are enabled", () => {
  const controller = createWorkbenchLifecycleController({
    authController: {
      async check() { return { profileName: "default", refreshed: false }; },
      async loginAPIKey() { return { profileName: "default" }; },
      async loginBrowser() { return { profileName: "default" }; },
      async deleteProfile() {},
      async statusText() { return ""; },
      async refresh() { return { refreshed: false }; },
    },
  });
  const workdir = { root: "/tmp/example", name: "example", fileCount: 1, totalBytes: 1, scanTruncated: false };

  assert.equal(controller.initialPrompt({ busy: false, promptParts: ["hello", "agent"], requiresWorkdir: true, workdir: null }), undefined);
  assert.equal(controller.initialPrompt({ busy: true, promptParts: ["hello", "agent"], workdir }), undefined);
  assert.equal(controller.initialPrompt({ busy: false, promptParts: ["hello", "agent"], requiresWorkdir: true, workdir }), "hello agent");
  assert.equal(controller.initialPrompt({ busy: false, promptParts: ["again"], workdir }), undefined);
});

test("workbench lifecycle update notice helper ignores unavailable updates", () => {
  assert.deepEqual(updateNoticeEffects(null), []);
  assert.deepEqual(updateNoticeEffects({
    current: "0.1.0",
    latest: "0.1.0",
    packageName: "@agent-api/cli",
    updateAvailable: false,
  }), []);
});

test("workbench session constructs shared engine and controllers", () => {
  const injectedConversation = stubConversationController();
  const injectedLocal = stubLocalController();
  const injectedSettings = stubSettingsController();
  const session = createWorkbenchSession({
    authController: {
      async check() { return { profileName: "default", refreshed: false }; },
      async loginAPIKey() { return { profileName: "default" }; },
      async loginBrowser() { return { profileName: "default" }; },
      async deleteProfile() {},
      async statusText() { return ""; },
      async refresh() { return { refreshed: false }; },
    },
    baseOptions: {
      accessMode: "approval",
      conversation: "demo",
      includeLocalContext: true,
      promptParts: [],
    },
    services: {
      conversation: injectedConversation,
      local: injectedLocal,
      settings: injectedSettings,
    },
  });

  assert.equal(sessionState(session).currentConversation, "demo");
  assert.equal(sessionState(session).contextEnabled, true);
  session.engine.dispatch({ type: "message.add", role: "user", text: "hello" });
  assert.equal(sessionState(session).messages.at(-1).text, "hello");
  assert.equal(typeof session.lifecycle.initialPrompt, "function");
  assert.equal(session.conversation, injectedConversation);
  assert.equal(session.local, injectedLocal);
  assert.equal(session.settings, injectedSettings);
  assert.equal(typeof session.runtime.runEffects, "function");
  assert.equal(typeof session.turn.startPrompt, "function");
});

test("workbench runtime controller buffers and flushes text deltas", () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  const runtime = createWorkbenchRuntimeController({ dispatch: engine.dispatch, flushDelayMs: 1000 });

  runtime.runEffects([
    { type: "append_text_delta", delta: "hel" },
    { type: "append_text_delta", delta: "lo" },
  ], "assistant-test");
  assert.equal(engine.snapshot().messages.at(-1).text, "hel");

  runtime.flushTextDeltaBuffer();
  assert.equal(engine.snapshot().messages.at(-1).text, "hello");
  runtime.dispose();
});

test("workbench command controller applies renderer-neutral preset commands", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  const runSettingsUpdates = [];
  engine.dispatch({ type: "conversation.set", id: "conv_default", name: "default", status: "fresh" });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: {
      ...stubConversationController(),
      async updateRunSettings(name, runSettings, profile, workspaceId) {
        runSettingsUpdates.push({ name, runSettings, profile, workspaceId });
      },
    },
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: {
      async loadInitial() { return {}; },
      async saveDefaultPreset() { throw new Error("not used"); },
      async saveAutomaticContinuationLimit() { throw new Error("not used"); },
      async saveShellIsolationMode() { throw new Error("not used"); },
      async saveIsolatorPath() { throw new Error("not used"); },
      async saveIsolatorSource() { throw new Error("not used"); },
      async validatePreset(_profile, preset) { return preset === "analysis"; },
      async presetListText(input) { return `${input.prefix}\n- analysis`; },
      configText() { return "config"; },
      defaultPresetHelp() { return "default preset help"; },
      automaticContinuationLimitHelp() { return "automatic continuation limit help"; },
      shellIsolationHelp() { return "shell isolation help"; },
      isolatorPathHelp() { return "isolator path help"; },
      clearPresetToolCatalogCache() {},
    },
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "preset", value: "analysis" });
  assert.equal(engine.snapshot().runPreset, "analysis");
  assert.match(engine.snapshot().messages.at(-1).text, /Preset set to analysis/);
  assert.equal(runSettingsUpdates.at(-1).name, "default");
  assert.equal(runSettingsUpdates.at(-1).profile, "default");
  assert.equal(runSettingsUpdates.at(-1).runSettings.preset, "analysis");

  await controller.run({ kind: "preset", value: "missing" });
  assert.equal(engine.snapshot().runPreset, "analysis");
  assert.match(engine.snapshot().messages.at(-1).text, /Unknown preset: missing/);
});

test("workbench command controller deletes conversations and local transcripts", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, conversation: "release" });
  const deleted = [];
  const cleared = [];
  engine.dispatch({ type: "conversation.set", id: "conv_release", name: "release", status: "continued", previousResponseId: "resp_release" });
  engine.dispatch({
    type: "conversations.set",
    conversations: [
      {
        id: "conv_release",
        latestSnippet: "Release notes",
        messageCount: 3,
        name: "release",
        previousResponseId: "resp_release",
        status: "continued",
        titleSnippet: "Release notes",
      },
    ],
  });
  engine.dispatch({ type: "message.add", role: "assistant", text: "old transcript" });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: {
      ...stubConversationController(),
      async deleteConversation(name, profile) {
        deleted.push([name, profile]);
        return { name, message: `Deleted conversation "${name}".` };
      },
      async startNewConversation(name, profile) {
        return { id: "conv_default", name, profile, status: "fresh", message: "Started default." };
      },
    },
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "dev" },
    profileName: "dev",
    settingsController: stubSettingsController(),
    transcriptStore: {
      async appendMessage() {},
      async appendMessageDelta() {},
      async clearConversation(id) { cleared.push(id); },
      async exportConversation() { return ""; },
      async getConversationSummary() { return { latestSnippet: "", messageCount: 0, titleSnippet: "" }; },
      async loadAfterMessages() { return []; },
      async loadBeforeMessages() { return []; },
      async loadRecentMessages() { return []; },
    },
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "delete_conversation", name: "release" });

  assert.deepEqual(deleted, [["release", "dev"]]);
  assert.deepEqual(cleared, ["conv_release", "conv_default"]);
  assert.equal(engine.snapshot().currentConversation, "default");
  assert.equal(engine.snapshot().conversationId, "conv_default");
  assert.equal(engine.snapshot().conversationStatus, "fresh");
  assert.equal(engine.snapshot().messages.some((message) => message.text === "old transcript"), false);
  assert.match(engine.snapshot().messages.at(-1).text, /Deleted conversation "release"/);
});

test("workbench command controller renames the active conversation", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, conversation: "release" });
  const renamed = [];
  engine.dispatch({ type: "conversation.set", id: "conv_release", name: "release", status: "continued", previousResponseId: "resp_release" });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: {
      ...stubConversationController(),
      async renameConversation(name, nextName, profile) {
        renamed.push([name, nextName, profile]);
        return {
          id: "conv_release",
          name: nextName,
          previousResponseId: "resp_release",
          status: "continued",
          message: `Renamed conversation "${name}" to "${nextName}".`,
        };
      },
    },
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "dev" },
    profileName: "dev",
    settingsController: stubSettingsController(),
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "rename_conversation", name: "release notes" });

  assert.deepEqual(renamed, [["release", "release notes", "dev"]]);
  assert.equal(engine.snapshot().currentConversation, "release notes");
  assert.equal(engine.snapshot().conversationId, "conv_release");
  assert.equal(engine.snapshot().conversationPreviousResponseId, "resp_release");
  assert.match(engine.snapshot().messages.at(-1).text, /Renamed conversation "release" to "release notes"/);
});

test("workbench command controller saves automatic continuation limit", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: {
      ...stubSettingsController(),
      async saveAutomaticContinuationLimit(value) {
        assert.equal(value, "14");
        return {
          automaticContinuationLimit: 14,
          message: "Saved automatic continuation limit: 14.",
          activity: "Automatic continuation limit saved: 14",
        };
      },
    },
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "config", field: "continuation-limit", value: "14" });

  assert.equal(engine.snapshot().defaultAutomaticContinuationLimit, 14);
  assert.equal(engine.snapshot().automaticContinuationLimit, undefined);
  assert.match(engine.snapshot().messages.at(-1).text, /Saved automatic continuation limit: 14/);

  engine.dispatch({ type: "conversation.set", id: "conv_default", name: "default", status: "fresh" });
  await controller.run({ kind: "continuation_limit", value: "9" });
  assert.equal(engine.snapshot().automaticContinuationLimit, 9);
  assert.match(engine.snapshot().messages.at(-1).text, /Conversation continuation limit set to 9/);
});

test("workbench command controller resumes timed local pauses", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  const resumeMessages = [];
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: stubSettingsController(),
    turnController: {
      ...stubTurnController(),
      resumeTimedPause(message) {
        resumeMessages.push(message);
        return true;
      },
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "resume", message: "rollout ready" });

  assert.deepEqual(resumeMessages, ["rollout ready"]);
  assert.match(engine.snapshot().messages.at(-1).text, /Resuming timed local pause/);
});

test("workbench command controller reports when no timed local pause is active", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: stubSettingsController(),
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "resume" });

  assert.match(engine.snapshot().messages.at(-1).text, /No timed local pause is active/);
});

test("workbench turn controller applies sticky automatic continuation limit", async () => {
  const engine = createWorkbenchEngine({ accessMode: "full", contextEnabled: true });
  engine.dispatch({ type: "settings.set", settings: { automaticContinuationLimit: 13 } });
  const seenOptions = [];
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {},
    getState: engine.snapshot,
    runRuntimeEffects() {},
    async runAgentTurnImpl(options) {
      seenOptions.push(options);
      return { text: "done", responseID: "resp_done" };
    },
  });

  await controller.startPrompt("hello");

  assert.equal(seenOptions[0].automaticContinuationLimit, 13);
});

test("workbench command controller applies pending local approvals", async () => {
  const continuations = [];
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "approval" });
  engine.dispatch({
    type: "run.started",
    run: {
      id: "run_local",
      assistantMessageId: "assistant_local",
      conversationName: "default",
    },
  });
  engine.dispatch({
    type: "local_tool.pending.set",
    runId: "run_local",
    approval: {
      name: "local_shell",
      action: "run",
      arguments: { command: "pwd" },
      callID: "call_1",
      responseID: "resp_1",
    },
  });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: {
      ...stubLocalController(),
      isLoaded() { return true; },
      async applyApproval(approval) {
        return { ok: true, command: approval.arguments.command };
      },
    },
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: stubSettingsController(),
    turnController: {
      ...stubTurnController(),
      async continueAfterLocalApproval(input) {
        continuations.push(input);
      },
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "apply_all" });

  assert.equal(engine.snapshot().pendingLocalTool, null);
  assert.equal(engine.snapshot().accessMode, "full");
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0].accessMode, "full");
  assert.deepEqual(continuations[0].result, { ok: true, command: "pwd" });
  assert.equal(engine.snapshot().runs.find((run) => run.id === "run_local")?.status, "completed");
  assert.equal(engine.snapshot().runs.find((run) => run.id === "run_local")?.statusText, "local action applied");
});

test("workbench command controller scopes abort to the selected conversation run", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "approval" });
  let aborts = 0;
  engine.dispatch({ type: "conversation.set", id: "conv_a", name: "alpha", status: "fresh" });
  engine.dispatch({
    type: "run.started",
    run: {
      id: "run_alpha",
      assistantMessageId: "assistant_alpha",
      conversationId: "conv_a",
      conversationName: "alpha",
    },
  });
  engine.dispatch({ type: "conversation.set", id: "conv_b", name: "beta", status: "fresh" });
  const commandController = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: stubSettingsController(),
    turnController: {
      ...stubTurnController(),
      async abort() {
        aborts += 1;
      },
    },
    workspaceController: stubWorkspaceController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await commandController.run({ kind: "abort" });
  assert.equal(aborts, 0);
  assert.match(engine.snapshot().messages.at(-1).text, /No agent turn is running for the selected conversation/);

  engine.dispatch({ type: "conversation.set", id: "conv_a", name: "alpha", status: "fresh" });
  await commandController.run({ kind: "abort" });
  assert.equal(aborts, 1);
});

test("workbench command controller checks and applies CLI updates", async () => {
  const installed = [];
  let exited = false;
  const engine = createWorkbenchEngine({ contextEnabled: false, accessMode: "off" });
  const updateResult = {
    current: "0.4.10",
    latest: "0.4.11",
    packageName: "@agent-api/cli",
    updateAvailable: true,
  };
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: stubSettingsController(),
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async checkForUpdateImpl() {
      return updateResult;
    },
    async installUpdateImpl(result) {
      installed.push(result);
      return { command: "npm install -g @agent-api/cli@latest", output: "updated" };
    },
    async onDeleteProfile() {},
    onExit() { exited = true; },
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "update" });

  assert.equal(engine.snapshot().pendingUpdate?.result.latest, "0.4.11");
  assert.match(engine.snapshot().messages.at(-1).text, /Use \/apply/);

  await controller.run({ kind: "apply" });

  assert.equal(engine.snapshot().pendingUpdate, null);
  assert.deepEqual(installed, [updateResult]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(exited, true);
});

test("workbench command controller skips CLI update checkpoint when current", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, accessMode: "off" });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: stubSettingsController(),
    turnController: stubTurnController(),
    workspaceController: stubWorkspaceController(),
    async checkForUpdateImpl() {
      return {
        current: "0.4.10",
        latest: "0.4.10",
        packageName: "@agent-api/cli",
        updateAvailable: false,
      };
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "update" });

  assert.equal(engine.snapshot().pendingUpdate, null);
  assert.match(engine.snapshot().messages.at(-1).text, /already up to date/);
});

test("workbench render model exposes renderer-neutral screen state", () => {
  const state = createInitialWorkbenchState({
    accessMode: "full",
    contextEnabled: true,
    conversation: "demo",
    preset: "pro-search",
  });
  const model = buildWorkbenchRenderModel({
    cursor: 2,
    draft: "hello",
    profileName: "default",
    spinnerFrame: 5,
    state: {
      ...state,
      workdir: {
        root: "/tmp/demo",
        name: "demo",
        fileCount: 2,
        totalBytes: 42,
        scanTruncated: false,
      },
    },
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 120 },
    workdirFallback: "/fallback",
  });

  assert.equal(model.header.profile, "default");
  assert.equal(model.header.conversation, "demo");
  assert.equal(model.header.conversationId, "unresolved");
  assert.equal(model.header.conversationStatus, "unknown");
  assert.equal(model.header.conversationPreviousResponseId, "");
  assert.equal(model.header.workdir, "/tmp/demo");
  assert.equal(model.header.pendingLocalLabel, "none");
  assert.equal(model.input.fullAccess, true);
  assert.equal(model.input.draft, "hello");
  assert.equal(model.input.label, "You");
  assert.equal(model.input.statusText, "");
  assert.deepEqual(model.input.lines, [{
    beforeCursor: "he",
    cursorText: "l",
    afterCursor: "lo",
    end: 5,
    hasCursor: true,
    start: 0,
    spans: [
      { text: "he" },
      { text: "l", inverse: true },
      { text: "lo" },
    ],
    text: "hello",
  }]);
  assert.equal(model.layout, "wide");
  assert.equal(model.viewportHeight, 19);
  assert.ok(model.transcript.visibleLines.length > 0);
  assert.match(model.footerText, /live/);
});

test("workbench render model keeps input editable while busy", () => {
  let state = createInitialWorkbenchState({});
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_selected", name: "selected", status: "fresh" });
  state = workbenchReducer(state, {
    type: "run.started",
    run: {
      id: "run_selected",
      assistantMessageId: "assistant_selected",
      conversationId: "conv_selected",
      conversationName: "selected",
    },
  });
  const model = buildWorkbenchRenderModel({
    cursor: 4,
    draft: "/resume now",
    profileName: "default",
    spinnerFrame: 5,
    state,
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 80 },
    workdirFallback: "/fallback",
  });

  assert.equal(model.input.busy, true);
  assert.equal(model.input.label, "You");
  assert.match(model.input.statusText, /waiting for agent/);
  assert.equal(model.input.draft, "/resume now");
  assert.equal(model.input.lines[0].beforeCursor, "/res");
  assert.equal(model.input.lines[0].cursorText, "u");
});

test("workbench render model keeps input ready when another conversation is running", () => {
  let state = createInitialWorkbenchState({});
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_selected", name: "selected", status: "fresh" });
  state = workbenchReducer(state, {
    type: "run.started",
    run: {
      id: "run_other",
      assistantMessageId: "assistant_other",
      conversationId: "conv_other",
      conversationName: "other",
    },
  });
  const model = buildWorkbenchRenderModel({
    draft: "new task",
    profileName: "default",
    spinnerFrame: 5,
    state,
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 80 },
    workdirFallback: "/fallback",
  });

  assert.equal(state.busy, true);
  assert.equal(model.input.busy, false);
  assert.match(model.input.statusText, /1 other run active/);
});

test("workbench render model marks conversation run status", () => {
  let state = createInitialWorkbenchState({});
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_current", name: "current", status: "fresh" });
  state = workbenchReducer(state, {
    type: "conversations.set",
    conversations: [
      { id: "conv_current", latestSnippet: "Current work", messageCount: 1, name: "current", status: "fresh", titleSnippet: "Current work" },
      { id: "conv_other", latestSnippet: "Background work", messageCount: 3, name: "other", status: "continued", titleSnippet: "Background work" },
      { id: "conv_failed", latestSnippet: "Failed work", messageCount: 2, name: "failed", status: "continued", titleSnippet: "Failed work" },
    ],
  });
  state = workbenchReducer(state, {
    type: "run.started",
    run: { id: "run_other", assistantMessageId: "assistant_other", conversationId: "conv_other", conversationName: "other" },
  });
  state = workbenchReducer(state, {
    type: "run.started",
    run: { id: "run_failed", assistantMessageId: "assistant_failed", conversationId: "conv_failed", conversationName: "failed" },
  });
  state = workbenchReducer(state, { type: "run.status.set", runId: "run_failed", status: "failed", statusText: "boom" });
  const model = buildWorkbenchRenderModel({
    draft: "",
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 120 },
    workdirFallback: "/fallback",
  });

  assert.match(model.conversation.lines.join("\n"), /\s▶ other · Background work/);
  assert.match(model.conversation.lines.join("\n"), /\s! failed · Failed work/);
});

test("workbench render model shows selected conversation run in fallback panel", () => {
  let state = createInitialWorkbenchState({});
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_current", name: "current", status: "fresh" });
  state = workbenchReducer(state, {
    type: "run.started",
    run: { id: "run_current", assistantMessageId: "assistant_current", conversationId: "conv_current", conversationName: "current" },
  });
  state = workbenchReducer(state, { type: "run.response.set", runId: "run_current", responseId: "resp_current" });
  const model = buildWorkbenchRenderModel({
    draft: "",
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 120 },
    workdirFallback: "/fallback",
  });

  assert.match(model.conversation.lines.join("\n"), /run=running resp_current/);
});

test("workbench render model extracts panel-scoped copy text", () => {
  let state = createInitialWorkbenchState({});
  state = workbenchReducer(state, { type: "message.add", role: "assistant", text: "First transcript line\nSecond transcript line" });
  state = workbenchReducer(state, { type: "activity.add", level: "success", text: "Copied safely" });
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_current", name: "default", status: "fresh" });
  state = workbenchReducer(state, {
    type: "conversations.set",
    conversations: [
      { id: "conv_current", latestSnippet: "Current task", messageCount: 2, name: "default", status: "fresh", titleSnippet: "Current task" },
      { id: "conv_other", latestSnippet: "Fix transcript OOM", messageCount: 7, name: "oom", status: "continued", titleSnippet: "Fix transcript OOM" },
    ],
  });
  const model = buildWorkbenchRenderModel({
    draft: "",
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 24, columns: 120 },
    workdirFallback: "/fallback",
  });

  assert.match(copyTextFromRenderModel(model, "page"), /Second transcript line/);
  assert.match(copyTextFromRenderModel(model, "transcript"), /Agent API Workbench is ready/);
  assert.doesNotMatch(copyTextFromRenderModel(model, "transcript"), /Copied safely/);
  assert.match(copyTextFromRenderModel(model, "activity"), /Copied safely/);
  assert.doesNotMatch(copyTextFromRenderModel(model, "activity"), /Second transcript line/);
  assert.match(copyTextFromRenderModel(model, "conversation"), /Fix transcript OOM/);
});

test("workbench terminal controller routes focused panel operations", () => {
  const controller = createWorkbenchTerminalController();
  let workbenchState = createInitialWorkbenchState({});
  workbenchState = workbenchReducer(workbenchState, { type: "message.add", role: "assistant", text: "First transcript line\nSecond transcript line" });
  workbenchState = workbenchReducer(workbenchState, { type: "conversation.set", id: "conv_current", name: "default", status: "fresh" });
  workbenchState = workbenchReducer(workbenchState, {
    type: "conversations.set",
    conversations: [
      { id: "conv_current", latestSnippet: "Current task", messageCount: 2, name: "default", status: "fresh", titleSnippet: "Current task" },
      { id: "conv_other", latestSnippet: "Fix transcript OOM", messageCount: 7, name: "oom", status: "continued", titleSnippet: "Fix transcript OOM" },
    ],
  });
  workbenchState = workbenchReducer(workbenchState, {
    type: "workspace.set",
    workspace: { authType: "browser", id: "wrk_current_000000000000000000000001", name: "Current Workspace", role: "owner", switchable: true },
  });
  workbenchState = workbenchReducer(workbenchState, {
    type: "workspaces.set",
    workspaces: [
      { id: "wrk_current_000000000000000000000001", membershipStatus: "active", name: "Current Workspace", role: "owner", status: "active" },
      { id: "wrk_target_000000000000000000000002", membershipStatus: "active", name: "Target Workspace", role: "member", status: "active" },
      { id: "wrk_review_000000000000000000000003", membershipStatus: "active", name: "Review Workspace", role: "member", status: "active" },
      { id: "wrk_later_000000000000000000000004", membershipStatus: "active", name: "Later Workspace", role: "member", status: "active" },
    ],
  });
  let terminalState = initialWorkbenchTerminalState();
  const model = () => buildWorkbenchRenderModel({
    cursor: terminalState.cursor,
    draft: terminalState.draft,
    profileName: "default",
    selectionAnchor: terminalState.selectionAnchor,
    spinnerFrame: 0,
    state: workbenchState,
    transcriptOffset: terminalState.transcriptOffset,
    viewport: { rows: 24, columns: 120 },
    workdirFallback: "/fallback",
  });
  const apply = (input, key) => {
    const currentModel = model();
    const result = controller.handle(input, key, terminalState, {
      busy: currentModel.input.busy,
      renderModel: currentModel,
    });
    terminalState = result.state;
    return result;
  };
  const applyMouse = (event) => {
    const currentModel = model();
    const result = controller.handleMouse(event, terminalState, {
      busy: currentModel.input.busy,
      renderModel: currentModel,
    });
    terminalState = result.state;
    return result;
  };
  const inputTextRow = () => {
    const currentModel = model();
    const headerHeight = 6;
    const transcriptTop = headerHeight + 1;
    const transcriptBottom = transcriptTop + currentModel.transcript.viewportHeight + 2;
    const inputTop = transcriptBottom + 1;
    return inputTop + 2;
  };

  applyMouse({ button: "left", column: 5, kind: "press", row: 2 });
  assert.equal(terminalState.focusedPanel, "header");
  assert.equal(terminalState.mouseDragPanel, null);
  assert.deepEqual(terminalState.headerCursor, { column: 1, line: 0 });
  applyMouse({ button: "left", column: 9, kind: "motion", row: 2 });
  assert.equal(terminalState.headerSelectionAnchor, null);
  applyMouse({ button: "left", column: 9, kind: "release", row: 2 });
  assert.equal(terminalState.mouseDragPanel, null);
  assert.equal(terminalState.headerSelectionAnchor, null);
  apply("", { rightArrow: true, shift: true });
  const copiedHeader = apply("c", { meta: true });
  assert.deepEqual(copiedHeader.effects, [{ type: "copy", target: "header" }]);
  const rightClickCopyHeader = applyMouse({ button: "right", column: 5, kind: "press", row: 2 });
  assert.deepEqual(rightClickCopyHeader.effects, [{ type: "copy", target: "header" }]);
  terminalState = { ...terminalState, headerSelectionAnchor: null };
  const inactiveRightClickCopyHeader = applyMouse({ button: "right", column: 5, kind: "press", row: 2 });
  assert.deepEqual(inactiveRightClickCopyHeader.effects, []);

  applyMouse({ button: "left", column: 5, kind: "press", row: 7 });
  assert.equal(terminalState.focusedPanel, "conversation");
  applyMouse({ button: "left", column: 5, kind: "press", row: 13 });
  assert.equal(terminalState.focusedPanel, "workdir");

  applyMouse({ button: "left", column: 32, kind: "press", row: 7 });
  assert.equal(terminalState.focusedPanel, "transcript");
  assert.equal(terminalState.mouseDragPanel, null);
  assert.deepEqual(terminalState.transcriptCursor, { column: 1, line: 0 });
  applyMouse({ button: "left", column: 36, kind: "motion", row: 7 });
  assert.equal(terminalState.transcriptSelectionAnchor, null);
  applyMouse({ button: "left", column: 36, kind: "release", row: 7 });
  assert.equal(terminalState.mouseDragPanel, null);
  assert.equal(terminalState.transcriptSelectionAnchor, null);

  const beforeWheel = terminalState.transcriptOffset;
  applyMouse({ button: "wheel_up", column: 5, kind: "wheel", row: 7 });
  assert.ok(terminalState.transcriptOffset >= beforeWheel);

  terminalState = { ...terminalState, cursor: 0, draft: "abc", selectionAnchor: null };
  applyMouse({ button: "left", column: 5, kind: "press", row: inputTextRow() });
  assert.equal(terminalState.focusedPanel, "input");
  assert.equal(terminalState.cursor, 1);
  assert.equal(terminalState.mouseDragPanel, null);
  applyMouse({ button: "left", column: 7, kind: "motion", row: inputTextRow() });
  assert.equal(terminalState.cursor, 1);
  assert.equal(terminalState.selectionAnchor, null);
  applyMouse({ button: "left", column: 7, kind: "release", row: inputTextRow() });
  assert.equal(terminalState.mouseDragPanel, null);
  assert.equal(terminalState.selectionAnchor, null);
  const rightClickPaste = applyMouse({ button: "right", column: 7, kind: "press", row: inputTextRow() });
  assert.deepEqual(rightClickPaste.effects, [{ type: "paste" }]);
  terminalState = { ...terminalState, cursor: 0, draft: "", selectionAnchor: null };

  apply("", { tab: true });
  assert.equal(terminalState.focusedPanel, "header");
  apply("", { tab: true });
  assert.equal(terminalState.focusedPanel, "conversation");
  apply("", { downArrow: true });
  assert.deepEqual(apply("", { return: true }).effects, [{ type: "switch_conversation", name: "oom" }]);
  apply("", { upArrow: true });
  apply("", { tab: true });
  assert.equal(terminalState.focusedPanel, "workdir");
  apply("", { tab: true });
  assert.equal(terminalState.focusedPanel, "workspace");
  apply("", { downArrow: true });
  assert.deepEqual(apply("", { return: true }).effects, [{ type: "switch_workspace", id: "wrk_target_000000000000000000000002" }]);
  apply("", { downArrow: true });
  apply("", { downArrow: true });
  assert.deepEqual(apply("", { return: true }).effects, [{ type: "switch_workspace", id: "wrk_later_000000000000000000000004" }]);
  apply("", { tab: true });
  assert.equal(terminalState.focusedPanel, "transcript");

  apply("a", { meta: true });
  assert.equal(terminalState.focusedPanel, "conversation");
  apply("d", { meta: true });
  assert.equal(terminalState.focusedPanel, "transcript");
  apply("s", { meta: true });
  assert.equal(terminalState.focusedPanel, "input");
  const inputAfterPanelShortcut = terminalState;
  apply("W", {});
  assert.equal(terminalState.focusedPanel, "input");
  assert.equal(terminalState.draft, "W");
  apply("t", { meta: true });
  assert.equal(terminalState.focusedPanel, "transcript");
  assert.equal(terminalState.draft, "W");
  terminalState = { ...inputAfterPanelShortcut };
  apply("w", { meta: true });
  assert.equal(terminalState.focusedPanel, "transcript");
  const ignoredAltSpace = apply(" ", { meta: true });
  assert.equal(terminalState.focusedPanel, "transcript");
  assert.deepEqual(ignoredAltSpace.effects, []);
  const directInputFocus = apply("i", { meta: true });
  assert.equal(terminalState.focusedPanel, "input");
  assert.deepEqual(directInputFocus.effects, []);
  terminalState = { ...inputAfterPanelShortcut };
  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "activity");
  apply("w", { meta: true });
  assert.equal(terminalState.focusedPanel, "header");
  apply("s", { meta: true });
  assert.equal(terminalState.focusedPanel, "conversation");
  apply("d", { meta: true });
  assert.equal(terminalState.focusedPanel, "transcript");
  apply("d", { meta: true });
  assert.equal(terminalState.focusedPanel, "activity");
  apply("s", { meta: true });
  assert.equal(terminalState.focusedPanel, "input");
  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "activity");
  apply("a", { meta: true });
  assert.equal(terminalState.focusedPanel, "transcript");

  apply("", { home: true });
  apply("", { rightArrow: true });
  const characterSelection = apply("", { rightArrow: true, shift: true });
  const oneCharacter = selectedPanelRange(characterSelection.state.transcriptSelectionAnchor, characterSelection.state.transcriptCursor);
  assert.deepEqual(oneCharacter, {
    start: { column: 1, line: terminalState.transcriptCursor.line },
    end: { column: 2, line: terminalState.transcriptCursor.line },
  });
  assert.equal(copyTextFromTranscriptSelection(model().transcript.lines, oneCharacter), model().transcript.lines[terminalState.transcriptCursor.line].text.slice(1, 2));

  const selectAll = apply("a", { ctrl: true });
  assert.equal(selectAll.effects.length, 0);
  const rendered = model();
  const lastLine = rendered.transcript.totalLines - 1;
  assert.deepEqual(selectedPanelRange(terminalState.transcriptSelectionAnchor, terminalState.transcriptCursor), {
    start: { column: 0, line: 0 },
    end: { column: rendered.transcript.lines[lastLine].text.length, line: lastLine },
  });

  const plainC = apply("c", {});
  assert.deepEqual(plainC.effects, []);
  const copied = apply("c", { meta: true });
  assert.deepEqual(copied.effects, [{ type: "copy", target: "page" }]);
  const beforePasteShortcut = terminalState;
  const pasted = apply("v", { meta: true });
  assert.equal(terminalState.focusedPanel, "input");
  assert.deepEqual(pasted.effects, [{ type: "paste" }]);
  terminalState = beforePasteShortcut;

  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "workspace");
  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "workdir");
  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "conversation");
  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "header");
  apply("", { tab: true, shift: true });
  assert.equal(terminalState.focusedPanel, "input");
  apply("h", {});
  const submit = apply("i", {});
  assert.equal(submit.state.draft, "hi");
  assert.deepEqual(apply("", { return: true }).effects, [{ type: "submit", input: "hi" }]);
});

test("workbench terminal controller allows submit when only another conversation is running", () => {
  const controller = createWorkbenchTerminalController();
  let state = createInitialWorkbenchState({});
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_selected", name: "selected", status: "fresh" });
  state = workbenchReducer(state, {
    type: "run.started",
    run: {
      id: "run_other",
      assistantMessageId: "assistant_other",
      conversationId: "conv_other",
      conversationName: "other",
    },
  });
  const terminalState = {
    ...initialWorkbenchTerminalState(),
    cursor: "new task".length,
    draft: "new task",
  };
  const renderModel = buildWorkbenchRenderModel({
    cursor: terminalState.cursor,
    draft: terminalState.draft,
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 24, columns: 120 },
    workdirFallback: "/fallback",
  });

  assert.equal(state.busy, true);
  assert.equal(renderModel.input.busy, false);
  assert.deepEqual(controller.handle("", { return: true }, terminalState, {
    busy: renderModel.input.busy,
    renderModel,
  }).effects, [{ type: "submit", input: "new task" }]);
});

test("tui mouse parser accepts Ink-delivered SGR reports without ESC", () => {
  assert.deepEqual(parseMouseEvent("[<0;51;41M"), {
    button: "left",
    column: 51,
    kind: "press",
    row: 41,
  });
  assert.deepEqual(parseMouseEvent("\x1b[<0;51;41m"), {
    button: "left",
    column: 51,
    kind: "release",
    row: 41,
  });
  assert.deepEqual(parseMouseEvent("[<64;51;41M"), {
    button: "wheel_up",
    column: 51,
    kind: "wheel",
    row: 41,
  });
  assert.deepEqual(parseMouseEvent("[<2;51;41M"), {
    button: "right",
    column: 51,
    kind: "press",
    row: 41,
  });
});

test("workbench render model renders a single empty editor cursor", () => {
  const model = buildWorkbenchRenderModel({
    cursor: 0,
    draft: "",
    profileName: "default",
    spinnerFrame: 0,
    state: createInitialWorkbenchState({}),
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 80 },
    workdirFallback: "/fallback",
  });

  assert.deepEqual(model.input.lines, [{
    afterCursor: "",
    beforeCursor: "",
    cursorText: " ",
    end: 0,
    hasCursor: true,
    start: 0,
    spans: [{ text: " ", inverse: true }],
    text: "",
  }]);
});

test("workbench render model adapts to narrow terminal sizes", () => {
  const state = createInitialWorkbenchState({});
  const model = buildWorkbenchRenderModel({
    cursor: 3,
    draft: "hello world",
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 14, columns: 50 },
    workdirFallback: "/fallback",
  });

  assert.equal(model.layout, "compact");
  assert.equal(model.terminalRows, 14);
  assert.equal(model.terminalColumns, 50);
  assert.ok(model.viewportHeight <= 6);
  assert.ok(model.transcriptWidth <= 50);
  assert.ok(model.input.viewportColumns < 50);
});

test("workbench render model wraps long input into editor rows", () => {
  const state = createInitialWorkbenchState({});
  const draft = `${"x".repeat(90)}END`;
  const model = buildWorkbenchRenderModel({
    cursor: draft.length,
    draft,
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 80 },
    workdirFallback: "/fallback",
  });

  assert.equal(model.input.draft, draft);
  assert.ok(model.input.lines.length > 1);
  assert.ok(model.input.lines.length <= model.input.height);
  assert.equal(model.input.lines.at(-1).hasCursor, true);
  assert.equal(model.input.lines.at(-1).cursorText, " ");
  assert.match(model.input.lines.at(-1).beforeCursor, /END$/);
  assert.ok(model.input.lines.every((line) => line.beforeCursor.length + line.cursorText.length + line.afterCursor.length <= model.input.viewportColumns + 2));
});

test("workbench render model wraps CJK input by terminal display width", () => {
  const draft = "这是一个用于测试终端输入换行的中文段落";
  const model = buildWorkbenchRenderModel({
    cursor: draft.length,
    draft,
    profileName: "default",
    spinnerFrame: 0,
    state: createInitialWorkbenchState({}),
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 24 },
    workdirFallback: "/fallback",
  });

  assert.equal(model.input.viewportColumns, 18);
  assert.ok(model.input.lines.length > 1);
  assert.ok(model.input.lines.some((line) => line.beforeCursor.length < draft.length));
  assert.equal(model.input.lines.at(-1).hasCursor, true);
});

test("workbench render model normalizes tabs in mixed-width input rows", () => {
  const draft = "- 政策会进行变化。按照 Tiering 来进行 - 2025 年，大方向：- Industry Play：叠：一个 Industry 有 3~5 家 Partner 作为 Shortlist\t\t今年增加一个教育行业，做行业方案落地";
  const model = buildWorkbenchRenderModel({
    cursor: draft.length,
    draft,
    profileName: "default",
    spinnerFrame: 0,
    state: createInitialWorkbenchState({}),
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 80 },
    workdirFallback: "/fallback",
  });

  assert.ok(model.input.lines.length > 1);
  assert.ok(model.input.lines.every((line) => !line.beforeCursor.includes("\t")));
  assert.ok(model.input.lines.every((line) => !line.cursorText.includes("\t")));
  assert.ok(model.input.lines.every((line) => !line.afterCursor.includes("\t")));
  assert.ok(model.input.lines.every((line) => line.spans.every((span) => !span.text.includes("\t"))));
});

test("workbench render model bounds multiline editor height around the cursor", () => {
  const state = createInitialWorkbenchState({});
  const draft = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
  const model = buildWorkbenchRenderModel({
    cursor: draft.indexOf("line-7"),
    draft,
    profileName: "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: { rows: 30, columns: 80 },
    workdirFallback: "/fallback",
  });

  assert.equal(model.input.height, 5);
  assert.equal(model.input.lines.length, 5);
  assert.match(model.input.lines[0].beforeCursor, /^⋮ /);
  assert.ok(model.input.lines.some((line) => line.hasCursor));
});

test("pending local label is stable for renderer headers", () => {
  const state = createInitialWorkbenchState({ contextEnabled: true });
  assert.equal(pendingLocalLabel(state), "none");
  assert.equal(
    pendingLocalLabel({
      ...state,
      pendingLocalTool: {
        id: "local_1",
        createdAt: 1,
        name: "local_shell",
        action: "run",
        arguments: {},
        callID: "call_1",
        responseID: "resp_1",
      },
    }),
    "local_shell.run",
  );
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
      return { defaultPreset: "code-agent", isolation: { installSkipped: true } };
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
    shellIsolation: { installSkipped: true },
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

test("workbench settings controller persists automatic continuation limit", async () => {
  const patches = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      return { automaticContinuationLimit: 12, isolation: { installSkipped: true } };
    },
    async updateWorkbenchPreferencesImpl(patch) {
      patches.push(patch.automaticContinuationLimit);
      return "automaticContinuationLimit" in patch && patch.automaticContinuationLimit !== undefined
        ? { automaticContinuationLimit: patch.automaticContinuationLimit }
        : {};
    },
  });

  assert.deepEqual(await controller.loadInitial({ modelExplicit: false, preset: "pro-search", presetExplicit: false }), {
    automaticContinuationLimit: 12,
    defaultAutomaticContinuationLimit: 12,
    defaultPreset: undefined,
    runPreset: "pro-search",
    shellIsolation: { installSkipped: true },
  });

  assert.deepEqual(await controller.saveAutomaticContinuationLimit("16"), {
    automaticContinuationLimit: 16,
    defaultAutomaticContinuationLimit: 16,
    message: "Saved automatic continuation limit: 16.",
    activity: "Automatic continuation limit saved: 16",
  });
  assert.deepEqual(await controller.saveAutomaticContinuationLimit("unlimited"), {
    automaticContinuationLimit: null,
    defaultAutomaticContinuationLimit: null,
    message: "Saved automatic continuation limit: unlimited.",
    activity: "Automatic continuation limit saved: unlimited",
  });
  assert.deepEqual(await controller.saveAutomaticContinuationLimit("reset"), {
    message: "Saved automatic continuation limit: built-in (8).",
    activity: "Automatic continuation limit saved: built-in (8)",
  });
  assert.deepEqual(patches, [16, null, undefined]);
});

test("workbench settings controller persists shell isolation settings", async () => {
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      calls.push(["load"]);
      return {
        defaultPreset: "pro-search",
        isolation: { mode: "required", executablePath: "/opt/agent-isolator" },
      };
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(["update", patch.isolation]);
      return {
        defaultPreset: "pro-search",
        isolation: {
          mode: patch.isolation?.mode ?? "required",
          ...(
            patch.isolation && "executablePath" in patch.isolation
              ? (patch.isolation.executablePath ? { executablePath: patch.isolation.executablePath } : {})
              : { executablePath: "/opt/agent-isolator" }
          ),
        },
      };
    },
  });

  assert.deepEqual(await controller.loadInitial({ modelExplicit: false, preset: "pro-search", presetExplicit: false }), {
    defaultPreset: "pro-search",
    runPreset: "pro-search",
    shellIsolation: { mode: "required", executablePath: "/opt/agent-isolator" },
  });

  assert.deepEqual(await controller.saveShellIsolationMode("auto"), {
    defaultPreset: "pro-search",
    shellIsolation: { mode: "auto", executablePath: "/opt/agent-isolator" },
    message: "Saved shell isolation mode: auto.",
    activity: "Shell isolation mode saved: auto",
  });

  assert.deepEqual(await controller.saveIsolatorPath("none"), {
    defaultPreset: "pro-search",
    shellIsolation: { mode: "required" },
    message: "Saved isolator path: not configured.",
    activity: "Isolator path cleared",
  });

  assert.deepEqual(calls, [
    ["load"],
    ["update", { mode: "auto", installSkipped: false }],
    ["update", { executablePath: null }],
  ]);
});

test("workbench settings controller saves future isolator install targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-isolator-target-"));
  const target = join(root, "bin", "agent-isolator");
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      return {};
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(patch);
      return { isolation: patch.isolation };
    },
  });

  assert.deepEqual(await controller.saveIsolatorPath(target), {
    shellIsolation: { executablePath: target, installSkipped: false },
    message: `Saved isolator install target: ${target}.`,
    activity: "Isolator install target saved",
  });
  assert.deepEqual(calls, [{
    isolation: { executablePath: target, installSkipped: false },
  }]);
});

test("workbench settings controller resolves existing isolator target directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-isolator-dir-target-"));
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const expected = join(binDir, process.platform === "win32" ? "agent-isolator.exe" : "agent-isolator");
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      return {};
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(patch);
      return { isolation: patch.isolation };
    },
  });

  assert.deepEqual(await controller.saveIsolatorPath(binDir), {
    shellIsolation: { executablePath: expected, installSkipped: false },
    message: `Saved isolator install target: ${expected}.`,
    activity: "Isolator install target saved",
  });
  assert.deepEqual(calls, [{
    isolation: { executablePath: expected, installSkipped: false },
  }]);
});

test("workbench settings controller prompts once for isolator setup until skipped", async () => {
  const previousPath = process.env.AGENT_ISOLATOR_PATH;
  delete process.env.AGENT_ISOLATOR_PATH;
  const calls = [];
  try {
    const controller = createWorkbenchSettingsController({
      async loadWorkbenchPreferencesImpl() {
        calls.push(["load"]);
        return {};
      },
      async updateWorkbenchPreferencesImpl(patch) {
        calls.push(["update", patch.isolation]);
        return { isolation: patch.isolation };
      },
    });

    const initial = await controller.loadInitial({ modelExplicit: false, preset: "pro-search", presetExplicit: false });
    assert.match(initial.notice, /Local shell isolation is not configured yet/);
    assert.match(initial.notice, /\/config isolator source <https-url>/);

    assert.deepEqual(await controller.saveShellIsolationMode("none"), {
      shellIsolation: { mode: "none", installSkipped: true },
      message: "Saved shell isolation mode: none.",
      activity: "Shell isolation mode saved: none",
    });
    assert.deepEqual(calls, [
      ["load"],
      ["update", { mode: "none", installSkipped: true }],
    ]);
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGENT_ISOLATOR_PATH;
    } else {
      process.env.AGENT_ISOLATOR_PATH = previousPath;
    }
  }
});

test("workbench settings controller validates isolator source before saving", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "agent-tui-isolator-settings-"));
  const target = join(root, "bin", "agent-isolator");
  const script = [
    "#!/bin/sh",
    "cat >/dev/null",
    "printf '%s\\n' '{\"id\":\"status\",\"result\":{\"driver\":\"fake\",\"status\":{\"executor\":\"isolator\",\"driver\":\"fake\",\"isolated\":true,\"fallback\":false,\"requested\":{\"filesystem\":\"host\",\"network\":\"allowed\",\"env\":\"inherit\",\"resources\":{}},\"guarantees\":{\"filesystem\":\"policy-enforced\",\"network\":\"allowed\",\"user\":\"namespace-user\",\"process\":\"pid-namespace\",\"resources\":\"timeout-only\"},\"warnings\":[]}}}'",
  ].join("\n");
  const body = Buffer.from(`${script}\n`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      return { isolation: { executablePath: target } };
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(patch);
      return { isolation: patch.isolation };
    },
    isolatorInstallOptions: {
      fetchImpl: async () => new Response(body),
    },
  });

  assert.deepEqual(await controller.saveIsolatorSource("https://example.test/agent-isolator"), {
    shellIsolation: {
      sourceURL: "https://example.test/agent-isolator",
      executablePath: target,
      sha256,
      installSkipped: false,
    },
    message: "Installed isolator from https://example.test/agent-isolator.",
    activity: "Isolator installed from source",
  });
  assert.deepEqual(calls, [{
    isolation: {
      sourceURL: "https://example.test/agent-isolator",
      executablePath: target,
      sha256,
      installSkipped: false,
    },
  }]);
});

test("workbench settings controller repairs a missing configured isolator on startup", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "agent-tui-isolator-repair-"));
  const target = join(root, "bin", "agent-isolator");
  const script = [
    "#!/bin/sh",
    "cat >/dev/null",
    "printf '%s\\n' '{\"id\":\"status\",\"result\":{\"driver\":\"fake\",\"status\":{\"executor\":\"isolator\",\"driver\":\"fake\",\"isolated\":true,\"fallback\":false,\"requested\":{\"filesystem\":\"host\",\"network\":\"allowed\",\"env\":\"inherit\",\"resources\":{}},\"guarantees\":{\"filesystem\":\"policy-enforced\",\"network\":\"allowed\",\"user\":\"namespace-user\",\"process\":\"pid-namespace\",\"resources\":\"timeout-only\"},\"warnings\":[]}}}'",
  ].join("\n");
  const body = Buffer.from(`${script}\n`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      calls.push(["load"]);
      return {
        defaultPreset: "pro-search",
        isolation: {
          mode: "auto",
          sourceURL: "https://example.test/agent-isolator",
          executablePath: target,
        },
      };
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(["update", patch.isolation]);
      return {
        defaultPreset: "pro-search",
        isolation: {
          mode: "auto",
          ...patch.isolation,
        },
      };
    },
    isolatorInstallOptions: {
      fetchImpl: async () => new Response(body),
    },
  });

  assert.deepEqual(await controller.loadInitial({ modelExplicit: false, preset: "pro-search", presetExplicit: false }), {
    defaultPreset: "pro-search",
    runPreset: "pro-search",
    shellIsolation: {
      mode: "auto",
      sourceURL: "https://example.test/agent-isolator",
      executablePath: target,
      sha256,
      installSkipped: false,
    },
    activity: `Reinstalled isolator: ${target}`,
  });
  assert.deepEqual(calls, [
    ["load"],
    ["update", {
      sourceURL: "https://example.test/agent-isolator",
      executablePath: target,
      sha256,
      installSkipped: false,
    }],
  ]);
});

test("workbench settings controller rejects invalid isolator source without saving", async () => {
  const calls = [];
  const controller = createWorkbenchSettingsController({
    async loadWorkbenchPreferencesImpl() {
      return { isolation: { executablePath: "/tmp/agent-isolator" } };
    },
    async updateWorkbenchPreferencesImpl(patch) {
      calls.push(patch);
      return { isolation: patch.isolation };
    },
  });

  await assert.rejects(
    () => controller.saveIsolatorSource("http://example.test/agent-isolator"),
    /must use https/,
  );
  assert.deepEqual(calls, []);
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
    async deleteWorkspaceConversationImpl(name, profile, workspaceId) {
      calls.push(["delete", name, profile, workspaceId]);
    },
    async listConversationsImpl(profile, workspaceId) {
      calls.push(["list", profile, workspaceId]);
      return [
        {
          id: "conv_release",
          name: "release",
          profile: profile || "default",
          previousResponseId: "resp_test",
          createdAt: 4102444700,
          updatedAt: 4102444800,
        },
        {
          id: "conv_notes",
          name: "notes",
          profile: profile || "default",
          createdAt: 4102444600,
          updatedAt: 4102444700,
        },
      ];
    },
    async startFreshConversationImpl(name, profile, workspaceId, workspaceName) {
      calls.push(["fresh", name, profile, workspaceId, workspaceName]);
      return {
        id: "conv_new",
        name,
        profile,
        workspaceId,
        workspaceName,
        createdAt: 1782131696,
        updatedAt: 1782131696,
      };
    },
    async ensureConversationImpl(name, profile, workspaceId, workspaceName) {
      calls.push(["ensure", name, profile, workspaceId, workspaceName]);
      return {
        id: "conv_release",
        name,
        profile,
        workspaceId,
        workspaceName,
        previousResponseId: "resp_test",
        createdAt: 4102444700,
        updatedAt: 4102444800,
      };
    },
    async renameConversationImpl(name, nextName, profile, workspaceId) {
      calls.push(["rename", name, nextName, profile, workspaceId]);
      return {
        id: "conv_release",
        name: nextName,
        profile,
        workspaceId,
        previousResponseId: "resp_test",
        createdAt: 4102444700,
        updatedAt: 4102444900,
      };
    },
  });

  assert.deepEqual(await controller.startNewConversation(undefined, "dev"), {
    createdAt: 1782131696,
    id: "conv_new",
    name: "thread-20260622-123456",
    profile: "dev",
    status: "fresh",
    updatedAt: 1782131696,
    message: 'Started fresh conversation "thread-20260622-123456" (conv_new).',
  });
  assert.deepEqual(await controller.switchConversation("release", "dev"), {
    createdAt: 4102444700,
    id: "conv_release",
    name: "release",
    profile: "dev",
    previousResponseId: "resp_test",
    status: "continued",
    updatedAt: 4102444800,
    message: 'Switched to conversation "release" (conv_release). Continuing from resp_test.',
  });
  assert.deepEqual(await controller.renameConversation("release", "release notes", "dev"), {
    createdAt: 4102444700,
    id: "conv_release",
    name: "release notes",
    profile: "dev",
    previousResponseId: "resp_test",
    status: "continued",
    updatedAt: 4102444900,
    message: 'Renamed conversation "release" to "release notes".',
  });
  assert.deepEqual(await controller.deleteConversation("release", "dev"), {
    name: "release",
    message: 'Deleted conversation "release".',
  });
  assert.deepEqual(await controller.listConversationSelections("dev"), [{
    createdAt: 4102444700,
    id: "conv_release",
    name: "release",
    profile: "dev",
    previousResponseId: "resp_test",
    status: "continued",
    updatedAt: 4102444800,
    message: "",
  }, {
    createdAt: 4102444600,
    id: "conv_notes",
    name: "notes",
    profile: "dev",
    status: "fresh",
    updatedAt: 4102444700,
    message: "",
  }]);
  assert.match(await controller.listConversations("dev"), /release\tdev\t2100-01-01T00:00:00\.000Z\tconv_release response=resp_test/);
  assert.doesNotMatch(await controller.listConversations("dev", "release"), /notes\tdev/);
  assert.match(await controller.listConversations("dev", "missing"), /No conversations match: missing/);

  const exported = await controller.exportTranscript({
    conversation: "release notes",
    transcript: "System:\nReady.\n",
  });
  assert.equal(exported, join(root, "transcripts", "release-notes-2026-06-22T12-34-56-000Z.txt"));
  assert.equal(await readFile(exported, "utf8"), "System:\nReady.\n");
  assert.deepEqual(calls, [
    ["delete", "thread-20260622-123456", "dev", undefined],
    ["fresh", "thread-20260622-123456", "dev", undefined, undefined],
    ["ensure", "release", "dev", undefined, undefined],
    ["rename", "release", "release notes", "dev", undefined],
    ["delete", "release", "dev", undefined],
    ["list", "dev", undefined],
    ["list", "dev", undefined],
    ["list", "dev", undefined],
    ["list", "dev", undefined],
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

test("workbench input controller edits, submits, and recalls drafts", () => {
  const controller = createWorkbenchInputController();
  let draft = "";
  let cursor = 0;
  const context = (overrides = {}) => ({ busy: false, cursor, draft, viewportHeight: 10, ...overrides });
  const apply = (result) => {
    draft = result.draft;
    cursor = result.cursor;
    return result;
  };

  let result = apply(controller.handle("h", {}, context()));
  assert.equal(draft, "h");
  assert.equal(cursor, 1);
  result = apply(controller.handle("i", {}, context()));
  assert.equal(draft, "hi");
  assert.equal(cursor, 2);

  result = apply(controller.handle("", { leftArrow: true }, context()));
  assert.equal(cursor, 1);
  result = apply(controller.handle("!", {}, context()));
  assert.equal(draft, "h!i");
  assert.equal(cursor, 2);
  result = apply(controller.handle("", { backspace: true }, context()));
  assert.equal(draft, "hi");
  assert.equal(cursor, 1);
  result = apply(controller.handle("", { home: true }, context()));
  assert.equal(cursor, 0);
  result = apply(controller.handle("s", {}, context()));
  assert.equal(draft, "shi");
  result = apply(controller.handle("", { end: true }, context()));
  assert.equal(cursor, 3);

  result = apply(controller.handle("", { meta: true, return: true }, context()));
  assert.equal(draft, "shi\n");
  assert.equal(cursor, 4);
  result = apply(controller.handle("there", {}, context()));
  assert.equal(draft, "shi\nthere");
  assert.equal(cursor, 9);
  result = apply(controller.handle("", { upArrow: true }, context()));
  assert.equal(cursor, 3);
  result = apply(controller.handle("", { downArrow: true }, context()));
  assert.equal(cursor, 7);
  result = apply(controller.handle("", { home: true }, context()));
  assert.equal(cursor, 4);
  result = apply(controller.handle("", { end: true }, context()));
  assert.equal(cursor, 9);

  result = apply(controller.handle("", { return: true }, context()));
  assert.deepEqual(result.effects, [{ type: "submit", input: "shi\nthere" }]);
  assert.equal(draft, "");
  assert.equal(cursor, 0);

  result = apply(controller.handle("", { upArrow: true }, context()));
  assert.equal(draft, "");
  assert.equal(cursor, 0);
  result = apply(controller.handle("", { ctrl: true, upArrow: true }, context()));
  assert.equal(draft, "shi\nthere");
  assert.equal(cursor, 9);
  result = apply(controller.handle("", { ctrl: true, downArrow: true }, context()));
  assert.equal(draft, "");
  assert.equal(cursor, 0);
});

test("workbench input controller normalizes pasted carriage returns", () => {
  const controller = createWorkbenchInputController();
  const result = controller.handle("Detected At: 2026-07-01\r\nAccount detected\rTail", {}, {
    busy: false,
    draft: "",
    viewportHeight: 10,
  });

  assert.equal(result.draft, "Detected At: 2026-07-01\nAccount detected\nTail");
  assert.equal(result.cursor, result.draft.length);
  assert.equal(result.selectionAnchor, null);
});

test("workbench input controller maps navigation and busy abort policy", () => {
  const controller = createWorkbenchInputController();

  assert.deepEqual(controller.handle("", { pageUp: true }, { busy: false, draft: "", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "scroll", delta: 10 }],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { pageDown: true }, { busy: false, draft: "", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "scroll", delta: -10 }],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { return: true }, { busy: true, draft: "/copy activity", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "submit", input: "/copy activity" }],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("u", { ctrl: true }, { busy: false, draft: "abcd", viewportHeight: 11 }), {
    cursor: 4,
    draft: "abcd",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("d", { ctrl: true }, { busy: false, draft: "abcd", viewportHeight: 11 }), {
    cursor: 4,
    draft: "abcd",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { home: true }, { busy: false, cursor: 2, draft: "abcd", viewportHeight: 11 }), {
    cursor: 0,
    draft: "abcd",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { end: true }, { busy: false, cursor: 2, draft: "abcd", viewportHeight: 11 }), {
    cursor: 4,
    draft: "abcd",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { upArrow: true }, { busy: false, cursor: 2, draft: "abcd", viewportHeight: 11 }), {
    cursor: 2,
    draft: "abcd",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { downArrow: true }, { busy: false, cursor: 2, draft: "abcd", viewportHeight: 11 }), {
    cursor: 2,
    draft: "abcd",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { backspace: true }, { busy: false, cursor: 4, draft: "abcd", viewportHeight: 11 }), {
    cursor: 3,
    draft: "abc",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("\x7f", {}, { busy: false, cursor: 4, draft: "abcd", viewportHeight: 11 }), {
    cursor: 3,
    draft: "abc",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("\b", {}, { busy: false, cursor: 4, draft: "abcd", viewportHeight: 11 }), {
    cursor: 3,
    draft: "abc",
    effects: [],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("c", { ctrl: true }, { busy: false, draft: "", viewportHeight: 11 }).effects, [{ type: "exit" }]);

  assert.deepEqual(controller.handle("", { escape: true }, { busy: true, draft: "ignored", viewportHeight: 11 }), {
    cursor: 7,
    draft: "ignored",
    effects: [{ type: "abort" }],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { return: true }, { busy: true, draft: "/abort", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "abort" }],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { return: true }, { busy: true, draft: "/resume rollout ready", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "submit", input: "/resume rollout ready" }],
    selectionAnchor: null,
  });
  assert.deepEqual(controller.handle("", { return: true }, { busy: true, draft: "hello", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "ignored_busy" }],
    selectionAnchor: null,
  });
});

test("workbench input controller supports visual-row movement and selected deletion", () => {
  const controller = createWorkbenchInputController();
  const wrapped = controller.handle("", { downArrow: true }, {
    busy: false,
    cursor: 2,
    draft: "abcdefghijklmnop",
    viewportColumns: 8,
    viewportHeight: 10,
  });
  assert.equal(wrapped.cursor, 10);

  const cjkWrapped = controller.handle("", { downArrow: true }, {
    busy: false,
    cursor: 2,
    draft: "一二三四五六七八九十",
    viewportColumns: 8,
    viewportHeight: 10,
  });
  assert.equal(cjkWrapped.cursor, 6);

  const visualHome = controller.handle("", { home: true }, {
    busy: false,
    cursor: 10,
    draft: "abcdefghijklmnop",
    viewportColumns: 8,
    viewportHeight: 10,
  });
  assert.equal(visualHome.cursor, 8);

  const visualEnd = controller.handle("", { end: true }, {
    busy: false,
    cursor: 10,
    draft: "abcdefghijklmnop",
    viewportColumns: 8,
    viewportHeight: 10,
  });
  assert.equal(visualEnd.cursor, 16);

  const boundaryHome = controller.handle("", { home: true }, {
    busy: false,
    cursor: 8,
    draft: "abcdefghijklmnop",
    viewportColumns: 8,
    viewportHeight: 10,
  });
  assert.equal(boundaryHome.cursor, 8);

  const shiftedHome = controller.handle("", { home: true, shift: true }, {
    busy: false,
    cursor: 12,
    draft: "abcdefghijklmnop",
    viewportColumns: 8,
    viewportHeight: 10,
  });
  assert.equal(shiftedHome.cursor, 8);
  assert.equal(shiftedHome.selectionAnchor, 12);

  const shiftedUp = controller.handle("", { upArrow: true, shift: true }, {
    busy: false,
    cursor: 14,
    draft: "line1\nline2\nline3",
    viewportColumns: 6,
    viewportHeight: 10,
  });
  assert.equal(shiftedUp.cursor, 8);
  assert.equal(shiftedUp.selectionAnchor, 14);
  assert.deepEqual(shiftedUp.effects, []);

  const shiftedDown = controller.handle("", { downArrow: true, shift: true }, {
    busy: false,
    cursor: 2,
    draft: "line1\nline2\nline3",
    viewportColumns: 6,
    viewportHeight: 10,
  });
  assert.equal(shiftedDown.cursor, 8);
  assert.equal(shiftedDown.selectionAnchor, 2);
  assert.deepEqual(shiftedDown.effects, []);

  const metaFallback = controller.handle("", { downArrow: true, meta: true }, {
    busy: false,
    cursor: 2,
    draft: "line1\nline2\nline3",
    viewportColumns: 80,
    viewportHeight: 10,
  });
  assert.equal(metaFallback.cursor, 8);
  assert.equal(metaFallback.selectionAnchor, 2);

  const selected = controller.handle("", { rightArrow: true, shift: true }, {
    busy: false,
    cursor: 2,
    draft: "abcd",
    viewportHeight: 10,
  });
  assert.equal(selected.cursor, 3);
  assert.equal(selected.selectionAnchor, 2);

  const deleted = controller.handle("", { backspace: true }, {
    busy: false,
    cursor: selected.cursor,
    draft: "abcd",
    selectionAnchor: selected.selectionAnchor,
    viewportHeight: 10,
  });
  assert.equal(deleted.draft, "abd");
  assert.equal(deleted.cursor, 2);
  assert.equal(deleted.selectionAnchor, null);

  const forwardDeleted = controller.handle("", { delete: true }, {
    busy: false,
    cursor: 1,
    draft: "abcd",
    viewportHeight: 10,
  });
  assert.equal(forwardDeleted.draft, "acd");
  assert.equal(forwardDeleted.cursor, 1);
  assert.equal(forwardDeleted.selectionAnchor, null);

  const allSelected = controller.handle("a", { ctrl: true }, {
    busy: false,
    cursor: 2,
    draft: "clear me",
    viewportHeight: 10,
  });
  assert.equal(allSelected.cursor, 8);
  assert.equal(allSelected.selectionAnchor, 0);

  const cleared = controller.handle("", { backspace: true }, {
    busy: false,
    cursor: allSelected.cursor,
    draft: allSelected.draft,
    selectionAnchor: allSelected.selectionAnchor,
    viewportHeight: 10,
  });
  assert.equal(cleared.draft, "");
  assert.equal(cleared.cursor, 0);
  assert.equal(cleared.selectionAnchor, null);

  const ctrlHDeleted = controller.handle("h", { ctrl: true }, {
    busy: false,
    cursor: 2,
    draft: "abcd",
    viewportHeight: 10,
  });
  assert.equal(ctrlHDeleted.draft, "acd");
  assert.equal(ctrlHDeleted.cursor, 1);
});

test("workbench transcript formatter produces readable plain text", () => {
  assert.equal(formatTranscript([
    { id: "1", role: "system", text: "Ready." },
    { id: "4", kind: "tool", role: "system", text: "Local execution completed." },
    { id: "2", role: "user", text: "Hello" },
    { id: "3", role: "assistant", text: "Hi there\n" },
  ]), "System:\nReady.\n\nTool:\nLocal execution completed.\n\nYou:\nHello\n\nAgent:\nHi there\n");
});

test("workbench reducer creates streamed assistant output at first text event", () => {
  let state = createInitialWorkbenchState({ contextEnabled: false });
  state = workbenchReducer(state, { type: "message.add", id: "tool-1", kind: "tool", role: "system", text: "Local execution completed." });
  state = workbenchReducer(state, { type: "message.append", id: "assistant-1", delta: "Final answer." });

  assert.deepEqual(state.messages.slice(-2).map((message) => message.id), ["tool-1", "assistant-1"]);
  assert.equal(state.messages.at(-1)?.text, "Final answer.");
});

test("workbench reducer keeps targeted background transcript writes out of the selected conversation", () => {
  let state = createInitialWorkbenchState({ contextEnabled: false });
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_visible", name: "visible", status: "fresh" });
  const beforeMessages = state.messages;

  state = workbenchReducer(state, {
    type: "message.add",
    id: "background-1",
    role: "assistant",
    text: "Background output",
    conversationId: "conv_background",
  });

  assert.equal(state.messages, beforeMessages);
});

test("workbench reducer tracks run registry lifecycle", () => {
  let state = createInitialWorkbenchState({ contextEnabled: false });
  state = workbenchReducer(state, {
    type: "run.started",
    run: {
      id: "run_1",
      assistantMessageId: "assistant_1",
      conversationId: "conv_1",
      conversationName: "alpha",
      workspaceId: "wrk_1",
      workspaceName: "Workspace",
    },
  });

  assert.equal(state.busy, true);
  assert.equal(state.activeRunId, "run_1");
  assert.equal(state.runs[0].status, "running");
  assert.equal(state.runs[0].conversationId, "conv_1");

  state = workbenchReducer(state, { type: "run.response.set", runId: "run_1", responseId: "resp_1" });
  assert.equal(state.runs[0].responseId, "resp_1");

  state = workbenchReducer(state, { type: "run.status.set", runId: "run_1", status: "completed", statusText: "resp_1" });
  assert.equal(state.busy, false);
  assert.equal(state.activeRunId, null);
  assert.equal(state.runs[0].status, "completed");
  assert.equal(state.runs[0].statusText, "resp_1");
});

test("workbench reducer scopes pending local approvals by selected conversation", () => {
  let state = createInitialWorkbenchState({ contextEnabled: true, accessMode: "approval" });
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_a", name: "alpha", status: "fresh" });
  state = workbenchReducer(state, {
    type: "run.started",
    run: {
      id: "run_alpha",
      assistantMessageId: "assistant_alpha",
      conversationId: "conv_a",
      conversationName: "alpha",
    },
  });
  state = workbenchReducer(state, { type: "conversation.set", id: "conv_b", name: "beta", status: "fresh" });
  state = workbenchReducer(state, {
    type: "run.started",
    run: {
      id: "run_beta",
      assistantMessageId: "assistant_beta",
      conversationId: "conv_b",
      conversationName: "beta",
    },
  });
  state = workbenchReducer(state, {
    type: "local_tool.pending.set",
    runId: "run_alpha",
    approval: {
      name: "local_shell",
      action: "run",
      arguments: { command: "echo alpha" },
      callID: "call_alpha",
      responseID: "resp_alpha",
    },
  });
  state = workbenchReducer(state, {
    type: "local_tool.pending.set",
    runId: "run_beta",
    approval: {
      name: "local_workdir",
      action: "read",
      arguments: { path: "beta.txt" },
      callID: "call_beta",
      responseID: "resp_beta",
    },
  });

  assert.equal(state.pendingLocalTools.length, 2);
  assert.equal(selectedConversationPendingLocalTool(state)?.responseID, "resp_beta");
  assert.equal(state.pendingLocalTool?.responseID, "resp_beta");

  state = workbenchReducer(state, { type: "conversation.set", id: "conv_a", name: "alpha", status: "continued" });
  assert.equal(selectedConversationPendingLocalTool(state)?.responseID, "resp_alpha");
  assert.equal(state.pendingLocalTool?.responseID, "resp_alpha");

  state = workbenchReducer(state, { type: "local_tool.pending.clear", runId: "run_alpha" });
  assert.equal(selectedConversationPendingLocalTool(state), null);
  assert.equal(state.pendingLocalTools.length, 1);

  state = workbenchReducer(state, { type: "conversation.set", id: "conv_b", name: "beta", status: "continued" });
  assert.equal(selectedConversationPendingLocalTool(state)?.responseID, "resp_beta");
});

test("workbench transcript store persists recent messages and deltas", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendMessage("conv_1", { id: "user-1", role: "user", text: "Hello" });
  await store.appendMessage("conv_1", { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed." });
  await store.appendMessage("conv_1", { id: "assistant-1", role: "assistant", text: "Hi" });
  await store.appendMessageDelta("conv_1", "assistant-1", " there");

  assert.deepEqual(await store.loadRecentMessages("conv_1", 2), [
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
    { id: "assistant-1", role: "assistant", text: "Hi there", transcriptSeq: 3 },
  ]);
  assert.deepEqual(await store.loadBeforeMessages("conv_1", 3, 1), [
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
  ]);
  assert.deepEqual(await store.loadAfterMessages("conv_1", 1, 1), [
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
  ]);
  assert.deepEqual(await store.getConversationSummary("conv_1"), {
    latestSnippet: "Hi there",
    messageCount: 3,
    titleSnippet: "Hello",
    updatedAt: undefined,
  });
  assert.deepEqual(summarizeMessages([
    { id: "u", role: "user", text: "  Multi\n\nline\trequest  " },
    { id: "a", role: "assistant", text: "Done" },
  ]), {
    latestSnippet: "Done",
    messageCount: 2,
    titleSnippet: "Multi line request",
    updatedAt: undefined,
  });
  assert.equal(await store.exportConversation("conv_1"), [
    "You:",
    "Hello",
    "",
    "Tool:",
    "Local execution completed.",
    "",
    "Agent:",
    "Hi there",
    "",
  ].join("\n"));
});

test("workbench engine keeps transcript store independent from the visible window", async () => {
  const store = createMemoryTranscriptStore();
  const engine = createWorkbenchEngine({ contextEnabled: false, transcriptStore: store });
  const fullText = "x".repeat(70_000);
  engine.dispatch({ type: "conversation.set", id: "conv_window", name: "window", status: "fresh" });
  engine.dispatch({ type: "message.add", id: "assistant-window", role: "assistant", text: fullText });
  engine.dispatch({ type: "message.append", id: "assistant-window", delta: "tail" });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const visible = engine.snapshot().messages.find((message) => message.id === "assistant-window");
  assert.ok(visible);
  assert.ok(visible.text.length < fullText.length);
  assert.match(visible.text, /trimmed from the live view/);

  const persisted = await store.loadRecentMessages("conv_window", 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].text, `${fullText}tail`);
});

test("workbench engine persists targeted background transcript writes without changing the visible window", async () => {
  const store = createMemoryTranscriptStore();
  const engine = createWorkbenchEngine({ contextEnabled: false, transcriptStore: store });
  engine.dispatch({ type: "conversation.set", id: "conv_visible", name: "visible", status: "fresh" });
  const visibleBefore = engine.snapshot().messages;

  engine.dispatch({
    type: "message.add",
    id: "background-1",
    role: "assistant",
    text: "Background output",
    conversationId: "conv_background",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(engine.snapshot().messages, visibleBefore);
  assert.deepEqual(await store.loadRecentMessages("conv_background", 5), [
    { id: "background-1", kind: undefined, role: "assistant", text: "Background output", transcriptSeq: 1 },
  ]);
  assert.deepEqual(await store.loadRecentMessages("conv_visible", 5), []);
});

test("workbench file transcript store persists messages on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-file-transcript-"));
  const store = createFileTranscriptStore(root);
  await store.appendMessage("conv_file", { id: "user-1", role: "user", text: "Hello" });
  await store.appendMessage("conv_file", { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed." });
  await store.appendMessage("conv_file", { id: "assistant-1", role: "assistant", text: "" });
  await store.appendMessageDelta("conv_file", "assistant-1", "Fallback");

  const reopened = createFileTranscriptStore(root);
  assert.deepEqual(await reopened.loadRecentMessages("conv_file", 10), [
    { id: "user-1", role: "user", text: "Hello", transcriptSeq: 1 },
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
    { id: "assistant-1", role: "assistant", text: "Fallback", transcriptSeq: 3 },
  ]);
  assert.deepEqual(await reopened.loadBeforeMessages("conv_file", 3, 1), [
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
  ]);
  assert.deepEqual(await reopened.loadAfterMessages("conv_file", 2, 1), [
    { id: "assistant-1", role: "assistant", text: "Fallback", transcriptSeq: 3 },
  ]);
  assert.deepEqual(await reopened.loadBeforeMessages("conv_file", 2, 1), [
    { id: "user-1", role: "user", text: "Hello", transcriptSeq: 1 },
  ]);
  assert.match(await reopened.exportConversation("conv_file"), /Agent:\nFallback/);
});

test("cli sqlite transcript store persists messages on disk", async () => {
  const { createSQLiteTranscriptStore } = await import("../dist/tui/transcript-store.js");
  const root = await mkdtemp(join(tmpdir(), "agent-tui-transcript-"));
  const file = join(root, "transcripts.sqlite3");
  const store = createSQLiteTranscriptStore(file);
  await store.appendMessage("conv_sql", { id: "user-1", role: "user", text: "Hello" });
  await store.appendMessage("conv_sql", { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed." });
  await store.appendMessage("conv_sql", { id: "assistant-1", role: "assistant", text: "" });
  await store.appendMessageDelta("conv_sql", "assistant-1", "Stored");
  store.dispose();

  const reopened = createSQLiteTranscriptStore(file);
  assert.deepEqual(await reopened.loadRecentMessages("conv_sql", 10), [
    { id: "user-1", role: "user", text: "Hello", transcriptSeq: 1 },
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
    { id: "assistant-1", role: "assistant", text: "Stored", transcriptSeq: 3 },
  ]);
  assert.deepEqual(await reopened.loadBeforeMessages("conv_sql", 3, 1), [
    { id: "tool-1", kind: "tool", role: "system", text: "Local execution completed.", transcriptSeq: 2 },
  ]);
  assert.deepEqual(await reopened.loadAfterMessages("conv_sql", 2, 1), [
    { id: "assistant-1", role: "assistant", text: "Stored", transcriptSeq: 3 },
  ]);
  assert.match(await reopened.exportConversation("conv_sql"), /Agent:\nStored/);
  reopened.dispose();
});

test("workbench view model renders markdown transcript lines", () => {
  const lines = buildTranscriptLines([
    { id: "1", role: "assistant", text: "# Title\n- **item** [docs](https://example.test)\n> quoted" },
  ], {
    activeAssistantMessageId: null,
    busy: false,
    renderMode: "markdown",
    spinnerFrame: 0,
    width: 40,
  });

  assert.deepEqual(lines.map((line) => line.text), ["Agent", "Title", "• item docs (https://example.test)", "│ quoted", ""]);
  assert.equal(lines[1].bold, true);
  assert.equal(lines[1].color, "cyan");
  assert.deepEqual(lines[2].spans, [
    { text: "• " },
    { text: "item", bold: true },
    { text: " " },
    { text: "docs", color: "cyan" },
    { text: " (https://example.test)", color: "gray" },
  ]);
  assert.equal(lines[3].color, "gray");
});

test("workbench help transcript styles command names", () => {
  const lines = buildTranscriptLines([
    { id: "1", role: "system", text: helpText() },
  ], {
    activeAssistantMessageId: null,
    busy: false,
    renderMode: "markdown",
    spinnerFrame: 0,
    width: 96,
  });

  const authLine = lines.find((line) => line.text.includes("/auth"));
  assert.ok(authLine);
  assert.deepEqual(authLine.spans?.[0], { text: "/auth", bold: true });
  assert.equal(authLine.spans?.[1]?.bold, undefined);
  assert.match(authLine.spans?.[1]?.text ?? "", /show current auth profile/);
  assert.ok(lines.some((line) => line.text.includes("/version") && line.text.includes("current workbench version")));
});

test("workbench view model labels local tool transcript messages distinctly", () => {
  const lines = buildTranscriptLines([
    { id: "1", kind: "tool", role: "system", text: "Local execution completed: local_shell.run." },
  ], {
    activeAssistantMessageId: null,
    busy: false,
    renderMode: "markdown",
    spinnerFrame: 0,
    width: 60,
  });

  assert.equal(lines[0].text, "Tool");
  assert.equal(lines[0].color, "yellow");
  assert.equal(lines[0].bold, true);
  assert.equal(lines[1].color, "yellow");
});

test("workbench view model wraps wide final-answer text by display columns", () => {
  const view = buildTranscriptViewModel({
    activeAssistantMessageId: null,
    busy: false,
    messages: [
      {
        id: "assistant-wide",
        role: "assistant",
        text: "这是一个很长的中文最终回答，用来确认终端显示宽度会正确换行，而不是被截断。",
      },
    ],
    offset: 0,
    renderMode: "markdown",
    spinnerFrame: 0,
    viewportHeight: 20,
    width: 20,
  });
  const contentLines = view.lines.filter((line) => line.id.startsWith("assistant-wide:line:"));
  assert.ok(contentLines.length > 2);
  assert.ok(contentLines.every((line) => line.text.length <= 10));
});

test("workbench view model normalizes tabs in mixed-width transcript rows", () => {
  const view = buildTranscriptViewModel({
    activeAssistantMessageId: null,
    busy: false,
    messages: [
      {
        id: "assistant-mixed",
        role: "assistant",
        text: "- 政策会进行变化。按照 Tiering 来进行 - 2025 年，大方向：- Industry Play：叠：一个 Industry 有 3~5 家 Partner 作为 Shortlist\t\t今年增加一个教育行业，做行业方案落地",
      },
    ],
    offset: 0,
    renderMode: "markdown",
    spinnerFrame: 0,
    viewportHeight: 20,
    width: 40,
  });

  const contentLines = view.lines.filter((line) => line.id.startsWith("assistant-mixed:line:"));
  assert.ok(contentLines.length > 1);
  assert.ok(contentLines.every((line) => !line.text.includes("\t")));
  assert.ok(contentLines.every((line) => (line.spans ?? []).every((span) => !span.text.includes("\t"))));
});

test("workbench view model slices transcript viewport and renders waiting state", () => {
  const view = buildTranscriptViewModel({
    activeAssistantMessageId: "assistant",
    busy: true,
    messages: [
      { id: "system", role: "system", text: "Ready." },
      { id: "assistant", role: "assistant", text: "" },
    ],
    offset: 0,
    renderMode: "raw",
    spinnerFrame: 0,
    viewportHeight: 3,
    width: 80,
  });

  assert.equal(spinnerGlyph(0), "⠋");
  assert.equal(elapsedDots(0), ".");
  assert.equal(view.maxOffset, 2);
  assert.equal(view.offset, 0);
  assert.deepEqual(view.visibleLines.map((line) => line.text), ["Agent", "⠋ thinking .", ""]);

  const topView = buildTranscriptViewModel({
    activeAssistantMessageId: "assistant",
    busy: true,
    messages: [
      { id: "system", role: "system", text: "Ready." },
      { id: "assistant", role: "assistant", text: "" },
    ],
    offset: 999,
    renderMode: "raw",
    spinnerFrame: 0,
    viewportHeight: 3,
    width: 80,
  });
  assert.equal(topView.offset, topView.maxOffset);
  assert.deepEqual(topView.visibleLines.map((line) => line.text), ["System", "Ready.", "Agent"]);
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
  assert.deepEqual(engine.submit("/version"), { kind: "command", command: { kind: "version" } });
  assert.deepEqual(engine.submit("\\/help"), { kind: "prompt", prompt: "/help" });
  assert.deepEqual(engine.submit("  \\/literal slash prompt  "), { kind: "prompt", prompt: "/literal slash prompt" });
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

  assert.equal(engine.handleCommand({ kind: "memory", field: "read", enabled: true }).handled, true);
  assert.equal(engine.snapshot().memoryRead, true);
  assert.equal(engine.handleCommand({ kind: "memory", field: "workspace", enabled: true }).handled, true);
  assert.equal(engine.snapshot().memoryRead, true);
  assert.equal(engine.snapshot().memoryTenantSearch, true);
  assert.equal(engine.handleCommand({ kind: "memory", field: "workspace", enabled: false }).handled, true);
  assert.equal(engine.snapshot().memoryRead, true);
  assert.equal(engine.snapshot().memoryTenantSearch, false);
  assert.equal(engine.handleCommand({ kind: "memory", field: "workspace", enabled: true }).handled, true);
  assert.equal(engine.handleCommand({ kind: "memory", field: "read", enabled: false }).handled, true);
  assert.equal(engine.snapshot().memoryRead, false);
  assert.equal(engine.snapshot().memoryTenantSearch, false);
  assert.equal(engine.handleCommand({ kind: "memory", field: "read", enabled: true }).handled, true);
  assert.equal(engine.handleCommand({ kind: "memory", enabled: false }).handled, true);
  assert.equal(engine.snapshot().memoryRead, false);
  assert.equal(engine.snapshot().memoryTenantSearch, false);

  assert.equal(engine.handleCommand({ kind: "skills", field: "local", enabled: false }).handled, true);
  assert.equal(engine.snapshot().localSkillsEnabled, false);
  assert.equal(engine.handleCommand({ kind: "skills", field: "workspace", enabled: true }).handled, true);
  assert.equal(engine.snapshot().workspaceSkillsEnabled, true);

  assert.equal(engine.handleCommand({ kind: "access", mode: "full" }).handled, true);
  assert.equal(engine.snapshot().accessMode, "full");
  assert.equal(engine.snapshot().contextEnabled, true);

  assert.equal(engine.handleCommand({ kind: "workdir" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /local_shell tool: on/);

  assert.equal(engine.handleCommand({ kind: "transcript" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /Transcript preview/);

  assert.equal(engine.handleCommand({ kind: "version" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /Agent API Workbench/);

  assert.equal(engine.handleCommand({ kind: "copy", target: "page" }).handled, true);
  assert.match(engine.snapshot().messages.at(-1).text, /Clipboard copy is provided by the active renderer/);

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
    type: "local_tool.started",
    name: "local_shell",
    action: "run",
    arguments: { command: "npm test", description: "Run tests" },
  }).effects, []);
  assert.match(engine.snapshot().activities.at(-1).text, /Local shell: Run tests - npm test/);

  assert.deepEqual(engine.handleAgentEvent({
    type: "local_tool.approval_requested",
    name: "local_shell",
    action: "run",
    arguments: { action: "run", command: "pwd", description: "Check directory", cwd: "/tmp/project" },
    callID: "call_local",
    responseID: "resp_local",
  }).effects, []);
  assert.equal(engine.snapshot().pendingLocalTool?.name, "local_shell");
  const pendingToolMessage = engine.snapshot().messages.at(-1);
  assert.equal(pendingToolMessage.kind, "tool");
  assert.match(pendingToolMessage.text, /Local action requires approval/);
  assert.match(pendingToolMessage.text, /Command:\n  pwd/);
  assert.match(pendingToolMessage.text, /Working directory: \/tmp\/project/);

  const largeContent = "x".repeat(10_000);
  assert.deepEqual(engine.handleAgentEvent({
    type: "local_tool.approval_requested",
    name: "local_workdir",
    action: "write",
    arguments: { action: "write", path: "large.txt", content: largeContent },
    callID: "call_large",
    responseID: "resp_large",
  }).effects, []);
  const approvalMessage = engine.snapshot().messages.at(-1).text;
  assert.match(approvalMessage, /"object": "text_summary"/);
  assert.match(approvalMessage, /"bytes": 10000/);
  assert.doesNotMatch(approvalMessage, new RegExp(`x{${largeContent.length}}`));

  assert.deepEqual(engine.handleAgentEvent({
    type: "local_tool.completed",
    name: "local_shell",
    action: "run",
    arguments: { action: "run", command: "printf x", description: "Print a byte" },
    result: { ok: true, action: "run", stdout: "x", stderr: "", exit_code: 0 },
    requiresApproval: false,
  }).effects, []);
  const toolMessage = engine.snapshot().messages.at(-1);
  assert.equal(toolMessage.kind, "tool");
  assert.match(toolMessage.text, /Local execution completed: local_shell\.run/);
  assert.match(toolMessage.text, /Command:\n  printf x/);
  assert.match(toolMessage.text, /"stdout": "x"/);
});

test("workbench local controller loads, summarizes, and searches a workdir", async () => {
  const summarizeCalls = [];
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
    async summarize(options) {
      summarizeCalls.push(options);
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
  assert.deepEqual(summarizeCalls, [
    { maxDepth: 3, maxFiles: 500, maxPreviews: 5, previewBytes: 2048, topPaths: 8 },
    { maxDepth: 3, maxFiles: 500, maxPreviews: 5, previewBytes: 2048, topPaths: 8 },
  ]);
  assert.deepEqual(await controller.searchText("hello"), {
    text: "README.md:2: hello agent",
    count: 1,
  });
  assert.match(controller.approvalPreview({
    name: "local_workdir",
    action: "write",
    arguments: { action: "write", path: "NOTES.md", content: "y".repeat(10_000) },
  }), /"object": "text_summary"/);
  assert.match(controller.approvalPreview({
    name: "local_shell",
    action: "run",
    arguments: { command: "pwd", description: "Check directory" },
  }), /Command:\n  pwd/);
});

test("workbench turn controller runs prompt turns through engine state", async () => {
  const engine = createWorkbenchEngine({
    accessMode: "approval",
    contextEnabled: true,
    conversation: "demo",
    localSkillsEnabled: false,
    memoryRead: true,
    memoryTenantSearch: true,
    model: "provider/model",
    preset: "pro-search",
    workspaceSkillsEnabled: true,
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
  assert.equal(seenOptions[0].discoverLocalSkills, false);
  assert.deepEqual(seenOptions[0].memory, { read: true, tenant_search: true });
  assert.deepEqual(seenOptions[0].skillTool, { tenant_search: true });
  assert.equal(engine.snapshot().busy, false);
  assert.equal(engine.snapshot().activeAssistantMessageId, null);
  assert.equal(engine.snapshot().runs[0].status, "completed");
  assert.equal(engine.snapshot().runs[0].responseId, "resp_turn");
  assert.equal(engine.snapshot().runs[0].conversationName, "demo");
  assert.match(engine.snapshot().activities.at(-1).text, /Agent turn completed: resp_turn/);
  assert.equal(runtimeEffects.some((entry) => Array.isArray(entry.effects) && entry.effects.some((effect) => effect.type === "append_text_delta")), true);
  assert.equal(runtimeEffects.some((entry) => entry.type === "flush"), true);
});

test("workbench turn controller writes in-flight run output to the starting conversation", async () => {
  const store = createMemoryTranscriptStore();
  const engine = createWorkbenchEngine({ contextEnabled: true, transcriptStore: store });
  engine.dispatch({ type: "conversation.set", id: "conv_a", name: "alpha", status: "fresh" });
  const runtime = createWorkbenchRuntimeController({ dispatch: engine.dispatch, flushDelayMs: 1000 });
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer: runtime.flushTextDeltaBuffer,
    getState: engine.snapshot,
    runRuntimeEffects: runtime.runEffects,
    async runAgentTurnImpl(_options, onEvent) {
      engine.dispatch({ type: "conversation.set", id: "conv_b", name: "beta", status: "fresh" });
      onEvent?.({ type: "response.started", responseID: "resp_alpha" });
      onEvent?.({ type: "text.delta", delta: "alpha output" });
      onEvent?.({ type: "response.completed", responseID: "resp_alpha" });
      return { text: "alpha output", responseID: "resp_alpha" };
    },
  });

  await controller.startPrompt("hello alpha");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(engine.snapshot().conversationId, "conv_b");
  assert.equal(engine.snapshot().runs[0].conversationId, "conv_a");
  assert.equal(engine.snapshot().runs[0].status, "completed");
  assert.deepEqual((await store.loadRecentMessages("conv_a", 5)).map((message) => ({
    role: message.role,
    text: message.text,
  })), [
    { role: "user", text: "hello alpha" },
    { role: "assistant", text: "alpha output" },
  ]);
  assert.deepEqual(await store.loadRecentMessages("conv_b", 5), []);
  runtime.dispose();
});

test("workbench turn controller resumes pending work in the source run conversation", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "approval" });
  engine.dispatch({ type: "workspace.set", workspace: { id: "wrk_alpha", name: "Alpha Workspace" } });
  engine.dispatch({ type: "conversation.set", id: "conv_alpha", name: "alpha", status: "fresh" });
  engine.dispatch({
    type: "run.started",
    run: {
      id: "run_alpha",
      assistantMessageId: "assistant_alpha",
      conversationId: "conv_alpha",
      conversationName: "alpha",
      workspaceId: "wrk_alpha",
      workspaceName: "Alpha Workspace",
      status: "paused",
    },
  });
  engine.dispatch({ type: "workspace.set", workspace: { id: "wrk_beta", name: "Beta Workspace" } });
  engine.dispatch({ type: "conversation.set", id: "conv_beta", name: "beta", status: "fresh" });

  const localApprovalOptions = [];
  const automaticContinuationOptions = [];
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {},
    getState: engine.snapshot,
    runRuntimeEffects() {},
    async resumeAgentAfterLocalApprovalImpl(options) {
      localApprovalOptions.push(options);
      return { text: "local done", responseID: "resp_local_done" };
    },
    async resumeAgentAfterAutomaticContinuationImpl(options) {
      automaticContinuationOptions.push(options);
      return { text: "auto done", responseID: "resp_auto_done" };
    },
  });

  await controller.continueAfterLocalApproval({
    sourceRunId: "run_alpha",
    approval: {
      name: "local_shell",
      action: "run",
      arguments: { command: "pwd" },
      callID: "call_alpha",
      responseID: "resp_alpha",
    },
    result: "ok",
    accessMode: "approval",
  });
  await controller.continueAfterAutomaticContinuation({
    sourceRunId: "run_alpha",
    bypassAutomaticContinuationLimit: false,
    continuation: {
      input: [{ type: "function_call_output", call_id: "call_alpha", output: "ok" }],
      previousResponseID: "resp_alpha",
      automaticContinuationCount: 1,
    },
  });

  assert.equal(localApprovalOptions[0].conversation, "alpha");
  assert.equal(localApprovalOptions[0].workspaceId, "wrk_alpha");
  assert.equal(localApprovalOptions[0].workspaceName, "Alpha Workspace");
  assert.equal(automaticContinuationOptions[0].conversation, "alpha");
  assert.equal(automaticContinuationOptions[0].workspaceId, "wrk_alpha");
  assert.equal(automaticContinuationOptions[0].workspaceName, "Alpha Workspace");
  assert.equal(engine.snapshot().conversationId, "conv_beta");
  assert.equal(engine.snapshot().runs[0].conversationId, "conv_alpha");
});

test("workbench turn controller resumes active timed local pauses", async () => {
  const engine = createWorkbenchEngine({ accessMode: "full", contextEnabled: true });
  let resumeMessage;
  let continueRun;
  const runFinished = new Promise((resolve) => {
    continueRun = resolve;
  });
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {},
    getState: engine.snapshot,
    runRuntimeEffects() {},
    async runAgentTurnImpl(options) {
      options.localPause.onPauseStart({
        request: { durationMs: 1000, reason: "wait" },
        resume(message) {
          resumeMessage = message;
          options.localPause.onPauseEnd({
            ok: true,
            tool: "local_pause",
            action: "pause",
            requested_ms: 1000,
            elapsed_ms: 12,
            status: "cancelled",
            reason: "wait",
            resume_message: message,
          });
          continueRun();
        },
      });
      await runFinished;
      return { text: "done", responseID: "resp_pause" };
    },
  });

  const pending = controller.startPrompt("wait for rollout");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.resumeTimedPause("rollout ready"), true);
  await pending;

  assert.equal(resumeMessage, "rollout ready");
  assert.equal(controller.resumeTimedPause("again"), false);
  assert.match(engine.snapshot().activities.at(-1).text, /Agent turn completed: resp_pause/);
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

test("workbench turn controller keeps independent handles for overlapping runs", async () => {
  const engine = createWorkbenchEngine({ accessMode: "approval", contextEnabled: true });
  const releases = new Map();
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {},
    getState: engine.snapshot,
    runRuntimeEffects() {},
    async runAgentTurnImpl(options, onEvent) {
      const prompt = options.promptParts[0];
      onEvent?.({ type: "response.started", responseID: `resp_${prompt}` });
      await new Promise((resolve, reject) => {
        releases.set(prompt, resolve);
        options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: prompt, responseID: `resp_${prompt}` };
    },
  });

  const alpha = controller.startPrompt("alpha");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const beta = controller.startPrompt("beta");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(engine.snapshot().runs.filter((run) => run.status === "running").length, 2);
  releases.get("alpha")();
  await alpha;

  assert.equal(engine.snapshot().runs.find((run) => run.conversationName === "default" && run.responseId === "resp_alpha")?.status, "completed");
  assert.equal(engine.snapshot().busy, true);

  const betaRun = engine.snapshot().runs.find((run) => run.responseId === "resp_beta");
  assert.ok(betaRun);
  await controller.abort("Abort beta.", betaRun.id);
  await beta;

  assert.equal(engine.snapshot().runs.find((run) => run.id === betaRun.id)?.status, "aborted");
  assert.equal(engine.snapshot().busy, false);
});

test("workbench command controller resumes automatic continuation checkpoints", async () => {
  const engine = createWorkbenchEngine({ accessMode: "full", contextEnabled: true });
  let resumedInput;
  const commandController = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: {
      async startNewConversation() {},
      async switchConversation() {},
      async renameConversation() {},
      async deleteConversation() {},
      async listConversations() { return ""; },
      async exportTranscript() { return ""; },
    },
    engine,
    localController: {
      isLoaded() { return true; },
      async summaryText() { return ""; },
      async searchText() { return { text: "", count: 0 }; },
      approvalPreview() { return ""; },
      async applyApproval() { return {}; },
    },
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: {
      clearPresetToolCatalogCache() {},
      configText() { return ""; },
      defaultPresetHelp() { return ""; },
      automaticContinuationLimitHelp() { return ""; },
      async saveDefaultPreset() { return {}; },
      async saveAutomaticContinuationLimit() { return {}; },
      shellIsolationHelp() { return ""; },
      async saveShellIsolationMode() { return {}; },
      isolatorPathHelp() { return ""; },
      async saveIsolatorPath() { return {}; },
      async saveIsolatorSource() { return {}; },
      async validatePreset() { return true; },
      async presetListText() { return ""; },
    },
    turnController: {
      async startPrompt() {},
      async continueAfterLocalApproval() {},
      async continueAfterAutomaticContinuation(input) {
        resumedInput = input;
      },
      async abort() {},
      resumeTimedPause() { return false; },
    },
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });
  engine.dispatch({
    type: "run.started",
    run: {
      id: "run_continuation",
      assistantMessageId: "assistant_continuation",
      conversationName: "default",
      status: "paused",
    },
  });
  engine.dispatch({
    type: "automatic_continuation.pending.set",
    runId: "run_continuation",
    pause: {
      reason: "automatic_continuation_limit",
      message: "Automatic workflow paused.",
      continuation: {
        input: [{ type: "function_call_output", call_id: "call_local", output: "ok" }],
        previousResponseID: "resp_local",
        automaticContinuationCount: 8,
      },
      count: 8,
      limit: 8,
      responseID: "resp_local",
    },
  });

  await commandController.run({ kind: "apply_all" });

  assert.equal(engine.snapshot().pendingAutomaticContinuation, null);
  assert.equal(engine.snapshot().automaticContinuationUnlocked, true);
  assert.equal(resumedInput.bypassAutomaticContinuationLimit, true);
  assert.equal(resumedInput.continuation.previousResponseID, "resp_local");
  assert.equal(engine.snapshot().runs.find((run) => run.id === "run_continuation")?.status, "completed");
  assert.equal(engine.snapshot().runs.find((run) => run.id === "run_continuation")?.statusText, "automatic continuation resumed");
});

test("workbench turn controller uses unlocked automatic continuation limit for later turns", async () => {
  const engine = createWorkbenchEngine({ accessMode: "full", contextEnabled: true });
  engine.dispatch({ type: "settings.set", settings: { automaticContinuationLimit: 8 } });
  engine.dispatch({ type: "automatic_continuation.unlock", unlocked: true });
  const seenOptions = [];
  const controller = createWorkbenchTurnController({
    baseOptions: { promptParts: [], profile: "default" },
    dispatch: engine.dispatch,
    engine,
    flushTextDeltaBuffer() {},
    getState: engine.snapshot,
    runRuntimeEffects() {},
    async runAgentTurnImpl(options) {
      seenOptions.push(options);
      return { text: "done", responseID: "resp_done" };
    },
  });

  await controller.startPrompt("next task");

  assert.equal(seenOptions[0].automaticContinuationLimit, Number.MAX_SAFE_INTEGER);
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

test("workbench engine owns pending automatic continuation input policy", () => {
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "full" });
  engine.dispatch({
    type: "automatic_continuation.pending.set",
    pause: {
      reason: "automatic_continuation_limit",
      message: "Automatic workflow paused.",
      continuation: {
        input: [{ type: "function_call_output", call_id: "call_local", output: "ok" }],
        previousResponseID: "resp_local",
        automaticContinuationCount: 8,
      },
      count: 8,
      limit: 8,
      responseID: "resp_local",
    },
  });

  assert.deepEqual(engine.submit("continue"), { kind: "handled" });
  assert.match(engine.snapshot().messages.at(-1).text, /Automatic continuation is paused/);
  assert.equal(engine.snapshot().pendingAutomaticContinuation?.responseID, "resp_local");

  assert.deepEqual(engine.submit("/apply"), { kind: "command", command: { kind: "apply" } });

  engine.dispatch({
    type: "automatic_continuation.pending.set",
    pause: {
      reason: "automatic_continuation_limit",
      message: "Automatic workflow paused.",
      continuation: {
        input: [{ type: "function_call_output", call_id: "call_local", output: "ok" }],
        previousResponseID: "resp_local",
        automaticContinuationCount: 8,
      },
      count: 8,
      limit: 8,
      responseID: "resp_local",
    },
  });
  engine.submit("bad one");
  engine.submit("bad two");
  engine.submit("bad three");

  assert.equal(engine.snapshot().pendingAutomaticContinuation, null);
  assert.match(engine.snapshot().messages.at(-1).text, /Automatic continuation stopped/);
});

test("workbench engine owns pending CLI update input policy", () => {
  const engine = createWorkbenchEngine({ contextEnabled: false, accessMode: "off" });
  engine.dispatch({
    type: "update.pending.set",
    result: {
      current: "0.4.10",
      latest: "0.4.11",
      packageName: "@agent-api/cli",
      updateAvailable: true,
    },
  });

  assert.deepEqual(engine.submit("install it"), { kind: "handled" });
  assert.match(engine.snapshot().messages.at(-1).text, /CLI update is ready/);
  assert.equal(engine.snapshot().pendingUpdate?.result.latest, "0.4.11");

  assert.deepEqual(engine.submit("/apply"), { kind: "command", command: { kind: "apply" } });

  engine.dispatch({
    type: "update.pending.set",
    result: {
      current: "0.4.10",
      latest: "0.4.11",
      packageName: "@agent-api/cli",
      updateAvailable: true,
    },
  });
  engine.submit("bad one");
  engine.submit("bad two");
  engine.submit("bad three");

  assert.equal(engine.snapshot().pendingUpdate, null);
  assert.match(engine.snapshot().messages.at(-1).text, /update canceled/);
});

test("app engine runtime accepts injected storage", async () => {
  const storage = createMemoryStorage();
  configureAgentAppRuntime({ appName: "storage-test", legacyAppName: null, storage });
  try {
    await loginWithAPIKey({ profile: "memory", baseURL: "https://api.test", apiKey: "sk-memory" });
    const config = await loadConfig();
    assert.equal(config.activeProfile, "memory");
    assert.equal(config.profiles.memory.baseURL, "https://api.test");
    assert.equal(await storage.get("profiles.json", "activeProfile"), "memory");
  } finally {
    configureAgentAppRuntime();
  }
});

test("workspace listing accepts gateway id payloads", async () => {
  const storage = createMemoryStorage();
  const originalFetch = globalThis.fetch;
  configureAgentAppRuntime({ appName: "workspace-list-test", legacyAppName: null, storage });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.test/v1/workspaces");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-workspaces");
    return new Response(JSON.stringify({
      object: "list",
      data: [
        {
          id: "wrk_gateway",
          name: "Gateway Workspace",
          role: "owner",
          status: "active",
          membership_status: "active",
        },
        {
          workspace_id: "wrk_legacy",
          name: "Legacy Workspace",
          role: "member",
          status: "active",
          membership_status: "active",
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await loginWithAPIKey({ profile: "workspaces", baseURL: "https://api.test", apiKey: "sk-workspaces" });
    const workspaces = await listProfileWorkspaces("workspaces");
    assert.deepEqual(workspaces.map((workspace) => workspace.id), ["wrk_gateway", "wrk_legacy"]);
    assert.deepEqual(workspaces.map((workspace) => workspace.name), ["Gateway Workspace", "Legacy Workspace"]);
  } finally {
    globalThis.fetch = originalFetch;
    configureAgentAppRuntime();
  }
});

test("storage adapters support memory, sql, key-value, and keychain documents", async () => {
  const memory = createMemoryStorage();
  await memory.write("settings.json", { theme: "dark" });
  await memory.set("settings.json", "density", "compact");
  assert.deepEqual(await memory.read("settings.json"), { theme: "dark", density: "compact" });

  const sqlRows = new Map();
  const postgres = createPostgresStorage({
    async query(sql, params = []) {
      if (/^SELECT/i.test(sql)) {
        const value = sqlRows.get(params[0]);
        return { rows: value ? [{ value }] : [] };
      }
      if (/^INSERT/i.test(sql)) {
        sqlRows.set(params[0], params[1]);
      }
      return { rows: [] };
    },
  });
  await postgres.write("settings.json", { theme: "light" });
  assert.deepEqual(await postgres.read("settings.json"), { theme: "light" });

  const mysqlRows = new Map();
  const mysql = createMySQLStorage({
    async execute(sql, params = []) {
      if (/^SELECT/i.test(sql)) {
        const value = mysqlRows.get(params[0]);
        return [value ? [{ value }] : [], []];
      }
      if (/^INSERT/i.test(sql)) {
        mysqlRows.set(params[0], params[1]);
      }
      return [[], []];
    },
  });
  await mysql.write("settings.json", { mysql: true });
  assert.deepEqual(await mysql.read("settings.json"), { mysql: true });

  const sqliteRows = new Map();
  const sqlite = createSQLiteStorage({
    async run(sql, params = []) {
      if (/^INSERT/i.test(sql)) sqliteRows.set(params[0], params[1]);
    },
    async get(_sql, params = []) {
      const value = sqliteRows.get(params[0]);
      return value ? { value } : undefined;
    },
  });
  await sqlite.write("settings.json", { local: true });
  assert.deepEqual(await sqlite.read("settings.json"), { local: true });

  const kvRows = new Map();
  const kv = createKeyValueStorage({
    client: {
      async get(key) { return kvRows.get(key); },
      async set(key, value) { kvRows.set(key, value); },
      async del(key) { kvRows.delete(key); },
    },
  });
  await kv.write("settings.json", { cache: "redis-compatible" });
  assert.deepEqual(await kv.read("settings.json"), { cache: "redis-compatible" });

  const secrets = new Map();
  const keychain = createKeychainStorage({
    keychain: {
      async getPassword(service, account) { return secrets.get(`${service}:${account}`) ?? null; },
      async setPassword(service, account, password) { secrets.set(`${service}:${account}`, password); },
      async deletePassword(service, account) { return secrets.delete(`${service}:${account}`); },
    },
  });
  await keychain.write("profiles.json", { activeProfile: "secure" });
  assert.deepEqual(await keychain.read("profiles.json"), { activeProfile: "secure" });
});
