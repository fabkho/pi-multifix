/**
 * bugfix-agent — Pi extension for multi-repo bugfixing.
 *
 * Registers:
 *   /bugfix <task-id|text> [repo=<name>] [--project <name>] [extra context...]
 *   create_mr tool
 *   update_issue tool
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import {
  createAdapter,
  type Bug,
  type IssueAdapter,
} from "../src/adapters/index.js";
import { ClickUpAdapter } from "../src/adapters/clickup.js";
import { HeadlessAdapter } from "../src/adapters/headless.js";
import { createWorkspace } from "../src/workspace.js";
import { renderPrompt } from "../src/prompt.js";
import {
  registerCreateMrTool,
  registerUpdateIssueTool,
  type BugfixState,
} from "../src/tools.js";

export default function (pi: ExtensionAPI) {
  // ── Session state ──────────────────────────────────────────────
  let state: BugfixState | null = null;
  let pendingSystemPrompt: string | null = null;

  const getState = () => state;

  // ── Register tools ─────────────────────────────────────────────
  registerCreateMrTool(pi, getState);
  registerUpdateIssueTool(pi, getState);

  // ── Inject system prompt on next agent turn ────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!pendingSystemPrompt) return;

    const prompt = pendingSystemPrompt;
    pendingSystemPrompt = null;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + prompt,
    };
  });

  // ── /bugfix command ────────────────────────────────────────────
  pi.registerCommand("bugfix", {
    description:
      "Fix a bug across repos. Usage:\n" +
      "  /bugfix CU-12345\n" +
      "  /bugfix CU-12345 repo=frontend \"Extra context\"\n" +
      '  /bugfix "The booking modal crashes on save"\n' +
      "  /bugfix --project other CU-99999",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /bugfix <task-id|URL|text> [repo=<name>] [--project <name>] [context...]",
          "warning",
        );
        return;
      }

      try {
        // ── Parse arguments ──────────────────────────────────────
        const parsed = parseArgs(args.trim());

        ctx.ui.notify(`Loading project "${parsed.project || "default"}"...`, "info");

        // ── 1. Load config ───────────────────────────────────────
        const config = resolveConfig(parsed.project);

        // ── 2. Create adapter + fetch issue ──────────────────────
        let adapter: IssueAdapter;
        let bug: Bug;

        if (parsed.isHeadless) {
          // Free-text mode — no tracker fetch
          adapter = new HeadlessAdapter();
          bug = await adapter.fetchIssue(parsed.taskRef);
        } else {
          adapter = createAdapter(config.issueTracker.type, {
            tokenEnv: config.issueTracker.tokenEnv,
          });
          ctx.ui.notify(`Fetching issue ${parsed.taskRef}...`, "info");
          bug = await adapter.fetchIssue(parsed.taskRef);
          ctx.ui.notify(`Bug: ${bug.title}`, "info");
        }

        // ── 3. Create workspace ──────────────────────────────────
        ctx.ui.notify("Creating workspace...", "info");
        const workspacePaths = await createWorkspace(
          config,
          parsed.isHeadless ? undefined : bug.id,
          bug.title,
        );

        const pathSummary = Object.entries(workspacePaths)
          .map(([name, p]) => `  ${name}: ${p}`)
          .join("\n");
        ctx.ui.notify(`Workspace ready:\n${pathSummary}`, "info");

        // ── 4. Store session state ───────────────────────────────
        state = { config, bug, adapter, workspacePaths };

        // ── 5. Render system prompt ──────────────────────────────
        pendingSystemPrompt = renderPrompt(config, bug, workspacePaths, {
          repoHint: parsed.repoHint,
          extraContext: parsed.extraContext,
        });

        // ── 6. Send kickoff message ──────────────────────────────
        const repoInstruction = buildRepoInstruction(parsed.repoHint, config);

        pi.sendUserMessage(
          `# Bug Fix Task\n\n` +
            `**${bug.title}** (${bug.id})\n` +
            (bug.url ? `${bug.url}\n\n` : "\n") +
            `${bug.description}\n\n` +
            (bug.comments.length > 0
              ? `## Comments\n${bug.comments.map((c) => `- ${c}`).join("\n")}\n\n`
              : "") +
            (parsed.extraContext
              ? `## Additional Context\n${parsed.extraContext}\n\n`
              : "") +
            `${repoInstruction}\n\n` +
            `## Instructions\n` +
            `Analyze this bug, fix it, then use \`create_mr\` for each repo with changes and \`update_issue\` to post MR links back.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/bugfix error: ${msg}`, "error");
      }
    },
  });

  // ── /bugfix-status command ─────────────────────────────────────
  pi.registerCommand("bugfix-status", {
    description: "Show current bugfix session state",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("No active bugfix session. Run /bugfix first.", "info");
        return;
      }

      const lines = [
        `**Project:** ${state.config.name}`,
        `**Bug:** ${state.bug.title} (${state.bug.id})`,
        `**Status:** ${state.bug.status}`,
        `**Repos:**`,
        ...Object.entries(state.workspacePaths).map(
          ([name, p]) => `  - ${name}: ${p}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

// ── Argument parsing ─────────────────────────────────────────────────

interface ParsedArgs {
  taskRef: string;
  isHeadless: boolean;
  repoHint?: string;
  project?: string;
  extraContext?: string;
}

function parseArgs(input: string): ParsedArgs {
  const tokens: string[] = [];
  let repoHint: string | undefined;
  let project: string | undefined;

  // Tokenize respecting quoted strings
  const regex = /--project\s+(\S+)|repo=(\S+)|"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    if (match[1] !== undefined) {
      project = match[1];
    } else if (match[2] !== undefined) {
      repoHint = match[2];
    } else if (match[3] !== undefined) {
      tokens.push(match[3]);
    } else if (match[4] !== undefined) {
      tokens.push(match[4]);
    } else if (match[5] !== undefined) {
      tokens.push(match[5]);
    }
  }

  if (tokens.length === 0) {
    throw new Error("No task ID or description provided.");
  }

  // First token is the task ref. Determine if it's a tracker ID or free text.
  const firstToken = tokens[0];
  const isHeadless = isFreetextInput(firstToken);

  // If headless with multiple tokens, join them all as the description
  const taskRef = isHeadless ? tokens.join(" ") : firstToken;
  const extraContext = isHeadless ? undefined : tokens.slice(1).join(" ") || undefined;

  return { taskRef, isHeadless, repoHint, project, extraContext };
}

/**
 * Determine if the input is free-text (headless) rather than a task ID.
 * A task ID looks like: CU-xxx, a short alphanumeric string, or a URL.
 */
function isFreetextInput(input: string): boolean {
  // ClickUp URL
  if (input.startsWith("http://") || input.startsWith("https://")) return false;
  // CU-prefixed
  if (/^CU-/i.test(input)) return false;
  // Short alphanumeric ID (up to 20 chars, no spaces)
  if (/^[a-z0-9]{1,20}$/i.test(input)) return false;
  // Everything else is free text
  return true;
}

/**
 * Build repo routing instructions based on the optional hint.
 */
function buildRepoInstruction(
  repoHint: string | undefined,
  config: ResolvedConfig,
): string {
  if (!repoHint) {
    return (
      "## Repo Routing\n" +
      "No repo was specified. Analyze the bug to determine which repo(s) are affected. " +
      "Use the `Agent` tool with `subagent_type: \"Explore\"` to scout both repos if needed."
    );
  }

  const repoNames = Object.keys(config.repos);
  const otherRepos = repoNames.filter((r) => r !== repoHint);

  return (
    `## Repo Routing\n` +
    `The user specified **repo=${repoHint}**. The bug is known to be in this repo — focus your fix there.\n` +
    (otherRepos.length > 0
      ? `Also check ${otherRepos.map((r) => `**${r}**`).join(", ")} for secondary impact.`
      : "")
  );
}
