/**
 * Git worktree manager.
 *
 * Daemon directly manages worktrees via git commands.
 * N:1 relationship — multiple sessions per worktree allowed.
 */

import { $ } from "bun";

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
    const result = await $`git -C ${this.repoRoot} worktree list --porcelain`
      .text()
      .catch(() => "");

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
    const branchExists =
      (await $`git -C ${this.repoRoot} rev-parse --verify ${branch}`
        .text()
        .catch(() => "")) !== "";

    if (branchExists) {
      await $`git -C ${this.repoRoot} worktree add ${path} ${branch}`;
    } else if (baseBranch) {
      await $`git -C ${this.repoRoot} worktree add -b ${branch} ${path} ${baseBranch}`;
    } else {
      await $`git -C ${this.repoRoot} worktree add -b ${branch} ${path}`;
    }

    console.log(`[WorktreeManager] added worktree at ${path} (${branch})`);

    // Get HEAD of the new worktree
    const head = (
      await $`git -C ${path} rev-parse HEAD`.text()
    ).trim();

    return { path, branch, head, isMain: false };
  }

  /**
   * Remove a worktree.
   */
  async remove(path: string, force = false): Promise<void> {
    const args = force ? ["--force"] : [];
    await $`git -C ${this.repoRoot} worktree remove ${path} ${args}`;
    console.log(`[WorktreeManager] removed worktree at ${path}`);
  }

  /**
   * Prune stale worktree entries.
   */
  async prune(): Promise<void> {
    await $`git -C ${this.repoRoot} worktree prune`;
  }
}
