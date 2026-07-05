#!/usr/bin/env node

import { Command, Option } from "commander";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { render } from "ink";
import React from "react";
import {
  activeProfile,
  configureAgentAppRuntime,
  conversationSummary,
  deleteConversation,
  deleteProfile,
  checkForUpdate,
  formatUpdateNotice,
  getConversation,
  installUpdate,
  listConversations,
  listProfiles,
  loadConfig,
  loadConversationConfiguration,
  loginWithAPIKey,
  loginWithBrowser,
  normalizeChatOptions,
  openWorkdir,
  profileSummary,
  redactSecret,
  resolveRuntimeProfile,
  runAgent,
  runtime,
  type ChatOptions,
  useProfile,
} from "@agent-api/app-engine/core";
import { ChatApp } from "./tui/chat.js";
import { startEngineHost } from "./engine-host.js";
import { cliAuthor, cliName, cliVersion, legacyCliName } from "./runtime.js";

configureAgentAppRuntime({
  appName: cliName,
  appAuthor: cliAuthor,
  appVersion: cliVersion,
  legacyAppName: legacyCliName,
});

type GlobalOptions = {
  profile?: string;
};

type RootOptions = {
  update?: boolean;
  workdir?: string;
};

const program = new Command();

program
  .name("agent-api")
  .alias("agentsway")
  .alias("agent-tui")
  .description("First-class command line interface for Agent API")
  .option("-w, --workdir <path>", "shortcut for run with a local workdir")
  .option("--update", "check for and install a CLI update, then exit")
  .version(cliVersion)
  .showHelpAfterError()
  .showSuggestionAfterError()
  .addHelpText("after", `
Command contract:
  No command defaults to "run". A bare first argument is always a command.
  Use "run [workdir]" or "-w, --workdir <path>" to open a local workdir.

Examples:
  $ agent-tui
  $ agent-tui -w .
  $ agent-tui run .
  $ agent-tui update
  $ agent-tui agent chat "Summarize this repo" --workdir .
`);

program.action(async (options: RootOptions) => {
  if (options.update) {
    await runTopLevelUpdate({ checkOnly: false });
    return;
  }
  await runWorkbench(options);
});

program
  .command("run")
  .description("Open the interactive workbench")
  .argument("[workdir]", "local workdir to open and expose to the agent")
  .addHelpText("after", `
Examples:
  $ agent-tui run
  $ agent-tui run .
  $ agent-tui -w .
`)
  .action(async function (this: Command, workdir: string | undefined) {
    const rootOptions = this.parent?.opts<RootOptions>() ?? {};
    await runWorkbench({ workdir: resolveRunWorkdir(workdir, rootOptions.workdir) });
  });

program
  .command("update")
  .description("Check for and install a CLI update")
  .addHelpText("after", `
Checks npm for the latest ${cliName} package and installs it globally when an
update is available. Equivalent shortcut: agent-tui --update
`)
  .action(async () => {
    await runTopLevelUpdate({ checkOnly: false });
  });

program
  .command("version")
  .description("Print the CLI version")
  .action(() => {
    console.log(cliVersion);
  });

program
  .command("auth")
  .description("Manage authentication")
  .addCommand(authLoginCommand())
  .addCommand(authWhoamiCommand())
  .addCommand(authLogoutCommand());

program
  .command("profiles")
  .alias("profile")
  .description("Manage local auth profiles")
  .addCommand(profilesListCommand())
  .addCommand(profilesUseCommand())
  .addCommand(profilesShowCommand())
  .addCommand(profilesDeleteCommand());

program
  .command("agent")
  .description("Chat with and manage remote agent conversations")
  .addCommand(agentChatCommand())
  .addCommand(agentListCommand())
  .addCommand(agentShowCommand())
  .addCommand(agentDeleteCommand());

program
  .command("workdir")
  .alias("ws")
  .description("Inspect and package local workdir context")
  .addCommand(workdirStatusCommand())
  .addCommand(workdirSummaryCommand())
  .addCommand(workdirContextCommand());

