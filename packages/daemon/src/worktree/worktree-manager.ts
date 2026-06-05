/**
 * Git worktree manager.
 *
 * Daemon directly manages worktrees via git commands.
 * N:1 relationship — multiple sessions per worktree allowed.
 */

import { createLogger } from "@teleprompter/protocol";
import { spawnSync } from "child_process";
import { accessSync, constants, realpathSync } from "fs";
import { dirname } from "path";

const log = createLogger("WorktreeManager");

/**
 * Run a git command and return stdout text.
 *
 * Runs git directly via spawnSync with no shell — args are passed as an
 * array so the OS exec syscall never interprets shell metacharacters.
 * This makes shell injection structurally impossible regardless of what
 * characters appear in branch names or paths.
 */
function gitOutput(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `git ${args[0]} exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

/** Run a git command, ignoring stdout. Throws on non-zero exit. */
function gitRun(args: string[], cwd?: string): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr?.toString().trim()}`,
    );
  }
}

/**
 * Validate a git branch name using `git check-ref-format`.
 * Throws with a descriptive message if the name is invalid.
 */
function validateBranchName(branch: string): void {
  try {
    const r = spawnSync("git", ["check-ref-format", "--branch", branch], {
      stdio: "ignore",
    });
    if (r.status !== 0) throw new Error("invalid");
  } catch {
    throw new Error(
      `Invalid branch name: '${branch}'. ` +
        "Branch names cannot contain spaces, '..', '~', '^', ':', " +
        "control characters, or start/end with '.' or '/'.",
    );
  }
}

/**
 * Verify the parent directory of a path exists and is writable.
 * Throws with a descriptive message if not.
 */
function validatePathPermissions(path: string): void {
  const parent = dirname(path);
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Error(
      `Cannot create worktree at '${path}': ` +
        `parent directory '${parent}' does not exist or is not writable.`,
    );
  }
}

export interface WorktreeInfo {
  path: string;
  /**
   * The checked-out branch name, or `null` for detached-HEAD and bare
   * worktrees where no branch is active.
   */
  branch: string | null;
  head: string;
  /** Whether this is the main worktree */
  isMain: boolean;
}

export class WorktreeManager {
  constructor(private repoRoot: string) {
    // Resolve symlinks so paths match git output (macOS: /var → /private/var, /tmp → /private/tmp)
    this.repoRoot = realpathSync(repoRoot);
  }

  /**
   * List all worktrees in the repository.
   */
  async list(): Promise<WorktreeInfo[]> {
    let result: string;
    try {
      result = gitOutput(["worktree", "list", "--porcelain"], this.repoRoot);
    } catch {
      return [];
    }

    if (!result.trim()) return [];

    /**
     * Partial accumulator. `branch` defaults to `null` so detached-HEAD and
     * bare worktrees produce a typed `null` rather than leaving the field
     * `undefined` (which would break the `as WorktreeInfo` cast and silently
     * drop them from the protocol guard).
     */
    interface PartialWorktree {
      path: string;
      branch: string | null;
      head: string;
      isMain: boolean;
    }

    function isComplete(w: Partial<PartialWorktree>): w is PartialWorktree {
      return (
        typeof w.path === "string" &&
        typeof w.head === "string" &&
        w.branch !== undefined &&
        typeof w.isMain === "boolean"
      );
    }

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<PartialWorktree> = {};

    for (const line of result.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (isComplete(current)) {
          worktrees.push(current);
        }
        current = { path: line.slice(9), isMain: false, branch: null };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        // refs/heads/main → main
        const ref = line.slice(7);
        current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
      } else if (line === "detached") {
        // Detached-HEAD worktree: no branch is active. `branch` stays null.
        // `head` was already set by the `HEAD` line above.
      } else if (line === "bare") {
        // Bare worktree (main worktree of a bare repo). No branch is active.
        current.isMain = true;
      } else if (line === "") {
        if (isComplete(current)) {
          worktrees.push(current);
          current = {};
        }
      }
    }

    // Push the last worktree (output may not end with a blank line)
    if (isComplete(current)) {
      worktrees.push(current);
    }

    // Mark the first as main
    if (worktrees.length > 0 && !worktrees.some((w) => w.isMain)) {
      worktrees[0]!.isMain = true;
    }

    return worktrees;
  }

  /**
   * Add a new worktree.
   *
   * @param path - Directory path for the new worktree
   * @param branch - Branch name (creates new branch if doesn't exist)
   * @param baseBranch - Optional base branch to create from
   */
  async add(
    path: string,
    branch: string,
    baseBranch?: string,
  ): Promise<WorktreeInfo> {
    validateBranchName(branch);
    if (baseBranch) validateBranchName(baseBranch);
    validatePathPermissions(path);

    // Check if branch exists
    let branchExists = false;
    try {
      gitOutput(["rev-parse", "--verify", branch], this.repoRoot);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      gitRun(["worktree", "add", path, branch], this.repoRoot);
    } else if (baseBranch) {
      gitRun(
        ["worktree", "add", "-b", branch, path, baseBranch],
        this.repoRoot,
      );
    } else {
      gitRun(["worktree", "add", "-b", branch, path], this.repoRoot);
    }

    log.info(`added worktree at ${path} (${branch})`);

    // Get HEAD of the new worktree
    const head = gitOutput(["rev-parse", "HEAD"], path).trim();

    return { path, branch, head, isMain: false };
  }

  /**
   * Remove a worktree.
   */
  async remove(path: string, force = false): Promise<void> {
    const args = ["worktree", "remove", path];
    if (force) args.push("--force");
    gitRun(args, this.repoRoot);
    log.info(`removed worktree at ${path}`);
  }

  /**
   * Prune stale worktree entries.
   */
  async prune(): Promise<void> {
    gitRun(["worktree", "prune"], this.repoRoot);
  }
}
