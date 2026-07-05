# Agent API App Engine

Renderer-neutral application engine for Agent API apps.

`@agent-api/app-engine` contains the reusable core behind `@agent-api/cli`: auth profile handling, conversation state, workdir context, local tool orchestration, isolator configuration, and the workbench state machine. It does not depend on Ink, React, or any terminal renderer.

## Install

```bash
npm install @agent-api/app-engine
```

## Usage

```ts
import {
  configureAgentAppRuntime,
  loginWithAPIKey,
  runAgentTurn,
} from "@agent-api/app-engine/core";

configureAgentAppRuntime({
  appName: "my-agent-app",
  appAuthor: "My Company",
  appVersion: "1.0.0",
});

await loginWithAPIKey({
  profile: "default",
  baseURL: "https://api.agentsway.dev",
  apiKey: process.env.AGENT_API_KEY!,
});

const result = await runAgentTurn({
  profile: "default",
  promptParts: ["Hello"],
});
```

Host applications should call `configureAgentAppRuntime()` during startup so config, profiles, and runtime files live under the host app's own platform config directory.

Apps that need their own persistence backend can inject storage:

```ts
import { configureAgentAppRuntime } from "@agent-api/app-engine/core";
import { createPostgresStorage } from "@agent-api/app-engine/storage";

configureAgentAppRuntime({
  appName: "my-agent-app",
  storage: createPostgresStorage(pgClient),
});
```

## Import Layers

- `@agent-api/app-engine/core`: UI-neutral APIs for auth, config, profiles, conversations, updates, local workdir setup, and agent turns.
- `@agent-api/app-engine/workbench`: optional app/workbench state controllers for apps that want Agent API's conversation workflow.
- `@agent-api/app-engine/terminal`: optional terminal-facing helpers for transcript wrapping, input viewport rendering, and spinner glyphs.
- `@agent-api/app-engine/storage`: storage contracts and built-in adapters for memory, file/config-store, SQL, Redis/Valkey-style key-value clients, and keytar-style keychains.

The root `@agent-api/app-engine` entry is intentionally empty. Use an explicit subpath so your application depends on a clear API layer.

## Boundaries

- Core APIs own application state and side effects.
- Workbench APIs own reusable conversation/workbench semantics.
- Terminal APIs are optional helpers for terminal renderers.
- Storage APIs are optional adapters. Host apps can use built-ins or provide their own implementation.
- Renderers own widgets, native input controls, layout, keyboard mapping, and screen drawing.

## External Renderers

External renderers can integrate without importing terminal code by using the Agent Engine Protocol. The CLI exposes a low-level stdio host:

```bash
agent-tui engine host --profile default --workdir .
```

The host speaks newline-delimited JSON request/response/event envelopes over stdin/stdout. See [`docs/agent-engine-protocol.md`](docs/agent-engine-protocol.md) for the protocol, lifecycle, and renderer responsibilities.

## Local Development

```bash
npm install
npm run build -w @agent-api/app-engine
npm run smoke -w @agent-api/app-engine
```