program
  .command("doctor")
  .description("Print local CLI diagnostics")
  .action(async () => {
    const config = await loadConfig();
    const conversations = await loadConversationConfiguration();
    const { profiles } = await listProfiles();
    console.log(JSON.stringify({
      version: cliVersion,
      activeProfile: config.activeProfile,
      profileCount: profiles.length,
      conversationCount: Object.keys(conversations.conversations).length,
      configDir: runtime.dirs.config,
      dataDir: runtime.dirs.data,
      node: process.version,
      platform: process.platform,
    }, null, 2));
  });

program
  .command("engine")
  .description("Low-level app-engine integration commands")
  .addCommand(engineHostCommand());

program.addHelpCommand("help [command]", "Display help for command");
program.exitOverride();

program.parseAsync(process.argv).catch((error) => {
  if (error?.code === "commander.helpDisplayed" || error?.code === "commander.version") return;
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function clearTerminalAfterTUI() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

async function runWorkbench(options: { workdir?: string }) {
  const launchWorkdir = options.workdir ? await validateLaunchWorkdir(options.workdir) : undefined;
  if (!process.stdin.isTTY) {
    program.help();
    return;
  }
  const chatOptions = normalizeChatOptions([], launchWorkdir ? { workdir: launchWorkdir } : {});
  const app = render(React.createElement(ChatApp, { options: chatOptions }));
  await app.waitUntilExit();
  clearTerminalAfterTUI();
}

function resolveRunWorkdir(positional?: string, option?: string) {
  if (positional && option) throw new Error("Use either run [workdir] or -w/--workdir, not both.");
  return option || positional;
}

async function runTopLevelUpdate(options: { checkOnly: boolean }) {
  const result = await checkForUpdate({ timeoutMs: 5_000 });
  if (!result) {
    console.error("Could not check for a CLI update right now.");
    process.exitCode = 1;
    return;
  }
  if (!result.updateAvailable) {
    console.log(`${result.packageName} is already up to date (${result.current}).`);
    return;
  }
  if (options.checkOnly) {
    console.log(formatUpdateNotice(result));
    return;
  }
  console.log(formatUpdateNotice(result));
  console.log("Installing update...");
  const installed = await installUpdate(result);
  console.log(`Updated ${result.packageName}: ${result.current} -> ${result.latest}.`);
  if (installed.output) console.log(installed.output);
}

function authLoginCommand() {
  return new Command("login")
    .description("Sign in with browser auth or save an API key profile")
    .option("-p, --profile <name>", "profile name", "default")
    .option("--base-url <url>", "Agent API base URL")
    .option("--api-key <key>", "API key; defaults to AGENT_API_KEY")
    .option("--no-browser", "print browser URL without opening it")
    .option("--client-name <name>", "device auth client name", "Agent API CLI")
    .action(async (options) => {
      const apiKey = options.apiKey || process.env.AGENT_API_KEY;
      if (apiKey) {
        const saved = await loginWithAPIKey({ profile: options.profile, baseURL: options.baseUrl, apiKey });
        console.log(`Saved API key profile "${saved.name}" (${saved.baseURL}).`);
        return;
      }
      await loginWithBrowser({
        profile: options.profile,
        baseURL: options.baseUrl,
        openBrowser: options.browser,
        clientName: options.clientName,
      });
    });
}

function engineHostCommand() {
  return new Command("host")
    .description("Run an Agent Engine Protocol host over newline-delimited JSON on stdio")
    .option("-p, --profile <name>", "profile name")
    .option("-w, --workdir <path>", "local workdir to open and expose to the agent")
    .option("--conversation <name>", "conversation name", "default")
    .option("--preset <name>", "agent preset")
    .option("--model <name>", "model name")
    .option("--access <mode>", "local workdir access mode: off, approval, or full")
    .action(async (options) => {
      startEngineHost({
        profile: options.profile,
        workdir: options.workdir ? await validateLaunchWorkdir(options.workdir) : undefined,
        conversation: options.conversation,
        preset: options.preset,
        model: options.model,
        access: options.access,
      });
    });
}

function authWhoamiCommand() {
  return new Command("whoami")
    .alias("status")
    .description("Show the authenticated account for a profile")
    .option("-p, --profile <name>", "profile name")
    .action(async (options: GlobalOptions) => {
      const runtime = await resolveRuntimeProfile(options.profile);
      const response = await fetch(`${runtime.profile.baseURL}/v1/me`, {
        headers: { Authorization: `Bearer ${runtime.token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `whoami failed with ${response.status}`);
      console.log(JSON.stringify({ profile: runtime.profile.name, ...payload }, null, 2));
    });
}

function authLogoutCommand() {
  return new Command("logout")
    .description("Delete a local auth profile")
    .option("-p, --profile <name>", "profile name")
    .action(async (options: GlobalOptions) => {
      const profile = options.profile || (await loadConfig()).activeProfile;
      await deleteProfile(profile);
      console.log(`Deleted profile "${profile}".`);
    });
}

function profilesListCommand() {
  return new Command("list")
    .description("List local auth profiles")
    .action(async () => {
      const { active, profiles } = await listProfiles();
      if (profiles.length === 0) {
        console.log("No profiles configured. Run agent-api auth login.");
        return;
      }
      for (const profile of profiles) {
        console.log(profileSummary(profile, profile.name === active));
      }
    });
}

function profilesUseCommand() {
  return new Command("use")
    .description("Set the active profile")
    .argument("<name>", "profile name")
    .action(async (name: string) => {
      await useProfile(name);
      console.log(`Active profile: ${name}`);
    });
}

function profilesShowCommand() {
  return new Command("show")
    .description("Show a profile without secrets")
    .argument("[name]", "profile name")
    .action(async (name?: string) => {
      const profile = await activeProfile(name);
      console.log(JSON.stringify({
        name: profile.name,
        baseURL: profile.baseURL,
        auth: profile.auth.type === "api_key"
          ? { type: "api_key", apiKey: redactSecret(profile.auth.apiKey) }
          : {
              type: "browser",
              accessToken: redactSecret(profile.auth.accessToken),
              accessTokenExpiresAt: profile.auth.accessTokenExpiresAt,
              refreshTokenExpiresAt: profile.auth.refreshTokenExpiresAt,
            },
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      }, null, 2));
    });
}

function profilesDeleteCommand() {
  return new Command("delete")
    .alias("rm")
    .description("Delete a local auth profile")
    .argument("<name>", "profile name")
    .action(async (name: string) => {
      await deleteProfile(name);
      console.log(`Deleted profile "${name}".`);
    });
}

function agentChatCommand() {
  return new Command("chat")
    .description("Start an interactive chat, or send one message when prompt text is provided")
    .argument("[prompt...]", "prompt text")
    .option("-p, --profile <name>", "profile name")
    .option("-c, --conversation <name>", "conversation name")
    .option("--preset <name>", "agent preset")
    .option("--model <name>", "explicit model")
    .option("--file <path>", "read prompt text from file")
    .option("--stdin", "read prompt text from stdin")
    .option("--workdir <path>", "attach local workdir context")
    .option("--local-context", "attach current directory context")
    .option("--context-query <text>", "include local search matches in context")
    .option("--max-context-files <n>", "local context file limit")
    .option("--max-context-bytes <n>", "local context byte limit")
    .option("--local-skill <path...>", "load one or more local skill directories")
    .option("--no-local-skills", "disable automatic local SKILL.md discovery for workdir runs")
    .option("--workspace-skills", "allow model-facing skill discovery to search workspace skills")
    .option("--memory", "enable memory read/prefetch")
    .option("--memory-read", "enable memory read/prefetch")
    .option("--memory-write", "enable memory writes")
    .option("--memory-tenant-search", "allow memory search across the workspace/user scope")
    .option("--automatic-continuation-limit <n>", "pause automatic agent continuations after this many calls; use unlimited to disable")
    .option("--access <mode>", "local tool access mode: off, approval, or full")
    .option("--restart", "start the conversation from a fresh response")
    .addOption(new Option("--no-stream", "wait for final response instead of streaming"))
    .action(async (prompt: string[], options: ChatOptions) => {
      const promptParts = prompt ?? [];
      const hasOneShotInput = promptParts.length > 0 || options.file || options.stdin;
      const normalized = normalizeChatOptions(promptParts, options);
      const shouldUseWorkbench = process.stdin.isTTY && (
        !hasOneShotInput ||
        Boolean(normalized.workdir && normalized.accessMode === "approval" && promptParts.length > 0 && !options.file && !options.stdin)
      );
      if (shouldUseWorkbench) {
        const app = render(React.createElement(ChatApp, { options: normalized }));
        await app.waitUntilExit();
        return;
      }
      await runAgent(normalized);
    });
}

function agentListCommand() {
  return new Command("list")
    .alias("conversations")
    .description("List local conversation handles")
    .option("-p, --profile <name>", "profile name")
    .action(async (options: GlobalOptions) => {
      const conversations = await listConversations(options.profile);
      if (conversations.length === 0) {
        console.log("No agent conversations yet.");
        return;
      }
      for (const conversation of conversations) console.log(conversationSummary(conversation));
    });
}

function agentShowCommand() {
  return new Command("show")
    .description("Show a local conversation handle")
    .argument("[name]", "conversation name", "default")
    .option("-p, --profile <name>", "profile name")
    .action(async (name: string, options: GlobalOptions) => {
      console.log(JSON.stringify(await getConversation(name, options.profile), null, 2));
    });
}

function agentDeleteCommand() {
  return new Command("delete")
    .alias("rm")
    .description("Delete a local conversation handle")
    .argument("<name>", "conversation name")
    .option("-p, --profile <name>", "profile name")
    .action(async (name: string, options: GlobalOptions) => {
      await deleteConversation(name, options.profile);
      console.log(`Deleted conversation "${name}".`);
    });
}

function workdirStatusCommand() {
  return new Command("status")
    .description("Show local workdir status")
    .option("--path <path>", "workdir path", process.cwd())
    .action(async (options: { path: string }) => {
      const workdir = await openWorkdir({ path: options.path });
      const [summary, snapshot] = await Promise.all([
        workdir.summarize(),
        workdir.snapshot(),
      ]);
      console.log(JSON.stringify({
        root: workdir.root,
        name: workdir.name,
        fileCount: summary.file_count,
        totalBytes: summary.total_bytes,
        snapshotFiles: snapshot.files.length,
        scanTruncated: summary.scan_truncated,
      }, null, 2));
    });
}

function workdirSummaryCommand() {
  return new Command("summary")
    .description("Summarize local workdir files")
    .option("--path <path>", "workdir path", process.cwd())
    .action(async (options: { path: string }) => {
      const workdir = await openWorkdir({ path: options.path });
      console.log(JSON.stringify(await workdir.summarize(), null, 2));
    });
}

function workdirContextCommand() {
  return new Command("context")
    .description("Build the local context package that can be sent to the agent")
    .option("--path <path>", "workdir path", process.cwd())
    .option("--query <text>", "include local search matches")
    .option("--max-files <n>", "maximum files to include")
    .option("--max-bytes <n>", "maximum bytes to include")
    .option("--no-content", "omit file contents")
    .action(async (options: {
      path: string;
      query?: string;
      maxFiles?: string;
      maxBytes?: string;
      content?: boolean;
    }) => {
      const workdir = await openWorkdir({ path: options.path });
      const context = await workdir.packageContext({
        query: options.query,
        maxFiles: optionalNumber(options.maxFiles, "--max-files"),
        maxBytes: optionalNumber(options.maxBytes, "--max-bytes"),
        includeContent: options.content !== false,
      });
      console.log(JSON.stringify(context, null, 2));
    });
}

function optionalNumber(value: string | undefined, label: string) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

async function validateLaunchWorkdir(path: string) {
  const resolved = resolve(path);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`Workdir does not exist: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workdir is not a directory: ${path}`);
  }
  return resolved;
}
