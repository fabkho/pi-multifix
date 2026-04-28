import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";

/**
 * Async shell exec function — matches pi.exec() signature.
 * Workspace module accepts this as a dependency so it doesn't block pi's event loop.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

// ── Helpers ──────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildBranchSlug(taskId?: string, title?: string): string {
  if (taskId) {
    const slug = slugify(title || "bugfix");
    // Prefix with CU- to trigger ClickUp automations
    const normalizedId = taskId.startsWith("CU-") ? taskId : `CU-${taskId}`;
    return `fix/${normalizedId}_${slug}`;
  }
  const slug = slugify(title || `bugfix-${Date.now()}`);
  return `fix/${slug}`;
}

// ── Workspace detection ──────────────────────────────────────────────

export function detectExistingWorkspace(
  config: ResolvedConfig,
  branchSlug: string,
): Record<string, string> | null {
  const slug = branchSlug.replace(/^fix\//, "");
  const sessionDir = path.resolve(config.workspace.root, slug);

  if (!fs.existsSync(sessionDir)) return null;

  const paths: Record<string, string> = {};

  for (const [repoKey, repo] of Object.entries(config.repos)) {
    const repoName = repo.name ?? repoKey;
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

// ── Resolve base ref ─────────────────────────────────────────────────

async function resolveBaseRef(
  exec: ExecFn,
  repoPath: string,
  branch: string,
): Promise<string> {
  const local = await exec("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code === 0) return branch;

  const remote = await exec("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  if (remote.code === 0) return `origin/${branch}`;

  throw new Error(`Base branch "${branch}" not found in ${repoPath} (neither local nor origin/${branch})`);
}

// ── Workspace creation ───────────────────────────────────────────────

export async function createWorkspace(
  config: ResolvedConfig,
  exec: ExecFn,
  taskId?: string,
  title?: string,
): Promise<Record<string, string>> {
  const branchSlug = buildBranchSlug(taskId, title);
  const slug = branchSlug.replace(/^fix\//, "");

  // ── Check for existing workspace ────────────────────────────────
  const existing = detectExistingWorkspace(config, branchSlug);
  if (existing) return existing;

  if (taskId) {
    const cuSlug = `CU-${taskId}_${slugify(title || "bugfix")}`;
    const existing2 = detectExistingWorkspace(config, cuSlug);
    if (existing2) return existing2;
  }

  // ── Custom script mode ──────────────────────────────────────────
  if (config.workspace.script) {
    const script = config.workspace.script;
    if (!fs.existsSync(script)) {
      throw new Error(`Workspace script not found: ${script}`);
    }

    const scriptArg = taskId
      ? `CU-${taskId}_${slugify(title || "bugfix")}`
      : slugify(title || `bugfix-${Date.now()}`);

    const result = await exec(script, [scriptArg], { timeout: 30000 });
    if (result.code !== 0) {
      throw new Error(`Workspace script failed: ${result.stderr || result.stdout}`);
    }

    // Find created dir
    const wsRoot = config.workspace.root;
    const candidates = fs.existsSync(wsRoot)
      ? fs.readdirSync(wsRoot).filter((d) =>
          d.toLowerCase().includes(taskId?.toLowerCase() ?? "---"))
      : [];

    const sessionDir = candidates.length > 0
      ? path.resolve(wsRoot, candidates[0])
      : path.resolve(wsRoot, scriptArg);

    const paths: Record<string, string> = {};
    for (const [repoKey, repo] of Object.entries(config.repos)) {
      const repoName = repo.name ?? repoKey;
      const p = path.join(sessionDir, repoName);
      if (fs.existsSync(p)) { paths[repoKey] = p; continue; }
      const p2 = path.join(sessionDir, repoKey);
      if (fs.existsSync(p2)) { paths[repoKey] = p2; }
    }

    if (Object.keys(paths).length === 0) {
      throw new Error(`Workspace script ran but no worktree dirs found at ${sessionDir}/`);
    }
    return paths;
  }

  // ── Generic git worktree mode ───────────────────────────────────
  const sessionDir = path.resolve(config.workspace.root, slug);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Prune stale worktree references before creating new ones
  for (const [, repo] of Object.entries(config.repos)) {
    await exec("git", ["-C", repo.path, "worktree", "prune"]);
  }

  const paths: Record<string, string> = {};
  const created: Array<{ repoPath: string; worktreePath: string }> = [];

  try {
    for (const [repoKey, repo] of Object.entries(config.repos)) {
      const repoName = repo.name ?? repoKey;
      const worktreePath = path.join(sessionDir, repoName);

      if (fs.existsSync(worktreePath)) {
        paths[repoKey] = worktreePath;
        continue;
      }

      const baseRef = await resolveBaseRef(exec, repo.path, repo.baseBranch);

      const result = await exec("git", [
        "-C", repo.path,
        "worktree", "add",
        "-b", branchSlug,
        worktreePath,
        baseRef,
      ]);

      if (result.code !== 0) {
        throw new Error(`Failed to create worktree for "${repoName}": ${result.stderr}`);
      }

      // Symlink node_modules from the main repo into the worktree
      // so tools like MCP servers that need dependencies work properly
      const mainNodeModules = path.join(repo.path, "node_modules");
      const wtNodeModules = path.join(worktreePath, "node_modules");
      if (fs.existsSync(mainNodeModules) && !fs.existsSync(wtNodeModules)) {
        fs.symlinkSync(mainNodeModules, wtNodeModules, "dir");
      }

      // Also symlink vendor/ for PHP repos (Laravel)
      const mainVendor = path.join(repo.path, "vendor");
      const wtVendor = path.join(worktreePath, "vendor");
      if (fs.existsSync(mainVendor) && !fs.existsSync(wtVendor)) {
        fs.symlinkSync(mainVendor, wtVendor, "dir");
      }

      created.push({ repoPath: repo.path, worktreePath });
      paths[repoKey] = worktreePath;
    }
  } catch (err) {
    // Rollback
    for (const { repoPath, worktreePath } of created) {
      await exec("git", ["-C", repoPath, "worktree", "remove", "-f", worktreePath]).catch(() => {});
    }
    throw err;
  }

  return paths;
}
