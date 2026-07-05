# Agent Engine Protocol

The Agent Engine Protocol is the renderer-facing control plane for external Agent API workbench UIs.
It lets a renderer drive a local app-engine host without depending on terminal code or TypeScript engine internals.

This document describes the protocol shape. It does not require a specific pipe. The same envelopes can be carried over stdio, a Unix domain socket, a named pipe, WebSocket, or an in-process adapter.

## Status

Protocol status: draft.

Protocol version: `1`.

Current package support:

- `AgentEngineClient`: renderer-facing client contract.
- `createInProcessAgentEngineClient(...)`: built-in TypeScript adapter used by the in-house TUI.
- `createAgentEngineRpcHandler(client)`: service-side request handler.
- `createAgentEngineRpcClient(transport, initialState)`: renderer-side client over a transport.
- `createLineDelimitedAgentEngineRpcTransport(...)`: client-side newline-delimited JSON transport over Node streams.
- `bindLineDelimitedAgentEngineRpcHandler(...)`: host-side newline-delimited JSON binding over Node streams.

The built-in TUI may keep using the in-process adapter. External renderers should target the RPC envelopes and event stream.

## Architecture

The recommended process model is one renderer owning one engine host:

```text
renderer process
  -> Agent Engine Protocol transport
  -> agent-tui engine host
  -> app-engine workbench
```

This is intentionally not a long-running daemon model. The renderer starts the host, owns its lifetime, and terminates it when the UI exits. That keeps local auth, transcript state, active turns, and workdir access scoped to one user-facing application session.

The built-in terminal UI can keep using the in-process TypeScript adapter:

```text
built-in TUI
  -> createInProcessAgentEngineClient(...)
  -> app-engine workbench
```

External renderers should use the protocol path instead of importing terminal helpers or private workbench controllers.

## Host Command

The CLI exposes a low-level engine host for renderer integrations:

```sh
agent-tui engine host --profile default --workdir . --access approval
```

The host reads newline-delimited JSON requests from stdin and writes newline-delimited JSON responses/events to stdout. Diagnostics go to stderr.

Supported bootstrap options:

- `--profile <name>`
- `--workdir <path>`
- `--conversation <name>`
- `--preset <name>`
- `--model <name>`
- `--access <off|approval|full>`

The command is intended for renderer processes and integration tests, not for normal interactive users.

### Host Startup Example

```sh
agent-tui engine host \
  --profile default \
  --workdir /path/to/project \
  --conversation default \
  --preset pro-search \
  --access approval
```

The process writes protocol data to stdout. Renderers must not mix stdout logs with protocol frames. Host diagnostics are written to stderr.

If the renderer closes stdin, the host disposes the engine and exits.

## Envelopes

Requests are JSON objects:

```json
{
  "id": 1,
  "method": "snapshot",
  "params": {}
}
```

Request `id` values are chosen by the renderer. They may be strings or numbers. A renderer may have multiple in-flight requests and should correlate responses by `id`.

Responses are JSON objects:

```json
{
  "id": 1,
  "ok": true,
  "result": {}
}
```

Errors use the same response envelope:

```json
{
  "id": 1,
  "ok": false,
  "error": {
    "name": "Error",
    "message": "Invalid RPC parameter: input"
  }
}
```

Events are pushed from host to renderer:

```json
{
  "type": "hello",
  "protocolVersion": 1
}
```

The host emits `hello` when a connection is established. It emits `state` whenever workbench state changes. The `state` payload is a `WorkbenchState` snapshot. Renderers should treat it as replace-by-value, not as a patch.

Events do not have request IDs. A host may emit events between any two responses, including while a request is still in flight.

## Methods

All params are objects. Methods without arguments use `{}` or omit `params`.

| Method | Params | Result |
| --- | --- | --- |
| `abortActiveTurn` | `{ "message"?: string }` | `null` |
| `dispatch` | `{ "action": WorkbenchAction }` | `null` |
| `dispose` | `{}` | `null` |
| `loadInitialConversation` | `{}` | `null` |
| `loadInitialSettings` | `{}` | `null` |
| `loadNewerTranscript` | `{ "limit"?: number }` | number |
| `loadOlderTranscript` | `{ "limit"?: number }` | number |
| `loadWorkdir` | `{ "path"?: string }` | `null` |
| `loadWorkspaceContext` | `{}` | `null` |
| `maybeCheckForUpdate` | `{}` | `null` |
| `refreshAuth` | `{ "profile"?: string }` | `null` |
| `refreshConversationSummaries` | `{}` | `null` |
| `runLifecycleEffects` | `{ "effects": WorkbenchLifecycleEffect[] }` | `null` |
| `snapshot` | `{}` | `WorkbenchState` |
| `startInitialPrompt` | `{}` | `null` |
| `submit` | `{ "input": string }` | `null` |

### Startup Methods

A renderer normally calls these after receiving `hello`:

1. `snapshot`
2. `maybeCheckForUpdate`
3. `loadWorkspaceContext`
4. `loadInitialConversation`
5. `loadInitialSettings`
6. `loadWorkdir`, when the renderer was launched with a workdir
7. `startInitialPrompt`, if the renderer wants CLI-style initial prompt behavior

Renderers may choose a different startup sequence, but should avoid submitting prompts before workspace context and conversation state have loaded.

### User Action Methods

Common interactive actions:

