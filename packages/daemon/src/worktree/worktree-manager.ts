/**
 * Git worktree manager.
 *
 * Daemon directly manages worktrees via git commands.
 * N:1 relationship — multiple sessions per worktree allowed.
 */

import { createLogger } from "@teleprompter/protocol";
import { spawnSync } from "child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const log = createLogger("WorktreeManager");

/** Run a git command and return stdout text. */
function gitOutput(args: string[], cwd?: string): string {
  // Use shell redirection to capture stdout to a temp file.
  // Node's child_process pipe returns empty buffers under `bun test`
  // when run from monorepo root (Bun test runner pipe interference).
  const tmp = join(
    tmpdir(),
    `tp-git-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const cmd = ["git", ...args].map((a) => `'${a}'`).join(" ");
    const result = spawnSync("sh", ["-c", `${cmd} > '${tmp}'`], {
      cwd,
      stdio: "ignore",
    });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} exited ${result.status}`);
    }
    return readFileSync(tmp, "utf-8");
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
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
  branch: string;
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

    // Push the last worktree (output may not end with a blank line)
    if (current.path) {
      worktrees.push(current as WorktreeInfo);
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
