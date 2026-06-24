import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  agentResponseFailureMessage,
  agentTurnEventFromStreamEvent,
  clearPresetToolCatalogCache,
  compareVersions,
  configureAgentAppRuntime,
  createAgentEngine,
  formatUpdateNotice,
  loadConfig,
  loginWithAPIKey,
  localToolExecutionErrorResult,
  normalizeChatOptions,
  resolveAgentRequestTools,
} from "@agent-api/app-engine/core";
import {
  authStatusText,
  createConversationName,
  createInputHistory,
  createInitialWorkbenchState,
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
  installConfiguredIsolator,
  localShellIsolationOptions,
  localShellIsolationOptions as localShellIsolationOptionsFromBoundary,
  parsePendingApprovalCommand,
  parseWorkbenchCommand,
  sessionState,
  UnknownPresetError,
  updateNoticeEffects,
  workbenchReducer,
} from "@agent-api/app-engine/workbench";
import {
  buildTranscriptLines,
  buildTranscriptViewModel,
  buildWorkbenchRenderModel,
  createWorkbenchInputController,
  elapsedDots,
  pendingLocalLabel,
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
    async listConversations() {
      return "No conversations.";
    },
    async exportTranscript() {
      return "/tmp/transcript.txt";
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
    async saveShellIsolationMode() { return { shellIsolation: { mode: "auto" }, message: "saved", activity: "saved" }; },
    async saveIsolatorPath() { return { shellIsolation: { executablePath: "/opt/agent-isolator" }, message: "saved", activity: "saved" }; },
    async saveIsolatorSource() { return { shellIsolation: { sourceURL: "https://example.test/agent-isolator" }, message: "saved", activity: "saved" }; },
    async validatePreset() { return true; },
    async presetListText(input) { return input.prefix; },
    configText() { return "config"; },
    defaultPresetHelp() { return "default preset help"; },
    shellIsolationHelp() { return "shell isolation help"; },
    isolatorPathHelp() { return "isolator path help"; },
    clearPresetToolCatalogCache() {},
  };
}

function stubTurnController() {
  return {
    async startPrompt() {},
    async continueAfterLocalApproval() {},
    async abort() {},
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
    },
    async onDeleteProfile() {},
    onExit() {
      exited = true;
    },
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

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

test("agent conversation manager lists, shows, and deletes local conversation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-api-cli-test-"));
  const env = isolatedEnv(root);

  await execFileAsync("node", [bin, "auth", "login", "--profile", "test", "--api-key", "sk-test-abcdefghijklmnopqrstuvwxyz", "--base-url", "https://api.test"], { env });

  const configDir = join(root, ".config", "agent-tui");
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

  const configDir = join(root, ".config", "agent-tui");
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
    "import { updateWorkbenchPreferences } from '@agent-api/app-engine/core'; await updateWorkbenchPreferences({ defaultPreset: 'pro-search', isolation: { mode: 'required', executablePath: '/opt/agent-isolator' } });",
  ], { cwd: new URL("..", import.meta.url).pathname, env });

  const updatedProfiles = JSON.parse(await readFile(profilesPath, "utf8"));
  const appConfig = JSON.parse(await readFile(appConfigPath, "utf8"));
  const conversationConfig = JSON.parse(await readFile(conversationsPath, "utf8"));
  assert.equal(updatedProfiles.workbench, undefined);
  assert.equal(updatedProfiles.conversations, undefined);
  assert.deepEqual(appConfig.workbench, {
    defaultPreset: "pro-search",
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
  const legacyConfigDir = join(root, ".config", "agent-api-cli");
  const configDir = join(root, ".config", "agent-tui");
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
  assert.deepEqual(parseWorkbenchCommand("/config isolation required"), { kind: "config", field: "isolation", value: "required" });
  assert.deepEqual(parseWorkbenchCommand("/config isolator /opt/agent-isolator"), { kind: "config", field: "isolator", value: "/opt/agent-isolator" });
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
  const injectedInput = createWorkbenchInputController();
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
      input: injectedInput,
      local: injectedLocal,
      settings: injectedSettings,
    },
  });

  assert.equal(sessionState(session).currentConversation, "demo");
  assert.equal(sessionState(session).contextEnabled, true);
  session.engine.dispatch({ type: "message.add", role: "user", text: "hello" });
  assert.equal(sessionState(session).messages.at(-1).text, "hello");
  assert.equal(typeof session.input.handle, "function");
  assert.equal(typeof session.lifecycle.initialPrompt, "function");
  assert.equal(session.conversation, injectedConversation);
  assert.equal(session.input, injectedInput);
  assert.equal(session.local, injectedLocal);
  assert.equal(session.settings, injectedSettings);
  assert.equal(typeof session.runtime.runEffects, "function");
  assert.equal(typeof session.turn.startPrompt, "function");
});