- `submit`: submit user text. Leading slash commands are parsed by the workbench command layer.
- `abortActiveTurn`: request cancellation of the active agent turn.
- `loadOlderTranscript`: page older transcript messages into the visible state window.
- `loadNewerTranscript`: page newer transcript messages into the visible state window.
- `loadWorkdir`: refresh or switch the local workdir context.

### Low-Level Methods

`dispatch` and `runLifecycleEffects` exist for TypeScript and controlled renderer integrations. Non-TypeScript renderers should prefer higher-level methods when possible. If a renderer uses `dispatch`, it must send valid `WorkbenchAction` payloads for the protocol version it targets.

## State Events

Hosts emit a `state` event whenever the underlying engine state changes:

```json
{
  "type": "state",
  "state": {
    "busy": false,
    "messages": [],
    "activities": []
  }
}
```

State events currently carry full snapshots. Large transcript bodies should remain bounded by the workbench visible-window policy; full transcripts belong in the transcript store and export/read APIs.

Renderer guidance:

- Treat `messages` as a bounded visible transcript window, not the whole conversation.
- Treat `activities` as UI activity feed state.
- Use `busy` to reflect active agent work.
- Use `pendingLocalTool`, `pendingAutomaticContinuation`, and `pendingUpdate` to display approval/continuation/update affordances.
- Use `conversationSummaries`, `workspaceSummaries`, and workdir fields to render navigation panels.
- Do not mutate state locally. Send protocol methods and wait for state events.

## Transport Requirements

A transport must provide:

- request/response correlation by `id`
- host-to-renderer events
- ordered delivery per connection
- JSON-serializable payloads
- a clean shutdown path

Recommended first concrete transport: newline-delimited JSON over stdio. Stdio is only a transport choice, not part of the protocol identity.

### Newline-Delimited JSON Transport

The line transport writes one JSON envelope per line. Requests flow renderer-to-host. Responses and events flow host-to-renderer.

Renderer to host:

```jsonl
{"id":1,"method":"snapshot","params":{}}
{"id":2,"method":"submit","params":{"input":"Hello"}}
```

Host to renderer:

```jsonl
{"type":"hello","protocolVersion":1}
{"id":1,"ok":true,"result":{"busy":false}}
{"type":"state","state":{"busy":true}}
{"id":2,"ok":true,"result":null}
```

The package provides stream helpers for this transport:

```ts
import {
  bindLineDelimitedAgentEngineRpcHandler,
  createLineDelimitedAgentEngineRpcTransport,
} from "@agent-api/app-engine/core";
```

These helpers work with any `ReadableStream`/`WritableStream` pair, including stdio and socket streams.

Client implementations should:

- buffer partial lines
- ignore blank lines
- parse one JSON object per line
- route objects with `ok` to pending request handlers
- route objects with `type` to event handlers
- surface malformed JSON as transport errors
- reject pending requests if the stream closes

Future transports can carry the same envelopes over:

- Unix domain socket or Windows named pipe
- WebSocket
- localhost TCP
- in-process TypeScript adapter

## Lifecycle

A renderer should:

1. Start or connect to an engine host.
2. Read the `hello` event and verify the supported protocol version.
3. Obtain an initial snapshot with `snapshot`, or pass the host snapshot as `initialState` when constructing an RPC client.
4. Subscribe to state events.
5. Drive user actions through methods like `submit`, `loadOlderTranscript`, `loadWorkdir`, and `abortActiveTurn`.
6. Call `dispose` or close the transport when the renderer exits.

## Minimal Renderer Flow

Pseudo-code:

```text
spawn agent-tui engine host --profile default --workdir .
read hello event
send snapshot request
render snapshot result
subscribe to state events
send loadWorkspaceContext
send loadInitialConversation
send loadInitialSettings
send loadWorkdir
on user submit: send submit
on exit: close stdin or send dispose
```

For TypeScript renderers, `createAgentEngineRpcClient(...)` wraps this into the same `AgentEngineClient` shape used by the built-in TUI.

## Renderer Responsibilities

Renderers own:

- widgets and layout
- native input controls
- text selection and copy/paste behavior
- keyboard/mouse shortcuts
- display-specific transcript virtualization
- platform-specific window/process lifecycle

The engine owns:

- auth profile access
- workspace context
- conversation state
- transcript persistence
- workdir context loading
- agent turns
- local tool approval state
- workbench command handling

Renderers should not import or depend on private workbench sessions, controllers, terminal render models, or local tool internals.

## Compatibility Rules

- New methods may be added.
- Existing methods should keep their params/result shapes stable within a major protocol generation.
- Unknown event types should be ignored by renderers.
- Unknown response fields should be ignored.
- Renderers should not depend on private engine/session/controller objects.
- Renderers should verify `hello.protocolVersion` before sending user actions.
- Hosts should continue writing diagnostics to stderr, never stdout.

## TypeScript API

The TypeScript source of truth lives in `@agent-api/app-engine/core`:

```ts
import {
  createAgentEngineRpcClient,
  createAgentEngineRpcHandler,
  agentEngineRpcProtocolVersion,
  bindLineDelimitedAgentEngineRpcHandler,
  createLineDelimitedAgentEngineRpcTransport,
  type AgentEngineRpcRequest,
  type AgentEngineRpcResponse,
  type AgentEngineRpcEvent,
  type AgentEngineRpcParamsByMethod,
  type AgentEngineRpcResultByMethod,
  type AgentEngineRpcTransport,
} from "@agent-api/app-engine/core";
```

External non-TypeScript renderers should mirror the JSON envelopes described above.
