# Agent API CLI

First-class command line interface for Agent API. The CLI shell is built on `@agent-api/app-engine`, which wraps `@agent-api/sdk@^1.4.0` behind a renderer-neutral application core. Commander handles command routing, and Ink renders the current terminal UI.

This repository publishes two packages:

- `@agent-api/app-engine`: reusable application core for agent apps.
- `@agent-api/cli`: command-line shell and Ink TUI renderer.

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

## Local Release

The TUI is distributed as a normal npm CLI package. The app does not self-update;
startup may show a lightweight update notice, and users update with npm:

```bash
npm install -g @agent-api/cli@latest
```

Prepare, verify, and publish a local release:

```bash
cd cli
npm run release:local
```

If your npm account requires two-factor auth for publish:

```bash
npm run release:local -- --otp 123456
```

The local release script runs `npm ci`, builds and tests both packages, creates
npm tarballs in `artifacts/`, installs the app-engine and CLI tarballs into a
temporary npm prefix, smoke-tests the published bin aliases, and then publishes
`@agent-api/app-engine` before `@agent-api/cli` with
`npm publish --access public`.

For a no-publish rehearsal:

```bash
npm run release:local -- --dry-run
```

## GitHub Actions Release

The repository includes **Package and Release** in `.github/workflows/package.yml`.
It builds and tests both packages, uploads npm tarballs as workflow artifacts, and
can publish `@agent-api/app-engine` followed by `@agent-api/cli`.

Before using it, add this repository secret in GitHub:

- `NPM_TOKEN`: npm automation token with publish access for both
  `@agent-api/app-engine` and `@agent-api/cli`.

Manual dry run:

1. Open **Actions → Package and Release → Run workflow**.
2. Keep `dry_run=true`.
3. Confirm the workflow passes and uploads `agent-tui-npm-package`.

Manual publish:

1. Open **Actions → Package and Release → Run workflow**.
2. Set `dry_run=false`.
3. The workflow runs `npm run release:local`, which skips versions already on npm.

Tag publish:

```bash
git tag v0.4.49
git push origin v0.4.49
```

Pushing a `v*` tag publishes automatically.

Set `AGENT_TUI_UPDATE_CHECK=0` to disable the startup update notice.

## Command Shape

```bash
agent-tui
agent-api
agent-api run
agent-api update
agent-api version
agent-api help
agent-api auth login
agent-api profiles list
agent-api agent chat
agent-api workdir status
agent-api doctor
```

No command defaults to the interactive `run` command. If you provide a bare
first argument, it must be a command name. Local workdirs are explicit: use
`agent-tui -w <path>`, `agent-tui run <path>`, or `agent-tui run --workdir <path>`.

## Interactive Workbench

Launch the first-class TUI without an initial local workdir:

```bash
agent-tui
```

Open a specific local workdir and expose local tools to the agent:

```bash
agent-tui -w .
agent-tui run .
agent-tui run ./my-workdir
agent-tui --workdir /absolute/path/to/my-workdir
```

The workdir option must point to an existing directory. When provided, the
workbench automatically turns on local workdir and shell tools in approval mode.
CLI chat runs can also expose local `SKILL.md` directories and opt into memory:

```bash
agent-api agent chat "Review this workspace" --workdir . --local-skill ./skills/review
agent-api agent chat "What did we decide last time?" --memory --memory-read
```

Local skills are discovered automatically from the workdir when local tools are
enabled. Use `--no-local-skills` to disable discovery, `--workspace-skills` to
let model-facing skill discovery search workspace skills, and
`--memory-tenant-search` to allow workspace-scoped memory search.

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
/memory          toggle memory options for agent turns
/skills          toggle local or workspace skill discovery
/preset <name>   set preset; /preset none clears it
/model <name>    set explicit model; /model auto clears it
/access full     allow local workdir actions without approval
/access approval require approval for local workdir actions
/context         toggle local workdir context/tools for each turn
/new [name]      start a fresh conversation
/switch <name>   switch conversation handle
```

Local workdir tools are only exposed to the model when you start with `-w`,
`--workdir`, `run [workdir]`, or enable local context with `/context`.

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
agent-api agent chat --conversation release --workdir .
```

Named conversations continue automatically:

```bash
agent-api agent chat "Draft the implementation plan" --conversation release
agent-api agent chat "Now turn that into a checklist" --conversation release
agent-api agent list
agent-api agent show release
```

Attach local workdir context:

```bash
agent-api agent chat "Review this project and suggest next steps" \
  --workdir . \
  --context-query auth \
  --max-context-files 80
```

The CLI sends local context as bounded, secret-aware project context. The remote Agent API remains the core execution path.

Workdir access defaults to approval mode:

```bash
agent-api agent chat --workdir . --access approval
```

Use full access only for trusted workdirs. In full access mode, valid edit proposals are previewed and applied automatically:

```bash
agent-api agent chat --workdir . --access full
```

## Local Workdir

The CLI uses the SDK local layer for workdir operations:

```bash
agent-api workdir status --path .
agent-api workdir summary --path .
agent-api workdir context --path . --query auth --max-files 40
```

Inside the interactive workbench:

```text
/auth            show current auth profile
/login           return to auth gate without deleting profiles
/logout          leave current session and return to auth gate
/switch-profile  switch/sign in with a different profile
/delete-profile  delete current saved profile and return to auth
/config          show current run configuration
/workdir       show local workdir summary
/summary         show local workdir previews
/search <query>  search text in the local workdir
/preset <name>   set or clear preset
/model <name>    set or clear explicit model
/access <mode>   approval or full
/context         toggle local context packaging for each turn
/clear           clear visible transcript
/quit            quit
```

## Local Edit Approval

The workbench can preview and apply local line edits through the SDK local workdir layer:

```text
/edit {"description":"Rename heading","edits":[{"path":"README.md","startLine":1,"endLine":1,"replacement":"# New Heading"}]}
/preview
/apply
/reject
```

Edits are previewed before they are applied. Apply uses the SDK edit path with rollback on failure.
In `--access full`, valid proposals are applied immediately after preview generation.

When a workdir is attached, the CLI also tells the remote agent to return local changes as a fenced JSON block:

````text
```agent_api_local_edits
{"description":"short reason","edits":[{"path":"README.md","startLine":1,"endLine":1,"replacement":"# New Heading"}]}
```
````

Detected agent proposals go through the same approval/full-access flow as manual `/edit` proposals.
