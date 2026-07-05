import {
  bindLineDelimitedAgentEngineRpcHandler,
  createAgentEngineRpcHandler,
  createInProcessAgentEngineClient,
  normalizeChatOptions,
  type ChatOptions,
} from "@agent-api/app-engine/core";
import { createWorkbenchAuthController } from "@agent-api/app-engine/workbench";
import { createDefaultTranscriptStore } from "./tui/transcript-store.js";

export interface EngineHostOptions extends ChatOptions {
  profile?: string;
}

export function startEngineHost(options: EngineHostOptions = {}) {
  const transcriptStore = safeTranscriptStore();
  const client = createInProcessAgentEngineClient({
    authController: createWorkbenchAuthController(),
    baseOptions: normalizeChatOptions([], options),
    profileName: options.profile || "default",
    services: transcriptStore ? { transcriptStore } : undefined,
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

function safeTranscriptStore() {
  try {
    return createDefaultTranscriptStore();
  } catch {
    return null;
  }
}
