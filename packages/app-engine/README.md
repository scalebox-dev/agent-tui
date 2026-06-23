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
  createAgentEngine,
  createWorkbenchAuthController,
} from "@agent-api/app-engine";

configureAgentAppRuntime({
  appName: "my-agent-app",
  appAuthor: "My Company",
  appVersion: "1.0.0",
});

const engine = createAgentEngine();
const auth = createWorkbenchAuthController();
```

Host applications should call `configureAgentAppRuntime()` during startup so config, profiles, and runtime files live under the host app's own platform config directory.

## Boundaries

- This package owns core application state and side effects.
- Renderers own input widgets, layout, keyboard handling, and screen drawing.
- The CLI/TUI package should import core behavior from this package rather than from private source paths.

## Local Development

```bash
npm install
npm run build -w @agent-api/app-engine
npm run smoke -w @agent-api/app-engine
```
