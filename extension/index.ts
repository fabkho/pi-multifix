/**
 * pi-multirepo — Pi extension for multi-repo tasks.
 *
 * Registers:
 *   /multirepo <task-id|text> [repo=<name>] [--project <name>] [extra context...]
 *   /multirepo-merge [comment] — merge MRs, update tracker
 *   create_mr tool
 *   update_issue tool
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import {
  createAdapter,
  type Task,
  type IssueAdapter,
} from "../src/adapters/index.js";
import { HeadlessAdapter } from "../src/adapters/headless.js";
import { createWorkspace, type ExecFn } from "../src/workspace.js";
import { renderPrompt } from "../src/prompt.js";
import {
  registerCreateMrTool,
  registerUpdateIssueTool,
  type TaskState,
} from "../src/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Serializable subset of TaskState for session persistence */
interface PersistedState {
  projectName: string;
  task: Task;
  trackerType: string;
  trackerConfig: Record<string, unknown>;
  workspacePaths: Record<string, string>;
  createdMrs: Record<string, string>;
  pendingComment: string | null;
  pendingStatus: string | null;
}

export default function (pi: ExtensionAPI) {
  // ── Session state ──────────────────────────────────────────────
  let state: TaskState | null = null;
  let pendingSystemPrompt: string | null = null;

  const getState = () => state;

  // Wrap pi.exec to match ExecFn signature
  const exec: ExecFn = async (command, args, options) => {
    return pi.exec(command, args, options);
  };

  // ── Register tools ─────────────────────────────────────────────
  registerCreateMrTool(pi, getState);
  registerUpdateIssueTool(pi, getState);

  // ── Resource discovery — register agents + prompts dirs ────────
  pi.on("resources_discover", async (_event, _ctx) => {
    const packageRoot = path.resolve(__dirname, "..");
    return {
      skillPaths: [path.join(packageRoot, "skills")],
      promptPaths: [path.join(packageRoot, "prompts")],
    };
  });

  // ── State persistence — restore on session start ───────────────
  pi.on("session_start", async (_event, ctx) => {
    state = null;

    // Scan current branch entries for persisted task state
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "multirepo-state-v2") {
        try {
          const persisted = entry.data as PersistedState;
          const config = resolveConfig(persisted.projectName);
          const adapter = createAdapter(config.issueTracker);

          state = {
            config,
            task: persisted.task,
            adapter,
            workspacePaths: persisted.workspacePaths,
            createdMrs: persisted.createdMrs,
            pendingComment: persisted.pendingComment ?? null,
            pendingStatus: persisted.pendingStatus ?? null,
          };

          // Restore status line
          updateStatusLine(ctx);
        } catch {
          // Config or adapter might have changed — ignore stale state
          state = null;
        }
      }
    }
  });

  // ── Cleanup on session shutdown ────────────────────────────────
  pi.on("session_shutdown", async (_event, ctx) => {
    state = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus("multirepo", undefined);
      ctx.ui.setWidget("multirepo-state", undefined);
    }
  });

  // ── Inject system prompt on next agent turn ────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!pendingSystemPrompt) return;

    const prompt = pendingSystemPrompt;
    pendingSystemPrompt = null;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + prompt,
    };
  });

  // ── Status line + widget helpers ─────────────────────────────────
  function updateStatusLine(ctx: { hasUI: boolean; ui: any }) {
    if (!ctx.hasUI || !state) return;
    const theme = ctx.ui.theme;

    const taskLabel = !state.task.id.startsWith("headless") ? state.task.id : "headless";
    const repos = Object.keys(state.workspacePaths).join(", ");
    const mrCount = Object.keys(state.createdMrs).length;
    const mrPart = mrCount > 0
      ? theme.fg("success", ` | ${mrCount} MR${mrCount > 1 ? "s" : ""}`)
      : "";

    ctx.ui.setStatus(
      "multirepo",
      theme.fg("accent", "🔧 ") +
      theme.fg("dim", taskLabel) +
      theme.fg("muted", ` | ${repos}`) +
      mrPart,
    );

    // Widget: one persistent line above the editor
    ctx.ui.setWidget("multirepo-state", (_tui: any, theme: any) => ({
      render(width: number): string[] {
        if (!state) return [];
        const id = !state.task.id.startsWith("headless") ? state.task.id + " " : "";
        const title = state.task.title.slice(0, 45);
        const repoParts = Object.entries(state.workspacePaths).map(([key]) =>
          state!.createdMrs[key]
            ? theme.fg("success", `${key} ✓`)
            : theme.fg("muted", key)
        );
        const total = Object.keys(state.workspacePaths).length;
        const done = Object.keys(state.createdMrs).length;
        const left =
          theme.fg("accent", "🔧 ") +
          theme.fg("warning", id) +
          theme.fg("text", title);
        const right =
          repoParts.join(theme.fg("dim", " · ")) +
          theme.fg("dim", "  MRs: ") +
          theme.fg(done > 0 ? "success" : "muted", `${done}/${total}`) +
          " ";
        const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
        return [truncateToWidth(left + pad + right, width, "")];
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  }

  // ── Persist state helper ───────────────────────────────────────
  function persistState() {
    if (!state) return;
    const persisted: PersistedState = {
      projectName: state.config.name,
      task: state.task,
      trackerType: state.config.issueTracker.type,
      trackerConfig: state.config.issueTracker as unknown as Record<string, unknown>,
      workspacePaths: state.workspacePaths,
      createdMrs: state.createdMrs,
      pendingComment: state.pendingComment,
      pendingStatus: state.pendingStatus,
    };
    pi.appendEntry("multirepo-state-v2", persisted);
  }

  // ── /multirepo command ────────────────────────────────────────────
  pi.registerCommand("multirepo", {
    description:
      "Work on a task across repos. Usage:\n" +
      "  /multirepo CU-12345\n" +
      "  /multirepo CU-12345 repo=frontend \"Extra context\"\n" +
      '  /multirepo "The booking modal crashes on save"\n' +
      "  /multirepo --project other CU-99999",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /multirepo <task-id|URL|text> [repo=<name>] [--project <name>] [context...]",
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
        let task: Task;

        if (parsed.isHeadless) {
          adapter = new HeadlessAdapter();
          task = await adapter.fetchIssue(parsed.taskRef);
        } else {
          adapter = createAdapter(config.issueTracker);
          ctx.ui.notify(`Fetching issue ${parsed.taskRef}...`, "info");
          task = await adapter.fetchIssue(parsed.taskRef);
          ctx.ui.notify(`Task: ${task.title}`, "info");
        }

        // ── 3. Create workspace ──────────────────────────────────
        ctx.ui.notify("Creating workspace...", "info");
        const workspacePaths = await createWorkspace(
          config,
          exec,
          parsed.isHeadless ? undefined : task.id,
          task.title,
        );

        const pathSummary = Object.entries(workspacePaths)
          .map(([name, p]) => `  ${name}: ${p}`)
          .join("\n");
        ctx.ui.notify(`Workspace ready:\n${pathSummary}`, "info");

        // ── 4. Store session state ───────────────────────────────
        state = { config, task, adapter, workspacePaths, createdMrs: {}, pendingComment: null, pendingStatus: null };

        // ── 5. Name the session + status line ────────────────────
        const sessionLabel = !task.id.startsWith("headless")
          ? `${task.id}: ${task.title.slice(0, 60)}`
          : task.title.slice(0, 60);
        pi.setSessionName(`🔧 ${sessionLabel}`);
        updateStatusLine(ctx);

        // ── 6. Persist state ─────────────────────────────────────
        persistState();

        // ── 7. Render system prompt ──────────────────────────────
        pendingSystemPrompt = renderPrompt(config, task, workspacePaths, {
          repoHint: parsed.repoHint,
          extraContext: parsed.extraContext,
        });

        // ── 8. Send kickoff message ──────────────────────────────
        const repoInstruction = buildRepoInstruction(parsed.repoHint, config);

        pi.sendUserMessage(
          `# Task\n\n` +
            `**${task.title}** (${task.id})\n` +
            (task.url ? `${task.url}\n\n` : "\n") +
            `${task.description}\n\n` +
            (task.comments.length > 0
              ? `## Comments\n${task.comments.map((c) => `- ${c}`).join("\n")}\n\n`
              : "") +
            (parsed.extraContext
              ? `## Additional Context\n${parsed.extraContext}\n\n`
              : "") +
            `${repoInstruction}\n\n` +
            `## Instructions\n` +
            `Analyze the task, implement the changes, then use \`create_mr\` for each repo with changes and \`update_issue\` to post MR links back.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/multirepo error: ${msg}`, "error");
      }
    },
  });

  // ── /multirepo-merge command ───────────────────────────────────────
  pi.registerCommand("multirepo-merge", {
    description:
      "Merge MR(s), update issue tracker, and optionally leave a comment.\n" +
      "  /multirepo-merge\n" +
      '  /multirepo-merge "Went with the simple fix, no backend needed"',
    handler: async (args, ctx) => {
      if (!state) {
        ctx.ui.notify("No active multirepo session. Run /multirepo first.", "error");
        return;
      }

      const { config, task, adapter, createdMrs } = state;

      if (Object.keys(createdMrs).length === 0) {
        ctx.ui.notify("No MRs were created in this session — nothing to merge.", "warning");
        return;
      }

      const results: string[] = [];
      let mergeSuccess = true;

      // ── Merge each MR ──────────────────────────────────────────
      for (const [repoKey, mrUrl] of Object.entries(createdMrs)) {
        const repo = config.repos[repoKey];
        if (!repo) continue;

        const platform = repo.platform || "gitlab";

        ctx.ui.notify(`Merging ${repoKey} MR...`, "info");

        try {
          if (platform === "gitlab") {
            const iidMatch = mrUrl.match(/merge_requests\/(\d+)/);
            const projectMatch = mrUrl.match(/gitlab\.com\/(.+?)\/-\/merge_requests/);
            if (!iidMatch) {
              results.push(`${repoKey}: ⚠ Could not parse MR ID from ${mrUrl}`);
              continue;
            }
            const glabArgs = [
              "mr", "merge", iidMatch[1],
              "--yes",
              "--remove-source-branch",
            ];
            if (projectMatch) {
              glabArgs.push("--repo", projectMatch[1]);
            }
            const mergeResult = await exec("glab", glabArgs, { timeout: 30000 });

            if (mergeResult.code === 0) {
              results.push(`${repoKey}: ✓ Merged ${mrUrl}`);
            } else {
              const errMsg = (mergeResult.stderr + " " + mergeResult.stdout).toLowerCase();
              if (errMsg.includes("401") || errMsg.includes("403") || errMsg.includes("forbidden") || errMsg.includes("not allowed") || errMsg.includes("unauthorized")) {
                results.push(`${repoKey}: ⚠ No merge rights — skipped (${mrUrl})`);
                mergeSuccess = false;
              } else {
                results.push(`${repoKey}: ✗ Merge failed — ${mergeResult.stderr || mergeResult.stdout}`);
                mergeSuccess = false;
              }
            }
          } else {
            const prMatch = mrUrl.match(/pull\/(\d+)/);
            if (!prMatch) {
              results.push(`${repoKey}: ⚠ Could not parse PR number from ${mrUrl}`);
              continue;
            }
            const mergeResult = await exec("gh", [
              "pr", "merge", prMatch[1],
              "--merge",
              "--delete-branch",
            ], { timeout: 30000 });

            if (mergeResult.code === 0) {
              results.push(`${repoKey}: ✓ Merged ${mrUrl}`);
            } else {
              const errMsg = (mergeResult.stderr + " " + mergeResult.stdout).toLowerCase();
              if (errMsg.includes("403") || errMsg.includes("forbidden") || errMsg.includes("not allowed") || errMsg.includes("unauthorized")) {
                results.push(`${repoKey}: ⚠ No merge rights — skipped (${mrUrl})`);
                mergeSuccess = false;
              } else {
                results.push(`${repoKey}: ✗ Merge failed — ${mergeResult.stderr || mergeResult.stdout}`);
                mergeSuccess = false;
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`${repoKey}: ✗ ${msg}`);
          mergeSuccess = false;
        }
      }

      // ── Run post-merge hooks ────────────────────────────────────────
      let hooksSkipped = false;
      if (!mergeSuccess) {
        results.push(`Hooks: ⚠ Skipped — one or more merges failed`);
        hooksSkipped = true;
      } else {
        const hooks = config.postMergeHooks ?? [];
        const userComment = args?.trim() || undefined;

        for (const hook of hooks) {
          try {
            if (hook.type === "clickup-comment") {
              if (!task.url || config.issueTracker.type === "headless") continue;
              const fullComment = [
                state.pendingComment,
                userComment ? `\n${userComment}` : null,
              ].filter(Boolean).join("").trim();

              if (fullComment) {
                await adapter.addComment(task.id, `✅ Merged.\n\n${fullComment}`);
                state.pendingComment = null;
                results.push(`Hook: ✓ ClickUp comment posted`);
              }
            } else if (hook.type === "clickup-status") {
              if (!task.url || config.issueTracker.type === "headless") continue;
              const status = state.pendingStatus ?? hook.status;
              if (status) {
                await adapter.updateStatus(task.id, status);
                state.pendingStatus = null;
                results.push(`Hook: ✓ ClickUp status → ${status}`);
              }
            } else {
              // Shell hook — run through /bin/sh for pipes/&&/redirects
              if (hook.cmd) {
                const fullCmd = hook.args?.length
                  ? `${hook.cmd} ${hook.args.join(" ")}`
                  : hook.cmd;
                const hookResult = await exec("/bin/sh", ["-c", fullCmd], { timeout: 30000 });
                if (hookResult.code !== 0) {
                  results.push(`Hook: ✗ ${hook.cmd} failed`);
                  if (hook.failOnError !== false) {
                    throw new Error(`Post-merge hook failed: ${hook.cmd}\n${hookResult.stderr || hookResult.stdout}`);
                  }
                } else {
                  results.push(`Hook: ✓ ${hook.cmd}`);
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`Hook: ✗ ${hook.type ?? hook.cmd} — ${msg}`);
            if (hook.failOnError !== false) {
              mergeSuccess = false;
              break;
            }
          }
        }

        persistState();
      }

      // ── Update status line ─────────────────────────────────────
      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        if (mergeSuccess && !hooksSkipped) {
          ctx.ui.setStatus("multirepo", theme.fg("success", "✓ ") + theme.fg("dim", "multirepo done"));
          ctx.ui.setWidget("multirepo-state", undefined);
        } else {
          ctx.ui.setStatus("multirepo", theme.fg("error", "✗ ") + theme.fg("dim", "merge incomplete — check results"));
        }
      }

      ctx.ui.notify(results.join("\n"), "info");
    },
  });

  // ── Update state when MRs are created ───────────────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (!state) return;

    if (event.toolName === "create_mr") {
      const details = event.details as { repo?: string; url?: string; skipped?: boolean } | undefined;
      if (details?.repo && details?.url && !details?.skipped) {
        state.createdMrs[details.repo] = details.url;
        updateStatusLine(ctx);
        persistState();
      }
    }

    if (event.toolName === "update_issue") {
      // pendingComment/pendingStatus were already set by the tool execute;
      // persist now so a reload before /multirepo-merge doesn't lose them
      persistState();
    }

    // Catch MR/PR URLs created via bash fallback (agent used glab/gh directly)
    if (event.toolName === "bash") {
      const text = Array.isArray(event.content)
        ? event.content.map((c: any) => c.type === "text" ? c.text : "").join("")
        : "";

      const mrUrl =
        text.match(/https:\/\/gitlab\.com\/[^\s]+\/-\/merge_requests\/\d+/)?.[0] ??
        text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];

      if (mrUrl && !Object.values(state.createdMrs).includes(mrUrl)) {
        // Match URL to a repo by name
        const repoKey = Object.entries(state.config.repos).find(([key, repo]) => {
          const name = (repo.name ?? key).toLowerCase();
          const dirName = repo.path.split("/").pop()?.toLowerCase() ?? "";
          const urlLower = mrUrl.toLowerCase();
          return urlLower.includes(name) || urlLower.includes(dirName);
        })?.[0];

        if (repoKey) {
          state.createdMrs[repoKey] = mrUrl;
          updateStatusLine(ctx);
          persistState();
        }
      }
    }
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

  const firstToken = tokens[0];
  const isHeadless = isFreetextInput(firstToken);

  const taskRef = isHeadless ? tokens.join(" ") : firstToken;
  const extraContext = isHeadless ? undefined : tokens.slice(1).join(" ") || undefined;

  return { taskRef, isHeadless, repoHint, project, extraContext };
}

function isFreetextInput(input: string): boolean {
  if (input.startsWith("http://") || input.startsWith("https://")) return false;
  if (/^CU-/i.test(input)) return false;
  if (/^[a-z0-9]{1,20}$/i.test(input)) return false;
  return true;
}

function buildRepoInstruction(
  repoHint: string | undefined,
  config: ResolvedConfig,
): string {
  if (!repoHint) {
    return (
      "## Repo Routing\n" +
      "No repo was specified. Analyze the task to determine which repo(s) are affected. " +
      "Use the `Agent` tool with `subagent_type: \"Explore\"` to scout both repos if needed."
    );
  }

  const repoNames = Object.keys(config.repos);
  const otherRepos = repoNames.filter((r) => r !== repoHint);

  return (
    `## Repo Routing\n` +
    `The user specified **repo=${repoHint}**. The task is known to be in this repo — focus your fix there.\n` +
    (otherRepos.length > 0
      ? `Also check ${otherRepos.map((r) => `**${r}**`).join(", ")} for secondary impact.`
      : "")
  );
}
