import type { WorkbenchAction, WorkbenchState } from "../workbench/state.js";
import type { AgentEngineClient } from "./client.js";
import type { WorkbenchLifecycleEffect } from "../workbench/lifecycle-controller.js";

export const agentEngineRpcProtocolVersion = 1;

export type AgentEngineRpcId = number | string | null;

export type AgentEngineRpcMethod =
  | "abortActiveTurn"
  | "dispatch"
  | "dispose"
  | "loadInitialConversation"
  | "loadInitialSettings"
  | "loadNewerTranscript"
  | "loadOlderTranscript"
  | "loadWorkdir"
  | "loadWorkspaceContext"
  | "maybeCheckForUpdate"
  | "refreshAuth"
  | "refreshConversationSummaries"
  | "runLifecycleEffects"
  | "snapshot"
  | "startInitialPrompt"
  | "submit";

export interface AgentEngineRpcParamsByMethod {
  abortActiveTurn: { message?: string };
  dispatch: { action: WorkbenchAction };
  dispose: Record<string, never>;
  loadInitialConversation: Record<string, never>;
  loadInitialSettings: Record<string, never>;
  loadNewerTranscript: { limit?: number };
  loadOlderTranscript: { limit?: number };
  loadWorkdir: { path?: string };
  loadWorkspaceContext: Record<string, never>;
  maybeCheckForUpdate: Record<string, never>;
  refreshAuth: { profile?: string };
  refreshConversationSummaries: Record<string, never>;
  runLifecycleEffects: { effects: WorkbenchLifecycleEffect[] };
  snapshot: Record<string, never>;
  startInitialPrompt: Record<string, never>;
  submit: { input: string };
}

export interface AgentEngineRpcResultByMethod {
  abortActiveTurn: null;
  dispatch: null;
  dispose: null;
  loadInitialConversation: null;
  loadInitialSettings: null;
  loadNewerTranscript: number;
  loadOlderTranscript: number;
  loadWorkdir: null;
  loadWorkspaceContext: null;
  maybeCheckForUpdate: null;
  refreshAuth: null;
  refreshConversationSummaries: null;
  runLifecycleEffects: null;
  snapshot: WorkbenchState;
  startInitialPrompt: null;
  submit: null;
}

export interface AgentEngineRpcRequest {
  id: AgentEngineRpcId;
  method: AgentEngineRpcMethod;
  params?: unknown;
}

export type AgentEngineRpcResponse =
  | { id: AgentEngineRpcId; ok: true; result?: unknown }
  | { id: AgentEngineRpcId; ok: false; error: AgentEngineRpcError };

export interface AgentEngineRpcError {
  message: string;
  name?: string;
}

export type AgentEngineRpcEvent =
  | { type: "hello"; protocolVersion: number }
  | { type: "state"; state: WorkbenchState };

export interface AgentEngineRpcHandler {
  handle(request: AgentEngineRpcRequest): Promise<AgentEngineRpcResponse>;
  subscribe(listener: (event: AgentEngineRpcEvent) => void): () => void;
  snapshot(): WorkbenchState;
}

export interface AgentEngineRpcTransport {
  request(method: AgentEngineRpcMethod, params?: unknown): Promise<unknown>;
  subscribe(listener: (event: AgentEngineRpcEvent) => void): () => void;
  dispose?(): void;
}

