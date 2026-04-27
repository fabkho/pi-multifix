import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Convert arbitrary text into a URL/branch-friendly slug.
 * Lowercase, hyphens only, no leading/trailing hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a branch slug following the `fix/` convention.
 *
 * - With taskId:  `fix/<taskId>_<slugified-title>`
 * - Without:      `fix/<slugified-title>`  (falls back to timestamp)
 */
export function buildBranchSlug(taskId?: string, title?: string): string {
  if (taskId) {
    const slug = slugify(title || "bugfix");
    return `fix/${taskId}_${slug}`;
  }
  const slug = slugify(title || `bugfix-${Date.now()}`);
  return `fix/${slug}`;
}

// ── Workspace detection ──────────────────────────────────────────────

/**
 * Check whether a fully-formed workspace already exists for `branchSlug`.
 * Returns a repo-name → absolute-path map when **every** repo directory
 * exists, or `null` when the workspace is missing / partial.
 */
export function detectExistingWorkspace(
  config: ResolvedConfig,
  branchSlug: string,
): Record<string, string> | null {
  // Strip any prefix to get the dir slug
  const slug = branchSlug.replace(/^fix\//, "");
  const sessionDir = path.resolve(config.workspace.root, slug);

  if (!fs.existsSync(sessionDir)) return null;

  const paths: Record<string, string> = {};

  for (const [repoKey, repo] of Object.entries(config.repos)) {
    const repoName = repo.name ?? repoKey;
    // Try both the repo name and the key as dir names
    let worktreePath = path.join(sessionDir, repoName);
    if (!fs.existsSync(worktreePath)) {
      worktreePath = path.join(sessionDir, repoKey);
    }

    if (!fs.existsSync(worktreePath)) {
      return null;
    }

    paths[repoKey] = worktreePath;
  }

  return Object.keys(paths).length > 0 ? paths : null;
}

// ── Workspace creation ───────────────────────────────────────────────

/**
 * Create (or re-use) an isolated worktree workspace for a bugfix session.
 *
 * Two modes:
 * 1. **Custom script** – delegates to `config.workspace.script` with the
 *    branch slug as the sole argument. The script is expected to create
 *    worktree directories at `<workspace_root>/<slug>/<repoName>/`.
 * 2. **Generic fallback** – runs `git worktree add` for every repo in
 *    the config.
 *
 * Returns `Record<repoName, absoluteWorktreePath>`.
 */
export async function createWorkspace(
  config: ResolvedConfig,
  taskId?: string,
  title?: string,
): Promise<Record<string, string>> {
  const branchSlug = buildBranchSlug(taskId, title);

  // For custom scripts, build the arg in the script's expected format
  // (e.g., create-workspace.sh expects "CU-<id>_<name>" or just "<name>")
  const scriptArg = taskId
    ? `CU-${taskId}_${slugify(title || "bugfix")}`
    : slugify(title || `bugfix-${Date.now()}`);

  // The dir slug the script will create (matches the script's own slugify)
  // We check both our slug and the script arg format for existing workspaces
  const possibleSlugs = [
    branchSlug.replace(/^fix\//, ""),
    scriptArg.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
    scriptArg,
  ];

  // ── Check for existing workspace first ──────────────────────────
  for (const slug of possibleSlugs) {
    const existing = detectExistingWorkspace(config, `fix/${slug}`);
    if (existing) {
      return existing;
    }
    // Also try without fix/ prefix
    const existing2 = detectExistingWorkspace(config, slug);
    if (existing2) {
      return existing2;
    }
  }

  // ── Mode 1: custom script ───────────────────────────────────────
  if (config.workspace.script) {
    const script = config.workspace.script;

    if (!fs.existsSync(script)) {
      throw new Error(
        `Workspace script not found: ${script}`,
      );
    }

    try {
      execSync(`${quote(script)} ${quote(scriptArg)}`, {
        stdio: "pipe",
      });
    } catch (err) {
      const stderr = (err as any)?.stderr?.toString?.() || "";
      const msg = stderr || (err instanceof Error ? err.message : String(err));
      throw new Error(
        `Workspace script failed (${script} ${scriptArg}): ${msg.trim()}`,
      );
    }

    // Derive paths — the script creates dirs at <root>/<slug>/<repoName>/
    // The script slugifies the arg its own way, so scan the workspace root
    // for a directory matching the task ID
    const paths: Record<string, string> = {};
    const wsRoot = config.workspace.root;
    const candidates = fs.existsSync(wsRoot)
      ? fs.readdirSync(wsRoot).filter((d) => {
          const lower = d.toLowerCase();
          const argLower = scriptArg.toLowerCase();
          return lower === argLower || lower.includes(taskId?.toLowerCase() ?? "---never---");
        })
      : [];

    const sessionDir = candidates.length > 0
      ? path.resolve(wsRoot, candidates[0])
      : path.resolve(wsRoot, scriptArg);

    for (const [repoKey, repo] of Object.entries(config.repos)) {
      // Try repo.name first, then the key
      const repoName = repo.name ?? repoKey;
      const worktreePath = path.join(sessionDir, repoName);
      if (fs.existsSync(worktreePath)) {
        paths[repoKey] = worktreePath;
      } else {
        // Also try common names (anny-ui, bookings-api)
        const altPath = path.join(sessionDir, repoKey);
        if (fs.existsSync(altPath)) {
          paths[repoKey] = altPath;
        }
      }
    }

    if (Object.keys(paths).length === 0) {
      throw new Error(
        `Workspace script ran successfully but no worktree directories found at ${sessionDir}/`,
      );
    }

    return paths;
  }

  // ── Mode 2: generic git-worktree fallback ───────────────────────
  const slug = branchSlug.replace(/^fix\//, "");
  const sessionDir = path.resolve(config.workspace.root, slug);
  fs.mkdirSync(sessionDir, { recursive: true });

  const paths: Record<string, string> = {};
  const created: Array<{ repo: string; worktreePath: string }> = [];

  try {
    for (const [repoKey, repo] of Object.entries(config.repos)) {
      const repoName = repo.name ?? repoKey;
      const worktreePath = path.join(sessionDir, repoName);

      // Skip if this individual worktree already exists and is registered
      if (fs.existsSync(worktreePath)) {
        try {
          const list = execSync("git worktree list --porcelain", {
            cwd: repo.path,
            stdio: ["pipe", "pipe", "pipe"],
            encoding: "utf-8",
          });
          if (list.includes(`worktree ${worktreePath}`)) {
            paths[repoName] = worktreePath;
            continue;
          }
        } catch {
          // If we can't verify, fall through and let git worktree add decide
        }
      }

      // Resolve base ref (local branch or remote tracking)
      const baseRef = resolveBaseRef(repo.path, repo.baseBranch);

      try {
        execSync(
          `git -C ${quote(repo.path)} worktree add -b ${quote(branchSlug)} ${quote(worktreePath)} ${quote(baseRef)}`,
          { stdio: "pipe" },
        );
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to create worktree for "${repoName}" at ${worktreePath}: ${msg}`,
        );
      }

      created.push({ repo: repo.path, worktreePath });
      paths[repoName] = worktreePath;
    }
  } catch (err) {
    // Roll back any worktrees we already created in this run
    for (const { repo, worktreePath } of created) {
      try {
        execSync(
          `git -C ${quote(repo)} worktree remove -f ${quote(worktreePath)}`,
          { stdio: "pipe" },
        );
      } catch {
        // best-effort cleanup
      }
    }
    throw err;
  }

  return paths;
}

// ── Internal utilities ───────────────────────────────────────────────

/**
 * Resolve a base branch to a usable git ref.
 * Prefers the local branch; falls back to `origin/<branch>`.
 */
function resolveBaseRef(repoPath: string, branch: string): string {
  try {
    execSync(
      `git -C ${quote(repoPath)} show-ref --verify --quiet refs/heads/${branch}`,
      { stdio: "pipe" },
    );
    return branch;
  } catch {
    // local branch doesn't exist — try remote
  }

  try {
    execSync(
      `git -C ${quote(repoPath)} show-ref --verify --quiet refs/remotes/origin/${branch}`,
      { stdio: "pipe" },
    );
    return `origin/${branch}`;
  } catch {
    throw new Error(
      `Base branch "${branch}" not found in ${repoPath} (neither local nor origin/${branch})`,
    );
  }
}

/** Shell-quote a single argument. */
function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
