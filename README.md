# Agent API CLI

First-class command line interface for Agent API. The CLI is built on `@agent-api/sdk@^1.1.5` with Commander for command routing and Ink for interactive terminal UI.

## Development

```bash
cd cli
npm install
npm run build
node dist/index.js --help
```

Create local development commands:

```bash
npm run dev:link
agent-tui
```

## Command Shape

```bash
agent-tui
agent-api
agent-api auth login
agent-api profiles list
agent-api agent chat
agent-api workspace status
agent-api doctor
```

## Interactive Workbench

Launch the first-class TUI from your current directory:

```bash
agent-tui
```

The workbench opens with auth as the first gate. If the active profile is valid,
it enters the conversation UI automatically. If not, it shows an in-terminal
auth picker for browser session or API key login.

Inside the workbench, configure the agent run dynamically:

```text
/auth            show current auth profile
/login           return to auth gate without deleting profiles
/logout          leave current session and return to auth gate
/switch-profile  switch/sign in with a different profile
/delete-profile  delete current saved profile and return to auth
/config          show current run configuration
/preset <name>   set preset; /preset none clears it
/model <name>    set explicit model; /model auto clears it
/access full     allow local workspace actions without approval
/access approval require approval for local workspace actions
/context         toggle local workspace context/tools for each turn
/new [name]      start a fresh conversation
/switch <name>   switch conversation handle
```

The current working directory is loaded as the local workspace. Local workspace
tools are only exposed to the model when you enable local context with
`/context` or start with `--workspace`.

## Authentication

The interactive workbench checks the active profile before it starts. If no valid
profile exists, it opens an in-terminal auth picker with two choices:

- Browser session: best for desktop environments and refreshable long-running use.
- API key: best for shell-only servers, CI, and remote terminals.

You can also sign in explicitly from the shell. Browser login is the default for
humans:

```bash
agent-api auth login --profile work --base-url https://api.agentsway.dev
```

API keys are supported for shell-only environments and automation:

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

Start the interactive TUI with explicit options:

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
/auth            show current auth profile
/login           return to auth gate without deleting profiles
/logout          leave current session and return to auth gate
/switch-profile  switch/sign in with a different profile
/delete-profile  delete current saved profile and return to auth
/config          show current run configuration
/workspace       show local workspace summary
/summary         show local workspace previews
/search <query>  search text in the local workspace
/preset <name>   set or clear preset
/model <name>    set or clear explicit model
/access <mode>   approval or full
/context         toggle local context packaging for each turn
/clear           clear visible transcript
/quit            quit
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
