import {
  bindLineDelimitedAgentEngineRpcHandler,
  createAgentEngineRpcHandler,
  createInProcessAgentEngineClient,
  currentAgentAppRuntime,
  loadWorkbenchPreferences,
  normalizeChatOptions,
  type ChatOptions,
} from "@agent-api/app-engine/core";
import { createWorkbenchAuthController, type LocalKnowledgeService } from "@agent-api/app-engine/workbench";
import path from "node:path";
import { createSQLiteLocalKnowledgeStore } from "./tui/local-knowledge-store.js";
import { createDefaultTranscriptStore } from "./tui/transcript-store.js";

export interface EngineHostOptions extends ChatOptions {
  profile?: string;
}

export async function startEngineHost(options: EngineHostOptions = {}) {
  const localKnowledge = await safeLocalKnowledgeStore();
  const transcriptStore = safeTranscriptStore(localKnowledge ?? undefined);
  const baseOptions = {
    ...normalizeChatOptions([], options),
    localKnowledgeEnabled: Boolean(localKnowledge),
  };
  const client = createInProcessAgentEngineClient({
    authController: createWorkbenchAuthController(),
    baseOptions,
    profileName: options.profile || "default",
    services: {
      ...(transcriptStore ? { transcriptStore } : {}),
      ...(localKnowledge ? { localKnowledge } : {}),
    },
    async onDeleteProfile() {},
    onExit() {
      process.exitCode = 0;
      process.stdin.pause();
    },
    onLogin() {},
    onLogout() {},
    onSwitchProfile() {},
  });
  const handler = createAgentEngineRpcHandler(client);
  const connection = bindLineDelimitedAgentEngineRpcHandler(handler, {
    input: process.stdin,
    output: process.stdout,
    onError(error) {
      process.stderr.write(`${error.message}\n`);
    },
  });

  let disposed = false;
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.stdin.resume();

  function shutdown() {
    if (disposed) return;
    disposed = true;
    connection.dispose();
    client.dispose();
    process.exitCode = 0;
    process.stdin.pause();
  }

  return {
    dispose: shutdown,
  };
}

async function safeLocalKnowledgeStore() {
  try {
    const preferences = await loadWorkbenchPreferences();
    if (preferences.localKnowledgeEnabled === false) return null;
    const dataDir = currentAgentAppRuntime().runtime.dirs.data;
    return createSQLiteLocalKnowledgeStore(path.join(dataDir, "local-knowledge.sqlite3"));
  } catch {
    return null;
  }
}

function safeTranscriptStore(localKnowledge?: LocalKnowledgeService) {
  try {
    return createDefaultTranscriptStore({ localKnowledge });
  } catch {
    return null;
  }
}