test("workbench runtime controller buffers and flushes text deltas", () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  engine.dispatch({ type: "message.add", role: "assistant", id: "assistant-test", text: "" });
  const runtime = createWorkbenchRuntimeController({ dispatch: engine.dispatch, flushDelayMs: 1000 });

  runtime.runEffects([
    { type: "append_text_delta", delta: "hel" },
    { type: "append_text_delta", delta: "lo" },
  ], "assistant-test");
  assert.equal(engine.snapshot().messages.at(-1).text, "");

  runtime.flushTextDeltaBuffer();
  assert.equal(engine.snapshot().messages.at(-1).text, "hello");
  runtime.dispose();
});

test("workbench command controller applies renderer-neutral preset commands", async () => {
  const engine = createWorkbenchEngine({ contextEnabled: false });
  const controller = createWorkbenchCommandController({
    authController: stubAuthController(),
    conversationController: stubConversationController(),
    engine,
    localController: stubLocalController(),
    options: { promptParts: [], profile: "default" },
    profileName: "default",
    settingsController: {
      async loadInitial() { return {}; },
      async saveDefaultPreset() { throw new Error("not used"); },
      async saveShellIsolationMode() { throw new Error("not used"); },
      async saveIsolatorPath() { throw new Error("not used"); },
      async saveIsolatorSource() { throw new Error("not used"); },
      async validatePreset(_profile, preset) { return preset === "analysis"; },
      async presetListText(input) { return `${input.prefix}\n- analysis`; },
      configText() { return "config"; },
      defaultPresetHelp() { return "default preset help"; },
      shellIsolationHelp() { return "shell isolation help"; },
      isolatorPathHelp() { return "isolator path help"; },
      clearPresetToolCatalogCache() {},
    },
    turnController: stubTurnController(),
    async onDeleteProfile() {},
    onExit() {},
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });

  await controller.run({ kind: "preset", value: "analysis" });
  assert.equal(engine.snapshot().runPreset, "analysis");
  assert.match(engine.snapshot().messages.at(-1).text, /Preset set to analysis/);

  await controller.run({ kind: "preset", value: "missing" });
  assert.equal(engine.snapshot().runPreset, "analysis");
  assert.match(engine.snapshot().messages.at(-1).text, /Unknown preset: missing/);
});

