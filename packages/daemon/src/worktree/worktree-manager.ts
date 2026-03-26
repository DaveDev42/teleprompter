/**
 * Git worktree manager.
 *
 * Daemon directly manages worktrees via git commands.
 * N:1 relationship — multiple sessions per worktree allowed.
 */

import { execSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("WorktreeManager");

let _tmpSeq = 0;

/**
 * Escape args for shell execution.
 *
 * WORKAROUND: Bun v1.3.6 test runner intercepts pipe-based child process
 * stdout (Bun.$, Bun.spawn, execFileSync all return empty). Shell redirect
 * to temp file is the only reliable way to capture output.
 * TODO: Revert to execFileSync once Bun fixes this behavior.
 *
 * Safety: args come from internal git operations (paths, branch names).
 * Single-quote wrapping with inner quote escaping handles all valid git refs.
 */
function shellEscape(args: string[]): string {
  return args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
}

/** Run a git command and return stdout text. */
function gitOutput(args: string[]): string {
  const tmpFile = `/tmp/.tp-git-${process.pid}-${++_tmpSeq}`;
  try {
    execSync(`git ${shellEscape(args)} > '${tmpFile}'`, { stdio: "ignore" });
    return readFileSync(tmpFile, "utf-8");
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/** Run a git command, ignoring stdout. Throws on non-zero exit. */
function gitRun(args: string[]): void {
  execSync(`git ${shellEscape(args)}`, { stdio: "ignore" });
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
      result = gitOutput(["-C", this.repoRoot, "worktree", "list", "--porcelain"]);
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
        current.branch = ref.startsWith("refs/heads/")
          ? ref.slice(11)
          : ref;
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
      gitRun(["-C", this.repoRoot, "worktree", "add", "-b", branch, path, baseBranch]);
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
