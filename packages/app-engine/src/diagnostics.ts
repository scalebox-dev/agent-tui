import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { WorkbenchState } from "./workbench/state.js";

const enabledValues = new Set(["1", "true", "yes", "on"]);
let sequence = 0;

export function diagnosticsEnabled() {
  return enabledValues.has((process.env.AGENT_TUI_DEBUG_MEMORY || process.env.AGENT_TUI_DEBUG || "").toLowerCase());
}

export function diagnosticNowMs() {
  return performance.now();
}

export function logDiagnostic(event: string, fields: Record<string, unknown> = {}) {
  if (!diagnosticsEnabled()) return;
  const record = {
    ts: new Date().toISOString(),
    seq: sequence++,
    event,
    memory: memorySnapshot(),
    ...fields,
  };
  const line = `${JSON.stringify(record)}\n`;
  const path = process.env.AGENT_TUI_DEBUG_LOG;
  try {
    if (path) appendFileSync(path, line, "utf8");
    else process.stderr.write(`[agent-tui-debug] ${line}`);
  } catch {
    // Diagnostics must never affect the TUI.
  }
}

export function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

export function stateDiagnosticSummary(state: WorkbenchState) {
  return {
    messages: state.messages.length,
    messageChars: state.messages.reduce((sum, message) => sum + message.text.length, 0),
    maxMessageChars: state.messages.reduce((max, message) => Math.max(max, message.text.length), 0),
    activities: state.activities.length,
    runs: state.runs.length,
    runningRuns: state.runs.filter((run) => run.status === "running").length,
    conversationSummaries: state.conversationSummaries.length,
    workspaceSummaries: state.workspaceSummaries.length,
    pendingLocalTools: state.pendingLocalTools.length,
    pendingAutomaticContinuations: state.pendingAutomaticContinuations.length,
    busy: state.busy,
    currentConversation: state.currentConversation,
    conversationId: state.conversationId,
  };
}

export function approximateJSONBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return -1;
  }
}

export function approximateStringBytes(value: string | undefined) {
  return Buffer.byteLength(value ?? "", "utf8");
}
