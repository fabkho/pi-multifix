import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ResolvedConfig } from "./config.js";
import type { Bug, IssueAdapter } from "./adapters/types.js";

// ── State interface ──────────────────────────────────────────────────

export interface BugfixState {
  config: ResolvedConfig;
  bug: Bug;
  adapter: IssueAdapter;
  workspacePaths: Record<string, string>;
  /** MR/PR URLs created during this session, keyed by repo name */
  createdMrs: Record<string, string>;
  /** Buffered comment from update_issue — posted to tracker only after MRs are merged */
  pendingComment: string | null;
  /** Buffered status from update_issue — applied to tracker only after MRs are merged */
  pendingStatus: string | null;
}

export type StateGetter = () => BugfixState | null;

// ── Tool 1: create_mr ────────────────────────────────────────────────

export function registerCreateMrTool(
  pi: ExtensionAPI,
  getState: StateGetter,
) {
  pi.registerTool({
    name: "create_mr",
    label: "Create MR/PR",
    description:
      "Commit all staged changes in a repo worktree, push the branch, and open a merge request (GitLab) or pull request (GitHub). Returns the MR/PR URL on success.",
    promptSnippet:
      "Commit changes and create a merge request/pull request for a repo",
    promptGuidelines: [
      "Use create_mr after applying fixes to a repo to commit, push, and open a merge request or pull request. Call it once per repo that has changes.",
      "Pass the repo key from the project config (e.g. \"frontend\", \"backend\") as the repo parameter to create_mr.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repo name key from the project config (e.g. \"frontend\", \"backend\")" }),
      title: Type.String({ description: "MR/PR title" }),
      body: Type.String({ description: "MR/PR description in markdown" }),
      base_branch: Type.Optional(
        Type.String({ description: "Override the base branch from config" }),
      ),
    }),

    async execute(toolCallId, params, signal) {
      const state = getState();
      if (!state) {
        throw new Error("Multifix session not active — run /multifix first");
      }

      const { config, bug, workspacePaths } = state;

      // Look up repo config
      const repoConfig = config.repos[params.repo];
      if (!repoConfig) {
        const available = Object.keys(config.repos).join(", ");
        throw new Error(
          `Unknown repo "${params.repo}". Available repos: ${available}`,
        );
      }

      // Look up worktree path
      const worktreePath = workspacePaths[params.repo];
      if (!worktreePath) {
        throw new Error(
          `No worktree path found for repo "${params.repo}". Was the workspace set up?`,
        );
      }

      const remote = repoConfig.remote;
      const baseBranch = params.base_branch ?? repoConfig.baseBranch;
      const platform = repoConfig.platform;

      // Auto-append bug URL to body
      let body = params.body;
      if (bug.url) {
        body += `\n\n---\nRelated: ${bug.url}`;
      }

      // Stage all changes
      const addResult = await pi.exec("git", ["add", "-A"], {
        cwd: worktreePath,
        signal,
      });
      if (addResult.code !== 0) {
        throw new Error(`git add failed: ${addResult.stderr}`);
      }

      // Check if there are staged changes
      const diffResult = await pi.exec(
        "git",
        ["diff", "--cached", "--quiet"],
        { cwd: worktreePath, signal },
      );
      if (diffResult.code === 0) {
        return {
          content: [
            { type: "text" as const, text: `No changes in ${params.repo} — nothing to commit.` },
          ],
          details: { repo: params.repo, skipped: true as boolean, url: undefined as string | undefined, platform: undefined as string | undefined },
        };
      }

      // Commit
      const commitResult = await pi.exec(
        "git",
        ["commit", "-m", params.title],
        { cwd: worktreePath, signal },
      );
      if (commitResult.code !== 0) {
        throw new Error(`git commit failed: ${commitResult.stderr}`);
      }

      // Push
      const pushResult = await pi.exec(
        "git",
        ["push", "-u", remote, "HEAD"],
        { cwd: worktreePath, signal },
      );
      if (pushResult.code !== 0) {
        throw new Error(`git push failed: ${pushResult.stderr}`);
      }

      // Create MR/PR
      let createResult;
      if (platform === "gitlab") {
        createResult = await pi.exec(
          "glab",
          [
            "mr",
            "create",
            "--title",
            params.title,
            "--description",
            body,
            "--target-branch",
            baseBranch,
            "--yes",
          ],
          { cwd: worktreePath, signal },
        );
      } else {
        createResult = await pi.exec(
          "gh",
          [
            "pr",
            "create",
            "--title",
            params.title,
            "--body",
            body,
            "--base",
            baseBranch,
          ],
          { cwd: worktreePath, signal },
        );
      }

      if (createResult.code !== 0) {
        throw new Error(
          `${platform === "gitlab" ? "glab mr create" : "gh pr create"} failed: ${createResult.stderr}`,
        );
      }

      // Parse URL from output (both glab and gh print the URL as the last line or in output)
      const output = (createResult.stdout + "\n" + createResult.stderr).trim();
      const urlMatch = output.match(/https?:\/\/\S+/);
      const mrUrl = urlMatch ? urlMatch[0] : output;

      // Track the MR URL in session state
      state.createdMrs[params.repo] = mrUrl;

      return {
        content: [
          {
            type: "text" as const,
            text: `Created ${platform === "gitlab" ? "MR" : "PR"} for ${params.repo}: ${mrUrl}`,
          },
        ],
        details: { repo: params.repo, skipped: false as boolean, url: mrUrl as string | undefined, platform: platform as string | undefined },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("create_mr "));
      if (args.repo) {
        content += theme.fg("accent", args.repo);
      }
      if (args.title) {
        content += " " + theme.fg("dim", `"${args.title}"`);
      }
      text.setText(content);
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Creating MR/PR..."));
        return text;
      }
      const details = result.details as
        | { repo?: string; url?: string; skipped?: boolean }
        | undefined;
      if (details?.skipped) {
        text.setText(theme.fg("muted", `No changes in ${details.repo}`));
      } else if (details?.url) {
        text.setText(
          theme.fg("success", "✓ ") +
            theme.fg("accent", details.url),
        );
      } else {
        const msg =
          result.content?.[0]?.type === "text"
            ? (result.content[0] as { text: string }).text
            : "Done";
        text.setText(msg);
      }
      return text;
    },
  });
}

