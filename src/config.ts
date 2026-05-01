import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

// ── Interfaces ───────────────────────────────────────────────────────

export interface PreMRHook {
  /** Shell command to run (e.g. "./vendor/bin/pint") */
  cmd: string;
  /** Extra arguments appended to cmd */
  args?: string[];
  /** Block the MR if this hook exits non-zero. Default: true */
  failOnError?: boolean;
}

export type PostMergeHookType = "clickup-comment" | "clickup-status" | "shell";

export interface PostMergeHook {
  /** Built-in hook type, or omit for shell */
  type?: PostMergeHookType;
  /** Shell command — used when type is omitted or "shell" */
  cmd?: string;
  args?: string[];
  /** Status value — used with type: clickup-status */
  status?: string;
  /** Block on failure. Default: true */
  failOnError?: boolean;
}

export interface RepoConfig {
  name: string;
  path: string;
  remote: string;
  baseBranch: string;
  contextFile?: string;
  contextFiles?: string[];
  platform: "gitlab" | "github";
  /** Commands to run in the worktree before git add / commit */
  preMRHooks?: PreMRHook[];
}

export interface WorkspaceConfig {
  root: string;
  script?: string;
}

export interface AgentConfig {
  model: string;
  thinking: string;
  scoutModel: string;
  promptTemplate?: string;
}

export interface IssueTrackerConfig {
  type: "clickup" | "headless";
  /** Prefix for branch names (e.g., "CU-" for ClickUp, "LIN-" for Linear). Default: none */
  branchPrefix?: string;
  /** Status to set when /multirepo-merge runs (e.g., "code review", "done"). Default: none (skip status update) */
  doneStatus?: string;
  /** Adapter-specific config — keyed by type name */
  [adapterType: string]: unknown;
}

/** ClickUp-specific config */
export interface ClickUpTrackerConfig {
  tokenEnv?: string;  // default: CLICKUP_API_TOKEN
}

/** Linear-specific config (future) */
export interface LinearTrackerConfig {
  tokenEnv?: string;
  teamId?: string;
}

export interface ProjectConfig {
  name: string;
  repos: Record<string, RepoConfig>;
  issueTracker: IssueTrackerConfig;
  workspace: WorkspaceConfig;
  agent: AgentConfig;
  postMergeHooks?: PostMergeHook[];
}

export interface ResolvedRepoConfig extends RepoConfig {
  contextContent?: string;
}

export interface ResolvedConfig extends Omit<ProjectConfig, "repos"> {
  repos: Record<string, ResolvedRepoConfig>;
}

// ── Helpers ──────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".config", "pi-multirepo");
const LEGACY_CONFIG_DIR = join(homedir(), ".config", "pi-multifix");

/** Default branch prefixes per tracker type (for automation triggers) */
const DEFAULT_BRANCH_PREFIXES: Record<string, string> = {
  clickup: "CU-",
  // linear: "LIN-",
  // jira: "",  // Jira uses project keys like PROJ-123, handled by the adapter
};

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

// ── Resolve default project name ─────────────────────────────────────

function resolveProjectName(explicit?: string): string {
  if (explicit) return explicit;

  const fromEnv = process.env.MULTIREPO_PROJECT ?? process.env.MULTIFIX_PROJECT;
  if (fromEnv) return fromEnv;

  const defaultFile = join(CONFIG_DIR, "default");
  const legacyDefaultFile = join(LEGACY_CONFIG_DIR, "default");
  const fromFile = readFileSafe(defaultFile)?.trim() ?? readFileSafe(legacyDefaultFile)?.trim();
  if (fromFile) return fromFile;

  throw new Error(
    "No project name provided. Pass it explicitly, set MULTIREPO_PROJECT, " +
      `or create ${defaultFile} with the default project name.`,
  );
}

// ── Main entry point ─────────────────────────────────────────────────

