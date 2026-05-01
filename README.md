# pi-multirepo

A [pi](https://github.com/badlogic/pi-mono) extension for working across multiple repositories. Fetches tasks from ClickUp (or free-text), creates isolated git worktree workspaces, implements the changes, runs pre-MR hooks, creates merge requests, and runs post-merge hooks (tracker comments, status updates, custom scripts).

## Features

- **Multi-repo** — works across multiple repositories in a single session using absolute paths
- **ClickUp integration** — fetches task details, posts MR links after merge, updates task status
- **Headless mode** — describe a task in free text without an issue tracker
- **Git worktree isolation** — each task gets its own branches, your working copy stays clean
- **Auto-symlinks** — `node_modules` and `vendor/` symlinked from main repo for instant setup
- **preMRHooks** — per-repo hooks (linters, formatters, tests) run before each `create_mr`
- **postMergeHooks** — project-level hooks after `/multirepo-merge` (tracker comments, status updates, shell scripts)
- **State widget** — persistent display above the editor showing task, repos, and MR progress
- **MR/PR creation** — `create_mr` tool pushes and opens merge requests via `glab` (GitLab) or `gh` (GitHub)
- **Scout subagents** — delegates research to cheaper/faster models via the `Agent` tool
- **Project configs** — YAML-based per-project configuration, reusable across different multi-repo setups
- **Session persistence** — multirepo state survives reloads and session resume

## Install

```bash
pi install npm:pi-multirepo
```

Or from git:

```bash
pi install git:github.com/fabkho/pi-multirepo
```

### Prerequisites

- [pi](https://github.com/badlogic/pi-mono)
- `glab` (GitLab CLI) and/or `gh` (GitHub CLI) installed and authenticated
- `CLICKUP_API_TOKEN` environment variable set (for ClickUp mode)

### Setup

```bash
# 1. Create your project config
mkdir -p ~/.config/pi-multirepo
cp configs/anny.yaml ~/.config/pi-multirepo/my-project.yaml
# Edit with your repos, paths, tokens

# 2. Set a default project (optional — avoids --project flag)
echo "my-project" > ~/.config/pi-multirepo/default
```

## Usage

### Start a task

```
/multirepo CU-12345                                          # ClickUp task ID
/multirepo CU-12345 repo=frontend                            # hint which repo is affected
/multirepo CU-12345 repo=backend "The API returns 500"       # with extra context
/multirepo https://app.clickup.com/t/86abc123                # ClickUp URL
/multirepo "Add dark mode toggle to settings page"           # headless mode (no tracker)
/multirepo --project other-project CU-99999                  # different project config
```

### Merge and run post-merge hooks

```
/multirepo-merge                                             # merge MR(s), run postMergeHooks
/multirepo-merge "Simple i18n fix, no backend changes"       # append a note to the tracker comment
```

Merges all MR(s) created in the session, then runs `postMergeHooks` in order. Any note passed to `/multirepo-merge` is appended to the tracker comment.

> **Note:** `update_issue` does **not** post to the tracker immediately — it buffers the comment until `/multirepo-merge` runs. This ensures nothing is posted before the changes are actually merged.

## What happens when you run `/multirepo`

1. **Loads project config** from `~/.config/pi-multirepo/<project>.yaml`
2. **Fetches the task** from ClickUp (or creates a headless task from your text)
3. **Creates worktrees** for each repo on a fresh branch
4. **Symlinks** `node_modules` and `vendor/` from the main repos
5. **Shows the state widget** — task ID, title, repos, MR progress
6. **Injects a system prompt** with repo paths, codebase conventions, and workflow instructions
7. **The agent analyzes** the task across all repos
8. **Implements the changes**, using scout subagents for research to keep context lean
9. **Runs preMRHooks** (linters, formatters, tests) per repo before committing
10. **Creates MR(s)** via `glab mr create` / `gh pr create`
11. **Buffers the tracker comment** — `update_issue` stores the comment in session state
12. **`/multirepo-merge`** merges all MRs, then runs `postMergeHooks`

## Project Config

YAML config files live at `~/.config/pi-multirepo/<name>.yaml`.

### Minimal config

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
  branchPrefix: CU-                   # auto-set per tracker type, override here
  clickup:
    tokenEnv: CLICKUP_API_TOKEN       # env var holding the API token

repos:
  frontend:
    path: ~/code/my-project/frontend  # required
    remote: origin                    # default: origin
    baseBranch: main                  # default: main
    platform: gitlab                  # gitlab | github (default: gitlab)
    contextFiles:                     # files read into the agent's system prompt
      - .github/copilot-instructions.md
    preMRHooks:                       # run before create_mr for this repo
      - cmd: yarn
        args: [lint:fix]
  backend:
    path: ~/code/my-project/backend
    contextFiles:
      - .github/copilot-instructions.md
      - AGENTS.md
    preMRHooks:
      - cmd: ./vendor/bin/pint
      - cmd: ./vendor/bin/phpstan
        args: [analyse, --memory-limit=2G]

postMergeHooks:                       # run after /multirepo-merge
  - type: clickup-comment             # posts the comment the agent wrote via update_issue
  - type: clickup-status
    status: code review
  # - cmd: ./scripts/notify-slack.sh  # arbitrary shell command

workspace:
  root: ~/code/my-project/worktrees
  # script: ~/bin/create-workspace.sh # optional custom creation script

agent:
  model: claude-opus-4.6
  thinking: high
  scoutModel: claude-sonnet-4.6
  # promptTemplate: ~/custom-prompt.md
```

### Hooks

#### preMRHooks (per repo)

Run in the worktree directory before `create_mr` stages and commits. If a hook exits non-zero, the MR creation is aborted.

```yaml
preMRHooks:
  - cmd: ./vendor/bin/pint              # auto-fix code style
  - cmd: ./vendor/bin/phpstan
    args: [analyse, --memory-limit=2G]
  - cmd: yarn
    args: [test]
    failOnError: false                  # warn only, don't block the MR
```

#### postMergeHooks (project level)

Run after `/multirepo-merge` successfully merges all MRs. Supports built-in types and shell commands:

| Type | Description |
|------|-------------|
| `clickup-comment` | Posts the buffered `update_issue` comment to ClickUp |
| `clickup-status` | Sets the ClickUp task status (requires `status` field) |
| shell (`cmd`) | Runs an arbitrary command |

```yaml
postMergeHooks:
  - type: clickup-comment
  - type: clickup-status
    status: code review
  - cmd: ./scripts/deploy-staging.sh
```

### Defaults

| Field | Default |
|-------|---------|
| `issueTracker.type` | `headless` |
| `issueTracker.branchPrefix` | `CU-` (clickup), none (headless) |
| `repos.*.remote` | `origin` |
| `repos.*.baseBranch` | `main` |
| `repos.*.platform` | `gitlab` |
| `workspace.root` | `~/worktrees` |
| `agent.model` | `claude-opus-4.6` |
| `agent.thinking` | `high` |
| `agent.scoutModel` | `claude-sonnet-4.6` |

### Config resolution order

1. `--project <name>` flag on the command
2. `MULTIREPO_PROJECT` environment variable
3. `~/.config/pi-multirepo/default` file contents

### Context files

Each repo can specify `contextFiles` — paths relative to the repo root (e.g., `AGENTS.md`, `.github/copilot-instructions.md`). These are read at startup and injected into the system prompt so the agent follows your codebase conventions.

## Adapters

| Adapter | Trigger | Description |
|---------|---------|-------------|
| `clickup` | Task ID, CU-prefix, or URL | Fetches from ClickUp API, posts comments, updates status |
| `headless` | Quoted free text | No tracker — just a description. `addComment`/`updateStatus` are no-ops |

Adding new adapters (GitHub Issues, Linear, Jira) means implementing the `IssueAdapter` interface in `src/adapters/`. PRs welcome!

## Tools registered

| Tool | Description |
|------|-------------|
| `create_mr` | Run preMRHooks + commit + push + open MR/PR for a repo |
| `update_issue` | Buffer a tracker comment — posted when `/multirepo-merge` runs the `clickup-comment` hook |

## License

MIT
