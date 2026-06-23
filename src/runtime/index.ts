import { createLocalRuntime } from "@agent-api/sdk/local";

export const cliName = "agent-api-cli";
export const cliAuthor = "AgentsWay";
export const cliVersion = "0.1.2";

export const runtime = createLocalRuntime({
  appName: cliName,
  appAuthor: cliAuthor,
});

export async function ensureRuntime() {
  await runtime.ensure();
  return runtime;
}

