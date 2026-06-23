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

## Import Layers

- `@agent-api/app-engine/core`: UI-neutral APIs for auth, config, profiles, conversations, updates, local workdir setup, and agent turns.
- `@agent-api/app-engine/workbench`: optional app/workbench state controllers for apps that want Agent API's conversation workflow.
- `@agent-api/app-engine/terminal`: optional terminal-facing helpers for transcript wrapping, input viewport rendering, and spinner glyphs.

The root `@agent-api/app-engine` entry is intentionally empty. Use an explicit subpath so your application depends on a clear API layer.

## Boundaries

- Core APIs own application state and side effects.
- Workbench APIs own reusable conversation/workbench semantics.
- Terminal APIs are optional helpers for terminal renderers.
- Renderers own widgets, native input controls, layout, keyboard mapping, and screen drawing.

## Local Development

```bash
npm install
npm run build -w @agent-api/app-engine
npm run smoke -w @agent-api/app-engine
```
