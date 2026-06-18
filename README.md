# Agent API CLI

First-class command line interface for Agent API. The CLI is built on `@agent-api/sdk@^1.1.5` with Commander for command routing and Ink for interactive terminal UI.

## Development

```bash
cd cli
npm install
npm run build
node dist/index.js --help
```

## Command Shape

```bash
agent-api auth login
agent-api profiles list
agent-api agent chat
agent-api workspace status
agent-api doctor
```

## Authentication

Browser login is the default for humans:

```bash
agent-api auth login --profile work --base-url https://api.agentsway.dev
```

API keys are supported for automation:

```bash
agent-api auth login --profile ci --api-key sk-...
agent-api auth whoami --profile ci
agent-api auth logout --profile ci
```

Profiles:

```bash
agent-api profiles list
agent-api profiles use work
agent-api profiles show
```

## Agent Conversations

Chat with the remote agent:

```bash
agent-api agent chat "Summarize the current release status" --preset pro-search
```

Start the interactive TUI:

```bash
agent-api agent chat --conversation release --workspace .
```

Named conversations continue automatically:

```bash
agent-api agent chat "Draft the implementation plan" --conversation release
agent-api agent chat "Now turn that into a checklist" --conversation release
agent-api agent list
agent-api agent show release
```

Attach local workspace context:

```bash
agent-api agent chat "Review this project and suggest next steps" \
  --workspace . \
  --context-query auth \
  --max-context-files 80
```

The CLI sends local context as bounded, secret-aware project context. The remote Agent API remains the core execution path.

Workspace access defaults to approval mode:

```bash
agent-api agent chat --workspace . --access approval
```

Use full access only for trusted workspaces. In full access mode, valid edit proposals are previewed and applied automatically:

```bash
agent-api agent chat --workspace . --access full
```

## Local Workspace

The CLI uses the SDK local layer for workspace operations:

```bash
agent-api workspace status --path .
agent-api workspace summary --path .
agent-api workspace context --path . --query auth --max-files 40
```

Inside the interactive workbench:

```text
/workspace       show local workspace summary
/summary         show local workspace previews
/search <query>  search text in the local workspace
/context         toggle local context packaging for each turn
/clear           clear visible transcript
/exit            quit
```

## Local Edit Approval

The workbench can preview and apply local line edits through the SDK local workspace layer:

```text
/edit {"description":"Rename heading","edits":[{"path":"README.md","startLine":1,"endLine":1,"replacement":"# New Heading"}]}
/preview
/apply
/reject
```

Edits are previewed before they are applied. Apply uses the SDK edit path with rollback on failure.
In `--access full`, valid proposals are applied immediately after preview generation.

When a workspace is attached, the CLI also tells the remote agent to return local changes as a fenced JSON block:

````text
```agent_api_local_edits
{"description":"short reason","edits":[{"path":"README.md","startLine":1,"endLine":1,"replacement":"# New Heading"}]}
```
````

Detected agent proposals go through the same approval/full-access flow as manual `/edit` proposals.