// ── Tool 2: update_issue ─────────────────────────────────────────────

export function registerUpdateIssueTool(
  pi: ExtensionAPI,
  getState: StateGetter,
) {
  pi.registerTool({
    name: "update_issue",
    label: "Update Issue",
    description:
      "Post a comment to the issue tracker and optionally update the task status. Use this after creating MR(s) to link them back to the original issue.",
    promptSnippet:
      "Post MR links and status updates back to the issue tracker",
    promptGuidelines: [
      "Use update_issue after create_mr to post the MR/PR URL back to the issue tracker so stakeholders can find it.",
      "When calling update_issue, include the MR/PR URLs and a short summary of what was fixed in the comment.",
    ],
    parameters: Type.Object({
      comment: Type.String({ description: "Comment text to post (typically MR/PR URLs and a summary)" }),
      status: Type.Optional(
        Type.String({ description: 'New status to set on the task (e.g. "in review")' }),
      ),
    }),

    async execute(toolCallId, params) {
      const state = getState();
      if (!state) {
        throw new Error("Multifix session not active — run /multifix first");
      }

      const { bug } = state;

      // Headless mode: no real issue tracker
      if (!bug.url || state.config.issueTracker.type === "headless") {
        return {
          content: [
            { type: "text" as const, text: "No issue tracker — skipping update." },
          ],
          details: { skipped: true as boolean, bugId: undefined as string | undefined, buffered: false as boolean },
        };
      }

      // Buffer the comment and status — both will be posted to the tracker only after MRs are merged via /multifix-done
      state.pendingComment = params.comment;
      state.pendingStatus = params.status ?? null;

      const buffered = [`comment`];
      if (params.status) buffered.push(`status → "${params.status}"`);

      return {
        content: [
          {
            type: "text" as const,
            text: `Buffered ${buffered.join(" and ")} — will be posted to ${bug.url} after MRs are merged via /multifix-done.`,
          },
        ],
        details: { skipped: false as boolean, bugId: bug.id as string | undefined, buffered: true as boolean },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("update_issue "));
      if (args.status) {
        content += theme.fg("accent", `→ ${args.status} `);
      }
      if (args.comment) {
        const preview =
          args.comment.length > 60
            ? args.comment.slice(0, 57) + "..."
            : args.comment;
        content += theme.fg("dim", `"${preview}"`);
      }
      text.setText(content);
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Updating issue..."));
        return text;
      }
      const details = result.details as
        | { skipped?: boolean; buffered?: boolean }
        | undefined;
      if (details?.skipped) {
        text.setText(theme.fg("muted", "No issue tracker — skipped"));
      } else if (details?.buffered) {
        text.setText(theme.fg("warning", "⏳ Comment buffered — posts after merge"));
      } else {
        text.setText(theme.fg("success", "✓ Comment posted"));
      }
      return text;
    },
  });
}