export function createAgentEngineRpcClient(
  transport: AgentEngineRpcTransport,
  initialState: WorkbenchState,
): AgentEngineClient {
  let state = initialState;
  const listeners = new Set<() => void>();
  const unsubscribe = transport.subscribe((event) => {
    if (event.type !== "state") return;
    state = event.state;
    for (const listener of listeners) listener();
  });
  return {
    snapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispatch(action) {
      await transport.request("dispatch", { action });
    },
    async maybeCheckForUpdate() {
      await transport.request("maybeCheckForUpdate");
    },
    async loadWorkspaceContext() {
      await transport.request("loadWorkspaceContext");
    },
    async loadInitialConversation() {
      await transport.request("loadInitialConversation");
    },
    async refreshConversationSummaries() {
      await transport.request("refreshConversationSummaries");
    },
    async loadOlderTranscript(limit) {
      return numberResult(await transport.request("loadOlderTranscript", { limit }));
    },
    async loadNewerTranscript(limit) {
      return numberResult(await transport.request("loadNewerTranscript", { limit }));
    },
    async loadInitialSettings() {
      await transport.request("loadInitialSettings");
    },
    async loadWorkdir(path) {
      await transport.request("loadWorkdir", { path });
    },
    async refreshAuth(profile) {
      await transport.request("refreshAuth", { profile });
    },
    async abortActiveTurn(message) {
      await transport.request("abortActiveTurn", { message });
    },
    async startInitialPrompt() {
      await transport.request("startInitialPrompt");
    },
    async submit(input) {
      await transport.request("submit", { input });
    },
    runLifecycleEffects(effects) {
      void transport.request("runLifecycleEffects", { effects });
    },
    dispose() {
      unsubscribe();
      transport.dispose?.();
    },
  };
}

export function createAgentEngineRpcHandler(client: AgentEngineClient): AgentEngineRpcHandler {
  return {
    async handle(request) {
      try {
        const result = await handleAgentEngineRpcRequest(client, request);
        return { id: request.id, ok: true, result };
      } catch (error) {
        return { id: request.id, ok: false, error: rpcError(error) };
      }
    },
    subscribe(listener) {
      return client.subscribe(() => {
        listener({ type: "state", state: client.snapshot() });
      });
    },
    snapshot: client.snapshot,
  };
}

async function handleAgentEngineRpcRequest(client: AgentEngineClient, request: AgentEngineRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "abortActiveTurn":
      await client.abortActiveTurn(optionalStringParam(request.params, "message"));
      return null;
    case "dispatch":
      client.dispatch(requiredParam<WorkbenchAction>(request.params, "action"));
      return null;
    case "dispose":
      client.dispose();
      return null;
    case "loadInitialConversation":
      await client.loadInitialConversation();
      return null;
    case "loadInitialSettings":
      await client.loadInitialSettings();
      return null;
    case "loadNewerTranscript":
      return client.loadNewerTranscript(optionalNumberParam(request.params, "limit"));
    case "loadOlderTranscript":
      return client.loadOlderTranscript(optionalNumberParam(request.params, "limit"));
    case "loadWorkdir":
      await client.loadWorkdir(optionalStringParam(request.params, "path"));
      return null;
    case "loadWorkspaceContext":
      await client.loadWorkspaceContext();
      return null;
    case "maybeCheckForUpdate":
      await client.maybeCheckForUpdate();
      return null;
    case "refreshAuth":
      await client.refreshAuth(optionalStringParam(request.params, "profile"));
      return null;
    case "refreshConversationSummaries":
      await client.refreshConversationSummaries();
      return null;
    case "runLifecycleEffects":
      client.runLifecycleEffects(requiredParam<WorkbenchLifecycleEffect[]>(request.params, "effects"));
      return null;
    case "snapshot":
      return client.snapshot();
    case "startInitialPrompt":
      await client.startInitialPrompt();
      return null;
    case "submit":
      await client.submit(requiredStringParam(request.params, "input"));
      return null;
  }
}

function requiredParam<T>(params: unknown, key: string): T {
  const record = objectParam(params);
  if (!(key in record)) throw new Error(`Missing RPC parameter: ${key}`);
  return record[key] as T;
}

function requiredStringParam(params: unknown, key: string): string {
  const value = requiredParam<unknown>(params, key);
  if (typeof value !== "string") throw new Error(`Invalid RPC parameter: ${key}`);
  return value;
}

function optionalStringParam(params: unknown, key: string): string | undefined {
  if (params == null) return undefined;
  const value = objectParam(params)[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid RPC parameter: ${key}`);
  return value;
}

function optionalNumberParam(params: unknown, key: string): number | undefined {
  if (params == null) return undefined;
  const value = objectParam(params)[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid RPC parameter: ${key}`);
  return value;
}

function objectParam(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("RPC params must be an object");
  return params as Record<string, unknown>;
}

function rpcError(error: unknown): AgentEngineRpcError {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error) };
}

function numberResult(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid numeric RPC result");
  return value;
}
