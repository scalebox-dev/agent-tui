import type {
  AgentEngineRpcEvent,
  AgentEngineRpcHandler,
  AgentEngineRpcMethod,
  AgentEngineRpcRequest,
  AgentEngineRpcResponse,
  AgentEngineRpcTransport,
} from "./rpc.js";
import { agentEngineRpcProtocolVersion } from "./rpc.js";

export interface AgentEngineLineTransportOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onError?: (error: Error) => void;
}

export interface AgentEngineRpcConnection {
  dispose(): void;
}

export function createLineDelimitedAgentEngineRpcTransport(
  options: AgentEngineLineTransportOptions,
): AgentEngineRpcTransport {
  let disposed = false;
  let nextId = 1;
  let buffer = "";
  const listeners = new Set<(event: AgentEngineRpcEvent) => void>();
  const pending = new Map<string, {
    reject(error: Error): void;
    resolve(value: unknown): void;
  }>();

  const onData = (chunk: Buffer | string) => {
    buffer += String(chunk);
    flushLines(buffer, (line, rest) => {
      buffer = rest;
      const message = parseLine(line, options.onError);
      if (!message) return;
      if (isRpcResponse(message)) {
        const id = String(message.id);
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (message.ok) request.resolve(message.result);
        else request.reject(rpcResponseError(message));
        return;
      }
      if (isRpcEvent(message)) {
        for (const listener of listeners) listener(message);
      }
    });
  };
  const onEnd = () => disposeWithError(new Error("Agent engine RPC transport closed"));
  options.input.on("data", onData);
  options.input.on("end", onEnd);
  options.input.on("close", onEnd);
  return {
    request(method: AgentEngineRpcMethod, params?: unknown) {
      if (disposed) return Promise.reject(new Error("Agent engine RPC transport is disposed"));
      const id = nextId++;
      const request: AgentEngineRpcRequest = { id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
        writeLine(options.output, request, (error) => {
          pending.delete(String(id));
          reject(error);
        });
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposeWithError(new Error("Agent engine RPC transport disposed"));
    },
  };

  function disposeWithError(error: Error) {
    if (disposed) return;
    disposed = true;
    options.input.removeListener("data", onData);
    options.input.removeListener("end", onEnd);
    options.input.removeListener("close", onEnd);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    listeners.clear();
  }
}

export function bindLineDelimitedAgentEngineRpcHandler(
  handler: AgentEngineRpcHandler,
  options: AgentEngineLineTransportOptions,
): AgentEngineRpcConnection {
  let disposed = false;
  let buffer = "";
  writeLine(options.output, { type: "hello", protocolVersion: agentEngineRpcProtocolVersion }, options.onError);
  const unsubscribe = handler.subscribe((event) => {
    if (!disposed) writeLine(options.output, event, options.onError);
  });
  const onData = (chunk: Buffer | string) => {
    buffer += String(chunk);
    flushLines(buffer, (line, rest) => {
      buffer = rest;
      const message = parseLine(line, options.onError);
      if (!message) return;
      if (!isRpcRequest(message)) {
        options.onError?.(new Error("Ignoring non-request RPC line"));
        return;
      }
      void handler.handle(message).then(
        (response) => writeLine(options.output, response, options.onError),
        (error) => writeLine(options.output, handlerErrorResponse(message, error), options.onError),
      );
    });
  };
  options.input.on("data", onData);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      options.input.removeListener("data", onData);
    },
  };
}

function flushLines(buffer: string, onLine: (line: string, rest: string) => void) {
  let start = 0;
  while (true) {
    const index = buffer.indexOf("\n", start);
    if (index === -1) break;
    const line = buffer.slice(start, index).trimEnd();
    start = index + 1;
    if (line) onLine(line, buffer.slice(start));
  }
}

function parseLine(line: string, onError?: (error: Error) => void): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

function writeLine(output: NodeJS.WritableStream, message: unknown, onError?: (error: Error) => void) {
  const line = `${JSON.stringify(message)}\n`;
  output.write(line, (error?: Error | null) => {
    if (error) onError?.(error);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRpcRequest(value: unknown): value is AgentEngineRpcRequest {
  return isRecord(value) && ("id" in value) && typeof value.method === "string";
}

function isRpcResponse(value: unknown): value is AgentEngineRpcResponse {
  return isRecord(value) && ("id" in value) && typeof value.ok === "boolean";
}

function isRpcEvent(value: unknown): value is AgentEngineRpcEvent {
  return isRecord(value) && typeof value.type === "string";
}

function rpcResponseError(response: Extract<AgentEngineRpcResponse, { ok: false }>): Error {
  const error = new Error(response.error.message);
  error.name = response.error.name || "AgentEngineRpcError";
  return error;
}

function handlerErrorResponse(request: AgentEngineRpcRequest, error: unknown): AgentEngineRpcResponse {
  return {
    id: request.id,
    ok: false,
    error: error instanceof Error
      ? { message: error.message, name: error.name }
      : { message: String(error) },
  };
}
