# pi-multifix

A [pi](https://github.com/badlogic/pi-mono) extension for fixing bugs across multiple repositories. Fetches issues from ClickUp (or free-text), creates isolated git worktree workspaces, analyzes and fixes the bug, creates merge requests, and posts results back to the issue tracker.

## Features

- **Multi-repo** — works across multiple repositories in a single session using absolute paths
- **ClickUp integration** — fetches bug details, posts MR links after merge, updates task status
- **Headless mode** — describe a bug in free text without an issue tracker
- **Git worktree isolation** — each bug gets its own branches, your working copy stays clean
- **Auto-symlinks** — `node_modules` and `vendor/` symlinked from main repo for instant setup
- **MR/PR creation** — `create_mr` tool pushes and opens merge requests via `glab` (GitLab) or `gh` (GitHub)
- **Scout subagents** — delegates research to cheaper/faster models via [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)
- **Project configs** — YAML-based per-project configuration, reusable across different multi-repo setups
- **Session persistence** — multifix state survives reloads and session resume
- **Status line** — footer shows active bug + MR count

## Install

```bash
pi install npm:pi-multifix
```

Or from git:

```bash
pi install git:github.com/fabkho/pi-multifix
```

### Prerequisites

- [pi](https://github.com/badlogic/pi-mono)
- [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) (`pi install npm:@tintinweb/pi-subagents`)
- `glab` (GitLab CLI) and/or `gh` (GitHub CLI) installed and authenticated
- `CLICKUP_API_TOKEN` environment variable set (for ClickUp mode)

### Setup

```bash
# 1. Create your project config
mkdir -p ~/.config/pi-multifix
cp configs/anny.yaml ~/.config/pi-multifix/my-project.yaml
# Edit with your repos, paths, tokens

# 2. Set a default project (optional — avoids --project flag)
echo "my-project" > ~/.config/pi-multifix/default

# 3. Symlink the scout agent (optional — for subagent research)
ln -sf "$(npm root -g)/pi-multifix/agents/bugfix-scout.md" ~/.pi/agent/agents/bugfix-scout.md
```

## Usage

### Fix a bug

```
/multifix CU-12345                                          # ClickUp task ID
/multifix CU-12345 repo=frontend                            # hint which repo is affected
/multifix CU-12345 repo=backend "The API returns 500"       # with extra context
/multifix https://app.clickup.com/t/86abc123                # ClickUp URL
/multifix "The booking modal crashes on save"                # headless mode (no tracker)
/multifix --project other-project CU-99999                   # different project config
```

### Merge and close

```
/multifix-done                                              # merge MR(s), post buffered comment, update tracker
/multifix-done "Simple i18n fix, no backend changes needed"  # append a note to the posted comment
```

Merges all MR(s) created in the session, then posts the buffered `update_issue` comment to the tracker (with `✅ Fix merged.` prepended). Updates issue status if `doneStatus` is configured. Any note passed to `/multifix-done` is appended to the comment.

> **Note:** `update_issue` does **not** post to ClickUp immediately — it buffers the comment until `/multifix-done` runs. This ensures nothing is posted to the tracker before the fix is actually merged.

## What happens when you run `/multifix`

1. **Loads project config** from `~/.config/pi-multifix/<project>.yaml`
2. **Fetches the bug** from ClickUp (or creates a headless bug from your text)
3. **Creates worktrees** for each repo on a fresh branch
4. **Symlinks** `node_modules` and `vendor/` from the main repos
5. **Injects a system prompt** with repo paths, codebase conventions, and workflow instructions
6. **The agent analyzes** the bug across all repos, determines root cause
7. **Fixes the code**, using scout subagents for research to keep context lean
8. **Creates MR(s)** via `glab mr create` / `gh pr create`
9. **Buffers the MR comment** — `update_issue` stores the comment in session state, nothing is posted yet
10. **`/multifix-done`** merges all MRs, then flushes the buffered comment to the tracker

## Project Config

YAML config files live at `~/.config/pi-multifix/<name>.yaml`.

### Minimal config (defaults handle the rest)

```yaml
name: my-project

repos:
  frontend:
    path: ~/code/my-project/frontend
  backend:
    path: ~/code/my-project/backend

workspace:
  root: ~/code/my-project/worktrees
```

### Full config with all options

```yaml
name: my-project

issueTracker:
  type: clickup                       # clickup | headless (default: headless)
  doneStatus: code review             # status set by /multifix-done (default: skip)
  branchPrefix: CU-                   # auto-set per tracker type, override here
  clickup:                            # adapter-specific config nested under type name
    tokenEnv: CLICKUP_API_TOKEN       # env var holding the API token
  # linear:                           # future: Linear adapter config
  #   tokenEnv: LINEAR_API_KEY
  #   teamId: TEAM_123

repos:
  frontend:
    path: ~/code/my-project/frontend  # required — path to the repo
    remote: origin                    # default: origin
    baseBranch: main                  # default: main
    platform: gitlab                  # gitlab | github (default: gitlab)
    contextFiles:                     # files read into the agent's system prompt
      - .github/copilot-instructions.md
      - AGENTS.md
  backend:
    path: ~/code/my-project/backend
    contextFiles:
      - .github/copilot-instructions.md

workspace:
  root: ~/code/my-project/worktrees   # where worktrees are created
  # script: ~/bin/create-workspace.sh # optional custom creation script

agent:
  model: claude-opus-4.6              # default: claude-opus-4.6
  thinking: high                      # default: high
  scoutModel: claude-sonnet-4.6       # default: claude-sonnet-4.6
  # promptTemplate: ~/custom-prompt.md # override the default system prompt
```

### Defaults

| Field | Default |
|-------|---------|
| `issueTracker.type` | `headless` |
| `issueTracker.branchPrefix` | `CU-` (clickup), none (headless) |
| `issueTracker.doneStatus` | none (skip status update) |
| `repos.*.remote` | `origin` |
| `repos.*.baseBranch` | `main` |
| `repos.*.platform` | `gitlab` |
| `workspace.root` | `~/worktrees` |
| `agent.model` | `claude-opus-4.6` |
| `agent.thinking` | `high` |
| `agent.scoutModel` | `claude-sonnet-4.6` |

### Config resolution order

1. `--project <name>` flag on the command
2. `MULTIFIX_PROJECT` environment variable
3. `~/.config/pi-multifix/default` file contents

### Context files

Each repo can specify `contextFiles` — paths relative to the repo root (e.g., `AGENTS.md`, `.github/copilot-instructions.md`). These are read at startup and injected into the system prompt so the agent follows your codebase conventions.

## Adapters

| Adapter | Trigger | Description |
|---------|---------|-------------|
| `clickup` | Task ID, CU-prefix, or URL | Fetches from ClickUp API, posts comments, updates status |
| `headless` | Quoted free text | No tracker — just a description. `addComment`/`updateStatus` are no-ops |

Adding new adapters (GitHub Issues, Linear, Jira) means implementing the `IssueAdapter` interface in `src/adapters/`. PRs for additional tracker integrations are welcome!

## Tools registered

| Tool | Description |
|------|-------------|
| `create_mr` | Commit + push + open MR/PR for a repo |
| `update_issue` | Buffer a comment for the issue tracker — flushed to ClickUp only when `/multifix-done` runs after merge |

## Default System Prompt

The agent receives this system prompt (with variables substituted) for each multifix session. Override it per-project via `agent.promptTemplate` in the config.

<details>
<summary>Click to expand the default prompt template</summary>

```markdown
# Bugfix Agent — {{project.name}}

## Your Role

You are an automated multifix agent working across multiple repositories. Your job is to analyze a bug report, identify the root cause across all repos, implement the fix, and create merge requests.

## Workspace Layout

{{repos_overview}}

## Bug Report

**ID:** {{bug.id}}
**Title:** {{bug.title}}
**URL:** {{bug.url}}

### Description

{{bug.description}}

### Comments

{{bug.comments}}

{{#if repo_hint}}
## Repo Hint

{{repo_hint}}
{{/if}}

{{#if extra_context}}
## Additional Context

{{extra_context}}
{{/if}}

## Codebase Conventions

{{repos_context}}

## Workflow

1. **Analyze**: Read the bug report carefully. Use the `Agent` tool with `subagent_type: "Explore"` to scout relevant code across repos if needed. Keep your own context focused on the fix.
2. **Plan**: Determine which repo(s) need changes. State your plan before coding.
3. **Fix**: Make the minimal fix. Don't refactor unrelated code. Use absolute paths for all file operations.
4. **Verify**: Run linters and tests if available in the repo.
5. **Commit & MR**: Use the `create_mr` tool for each repo that has changes. Include the bug tracker URL in MR descriptions.
6. **Update tracker**: Use the `update_issue` tool to post MR links back to the issue tracker.

## Rules

- Use **ABSOLUTE PATHS** for all file operations (read, edit, write, bash cd)
- Make minimal changes — fix the bug, don't refactor
- If a fix spans multiple repos, note deployment order in MR descriptions
- Always include the bug tracker URL in MR descriptions
- Branch naming is handled by the workspace — just commit and use `create_mr`
- If you are unsure about something, investigate before making changes

## Scout Subagents

Use the `Agent` tool to delegate research tasks:

    Agent({ subagent_type: "Explore", prompt: "Find all usages of X in <path>", description: "Find X usages" })

Use scouts for:
- Broad searches across large codebases
- Understanding unfamiliar code or dependencies
- Reading and summarizing large files
- Tracing call chains across repos

Keep your own context lean — delegate exploration, retain only the findings you need.
```

</details>

## License

MIT