export function resolveConfig(projectName?: string): ResolvedConfig {
  const name = resolveProjectName(projectName);
  const configPath = join(CONFIG_DIR, `${name}.yaml`);
  const legacyConfigPath = join(LEGACY_CONFIG_DIR, `${name}.yaml`);

  const resolvedPath = existsSync(configPath) ? configPath
    : existsSync(legacyConfigPath) ? legacyConfigPath
    : null;

  if (!resolvedPath) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = readFileSync(resolvedPath, "utf-8");

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse YAML config at ${configPath}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Config file is empty or not a YAML object: ${configPath}`);
  }

  // ── Validate required fields ────────────────────────────────────

  if (!parsed.repos || typeof parsed.repos !== "object") {
    throw new Error(
      `Config "${name}" is missing required field "repos" (must define at least one repo).`,
    );
  }

  const rawRepos = parsed.repos as Record<string, Record<string, unknown>>;

  if (Object.keys(rawRepos).length === 0) {
    throw new Error(
      `Config "${name}" must define at least one repo under "repos".`,
    );
  }

  for (const [repoKey, repo] of Object.entries(rawRepos)) {
    if (!repo.path) {
      throw new Error(
        `Repo "${repoKey}" in config "${name}" is missing required field "path".`,
      );
    }
  }

  // ── Build resolved repos ────────────────────────────────────────

  const resolvedRepos: Record<string, ResolvedRepoConfig> = {};

  for (const [repoKey, repo] of Object.entries(rawRepos)) {
    const repoPath = expandTilde(repo.path as string);

    const repoConfig: ResolvedRepoConfig = {
      name: (repo.name as string) ?? repoKey,
      path: repoPath,
      remote: (repo.remote as string) ?? "origin",
      baseBranch: (repo.baseBranch as string) ?? "main",
      platform: (repo.platform as "gitlab" | "github") ?? "gitlab",
      contextFile: repo.contextFile as string | undefined,
      contextFiles: repo.contextFiles as string[] | undefined,
    };

    // Collect all context file paths (contextFile + contextFiles)
    const contextPaths: string[] = [];
    if (repoConfig.contextFile) {
      contextPaths.push(repoConfig.contextFile);
    }
    if (repoConfig.contextFiles) {
      contextPaths.push(...repoConfig.contextFiles);
    }

    // Read context files and concatenate content
    if (contextPaths.length > 0) {
      const parts: string[] = [];
      for (const relPath of contextPaths) {
        const absPath = resolve(repoPath, relPath);
        const content = readFileSafe(absPath);
        if (content) {
          parts.push(`# ${relPath}\n\n${content.trim()}`);
        }
      }
      if (parts.length > 0) {
        repoConfig.contextContent = parts.join("\n\n---\n\n");
      }
    }

    // Pre-commit checks
    if (Array.isArray(repo.preMRHooks)) {
      repoConfig.preMRHooks = (repo.preMRHooks as Array<Record<string, unknown>>).map((c, i) => {
        if (typeof c.cmd !== "string" || !c.cmd.trim()) {
          throw new Error(`Repo "${repoKey}": preMRHooks[${i}].cmd must be a non-empty string`);
        }
        if (c.args !== undefined && !Array.isArray(c.args)) {
          throw new Error(`Repo "${repoKey}": preMRHooks[${i}].args must be an array`);
        }
        return {
          cmd: c.cmd.trim(),
          args: Array.isArray(c.args) ? (c.args as string[]).map(String) : undefined,
          failOnError: c.failOnError !== false,
        };
      });
    }

    resolvedRepos[repoKey] = repoConfig;
  }

  // ── Issue tracker ───────────────────────────────────────────────

  const rawTracker = (parsed.issueTracker ?? parsed.issue_tracker ?? {}) as Record<string, unknown>;
  const trackerType = (rawTracker.type as string) ?? "headless";
  const issueTracker: IssueTrackerConfig = {
    type: trackerType as "clickup" | "headless",
    branchPrefix: (rawTracker.branchPrefix as string | undefined)
      ?? DEFAULT_BRANCH_PREFIXES[trackerType]
      ?? undefined,
    ...(rawTracker[trackerType] && typeof rawTracker[trackerType] === "object"
      ? { [trackerType]: rawTracker[trackerType] }
      : {}),
    ...(trackerType === "clickup" && rawTracker.tokenEnv && !rawTracker.clickup
      ? { clickup: { tokenEnv: rawTracker.tokenEnv } }
      : {}),
  };

  // ── Post-merge hooks ────────────────────────────────────────────

  const rawPostMergeHooks = parsed.postMergeHooks ?? parsed.post_merge_hooks;
  const postMergeHooks: PostMergeHook[] | undefined = Array.isArray(rawPostMergeHooks)
    ? (rawPostMergeHooks as Array<Record<string, unknown>>).map((h, i) => {
        const hookType = h.type as PostMergeHookType | undefined;
        // Shell hooks must have cmd
        if (!hookType || hookType === "shell") {
          if (typeof h.cmd !== "string" || !h.cmd.trim()) {
            throw new Error(`postMergeHooks[${i}]: shell hook requires a non-empty "cmd"`);
          }
        }
        if (h.args !== undefined && !Array.isArray(h.args)) {
          throw new Error(`postMergeHooks[${i}].args must be an array`);
        }
        return {
          type: hookType,
          cmd: typeof h.cmd === "string" ? h.cmd.trim() : undefined,
          args: Array.isArray(h.args) ? (h.args as string[]).map(String) : undefined,
          status: h.status as string | undefined,
          failOnError: h.failOnError !== false,
        };
      })
    : undefined;

  // ── Workspace ───────────────────────────────────────────────────

  const rawWorkspace = (parsed.workspace ?? {}) as Record<string, unknown>;
  const workspace: WorkspaceConfig = {
    root: expandTilde((rawWorkspace.root as string) ?? "~/worktrees"),
    script: rawWorkspace.script
      ? expandTilde(rawWorkspace.script as string)
      : undefined,
  };

  // ── Agent ───────────────────────────────────────────────────────

  const rawAgent = (parsed.agent ?? {}) as Record<string, unknown>;
  const agent: AgentConfig = {
    model: (rawAgent.model as string) ?? "claude-opus-4.6",
    thinking: (rawAgent.thinking as string) ?? "high",
    scoutModel: (rawAgent.scoutModel as string) ?? "claude-sonnet-4.6",
    promptTemplate: rawAgent.promptTemplate as string | undefined,
  };

  return {
    name: (parsed.name as string) ?? name,
    repos: resolvedRepos,
    issueTracker,
    workspace,
    agent,
    postMergeHooks,
  };
}