test("workbench command controller applies pending local approvals", async () => {
  const continuations = [];
  const engine = createWorkbenchEngine({ contextEnabled: true, accessMode: "approval" });
  engine.dispatch({
    type: "local_tool.pending.set",
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
  assert.equal(model.input.beforeCursor, "he");
  assert.equal(model.input.cursorText, "l");
  assert.equal(model.input.afterCursor, "lo");
  assert.equal(model.layout, "wide");
  assert.equal(model.viewportHeight, 19);
  assert.ok(model.transcript.visibleLines.length > 0);
  assert.match(model.footerText, /live/);
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

test("workbench render model scrolls long input around the cursor", () => {
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
  assert.equal(model.input.cursorText, " ");
  assert.match(model.input.beforeCursor, /^‹/);
  assert.match(model.input.beforeCursor, /END$/);
  assert.equal(model.input.afterCursor, "");
  assert.ok(model.input.beforeCursor.length + model.input.cursorText.length <= model.input.viewportColumns);
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
    async deleteConversationImpl(name, profile) {
      calls.push(["delete", name, profile]);
    },
    async listConversationsImpl(profile) {
      calls.push(["list", profile]);
      return [
        {
          id: "conv_release",
          name: "release",
          profile: profile || "default",
          previousResponseId: "resp_test",
          createdAt: 4102444700,
          updatedAt: 4102444800,
        },
      ];
    },
    async startFreshConversationImpl(name, profile) {
      calls.push(["fresh", name, profile]);
      return {
        id: "conv_new",
        name,
        profile,
        createdAt: 1782131696,
        updatedAt: 1782131696,
      };
    },
    async ensureConversationImpl(name, profile) {
      calls.push(["ensure", name, profile]);
      return {
        id: "conv_release",
        name,
        profile,
        previousResponseId: "resp_test",
        createdAt: 4102444700,
        updatedAt: 4102444800,
      };
    },
  });

  assert.deepEqual(await controller.startNewConversation(undefined, "dev"), {
    id: "conv_new",
    name: "thread-20260622-123456",
    status: "fresh",
    message: 'Started fresh conversation "thread-20260622-123456" (conv_new).',
  });
  assert.deepEqual(await controller.switchConversation("release", "dev"), {
    id: "conv_release",
    name: "release",
    previousResponseId: "resp_test",
    status: "continued",
    message: 'Switched to conversation "release" (conv_release). Continuing from resp_test.',
  });
  assert.match(await controller.listConversations("dev"), /release\tdev\t2100-01-01T00:00:00\.000Z\tconv_release response=resp_test/);

  const exported = await controller.exportTranscript({
    conversation: "release notes",
    transcript: "System:\nReady.\n",
  });
  assert.equal(exported, join(root, "transcripts", "release-notes-2026-06-22T12-34-56-000Z.txt"));
  assert.equal(await readFile(exported, "utf8"), "System:\nReady.\n");
  assert.deepEqual(calls, [
    ["delete", "thread-20260622-123456", "dev"],
    ["fresh", "thread-20260622-123456", "dev"],
    ["ensure", "release", "dev"],
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
  result = apply(controller.handle("", { delete: true }, context()));
  assert.equal(draft, "h");
  assert.equal(cursor, 1);
  result = apply(controller.handle("", { home: true }, context()));
  assert.equal(cursor, 0);
  result = apply(controller.handle("s", {}, context()));
  assert.equal(draft, "sh");
  result = apply(controller.handle("", { end: true }, context()));
  assert.equal(cursor, 2);
  result = apply(controller.handle("i", {}, context()));
  assert.equal(draft, "shi");

  result = apply(controller.handle("", { return: true }, context()));
  assert.deepEqual(result.effects, [{ type: "submit", input: "shi" }]);
  assert.equal(draft, "");
  assert.equal(cursor, 0);

  result = apply(controller.handle("", { upArrow: true }, context()));
  assert.equal(draft, "shi");
  assert.equal(cursor, 3);
  result = apply(controller.handle("", { downArrow: true }, context()));
  assert.equal(draft, "");
  assert.equal(cursor, 0);
});

test("workbench input controller maps navigation and busy abort policy", () => {
  const controller = createWorkbenchInputController();

  assert.deepEqual(controller.handle("", { pageUp: true }, { busy: false, draft: "", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "scroll", delta: 5 }],
  });
  assert.deepEqual(controller.handle("", { pageDown: true }, { busy: false, draft: "", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "scroll", delta: -5 }],
  });
  assert.deepEqual(controller.handle("", { home: true }, { busy: false, cursor: 2, draft: "abcd", viewportHeight: 11 }), {
    cursor: 0,
    draft: "abcd",
    effects: [],
  });
  assert.deepEqual(controller.handle("", { end: true }, { busy: false, cursor: 2, draft: "abcd", viewportHeight: 11 }), {
    cursor: 4,
    draft: "abcd",
    effects: [],
  });
  assert.deepEqual(controller.handle("", { delete: true }, { busy: false, cursor: 4, draft: "abcd", viewportHeight: 11 }), {
    cursor: 3,
    draft: "abc",
    effects: [],
  });
  assert.deepEqual(controller.handle("c", { ctrl: true }, { busy: false, draft: "", viewportHeight: 11 }).effects, [{ type: "exit" }]);

  assert.deepEqual(controller.handle("", { escape: true }, { busy: true, draft: "ignored", viewportHeight: 11 }), {
    cursor: 7,
    draft: "ignored",
    effects: [{ type: "abort" }],
  });
  assert.deepEqual(controller.handle("", { return: true }, { busy: true, draft: "/abort", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "abort" }],
  });
  assert.deepEqual(controller.handle("", { return: true }, { busy: true, draft: "hello", viewportHeight: 11 }), {
    cursor: 0,
    draft: "",
    effects: [{ type: "ignored_busy" }],
  });
});

test("workbench transcript formatter produces readable plain text", () => {
  assert.equal(formatTranscript([
    { id: "1", role: "system", text: "Ready." },
    { id: "2", role: "user", text: "Hello" },
    { id: "3", role: "assistant", text: "Hi there\n" },
  ]), "System:\nReady.\n\nYou:\nHello\n\nAgent:\nHi there\n");
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
