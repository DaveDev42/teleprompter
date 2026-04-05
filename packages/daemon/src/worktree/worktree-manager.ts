/**
 * Git worktree manager.
 *
 * Daemon directly manages worktrees via git commands.
 * N:1 relationship — multiple sessions per worktree allowed.
 */

import { createLogger } from "@teleprompter/protocol";
import { execFileSync } from "child_process";
import { accessSync, constants } from "fs";
import { dirname } from "path";

const log = createLogger("WorktreeManager");

/** Run a git command and return stdout text. */
function gitOutput(args: string[]): string {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString();
}

/** Run a git command, ignoring stdout. Throws on non-zero exit. */
function gitRun(args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
}

/**
 * Validate a git branch name using `git check-ref-format`.
 * Throws with a descriptive message if the name is invalid.
 */
function validateBranchName(branch: string): void {
  try {
    execFileSync("git", ["check-ref-format", "--branch", branch], {
      stdio: "ignore",
    });
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
  branch: string;
  head: string;
  /** Whether this is the main worktree */
  isMain: boolean;
}

export class WorktreeManager {
  constructor(private repoRoot: string) {}

  /**
   * List all worktrees in the repository.
   */
  async list(): Promise<WorktreeInfo[]> {
    let result: string;
    try {
      result = gitOutput([
        "-C",
        this.repoRoot,
        "worktree",
        "list",
        "--porcelain",
      ]);
    } catch {
      return [];
    }

    if (!result.trim()) return [];

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of result.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          worktrees.push(current as WorktreeInfo);
        }
        current = { path: line.slice(9), isMain: false };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        // refs/heads/main → main
        const ref = line.slice(7);
        current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
      } else if (line === "bare") {
        current.isMain = true;
      } else if (line === "") {
        if (current.path) {
          worktrees.push(current as WorktreeInfo);
          current = {};
        }
      }
    }

    // Mark the first as main
    if (worktrees.length > 0 && !worktrees.some((w) => w.isMain)) {
      worktrees[0].isMain = true;
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
      gitOutput(["-C", this.repoRoot, "rev-parse", "--verify", branch]);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      gitRun(["-C", this.repoRoot, "worktree", "add", path, branch]);
    } else if (baseBranch) {
      gitRun([
        "-C",
        this.repoRoot,
        "worktree",
        "add",
        "-b",
        branch,
        path,
        baseBranch,
      ]);
    } else {
      gitRun(["-C", this.repoRoot, "worktree", "add", "-b", branch, path]);
    }

    log.info(`added worktree at ${path} (${branch})`);

    // Get HEAD of the new worktree
    const head = gitOutput(["-C", path, "rev-parse", "HEAD"]).trim();

    return { path, branch, head, isMain: false };
  }

  /**
   * Remove a worktree.
   */
  async remove(path: string, force = false): Promise<void> {
    const args = ["-C", this.repoRoot, "worktree", "remove", path];
    if (force) args.push("--force");
    gitRun(args);
    log.info(`removed worktree at ${path}`);
  }

  /**
   * Prune stale worktree entries.
   */
  async prune(): Promise<void> {
    gitRun(["-C", this.repoRoot, "worktree", "prune"]);
  }
}
