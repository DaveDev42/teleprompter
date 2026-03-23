import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WorktreeManager } from "./worktree-manager";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

describe("WorktreeManager", () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    // Create a temp git repo
    repoDir = await mkdtemp(join(tmpdir(), "tp-wt-test-"));
    await $`git -C ${repoDir} init -b main`.quiet();
    await $`git -C ${repoDir} config user.email "test@test.com"`.quiet();
    await $`git -C ${repoDir} config user.name "Test"`.quiet();
    await $`git -C ${repoDir} config commit.gpgsign false`.quiet();
    // Create an initial commit (required for worktrees)
    await $`touch ${repoDir}/README.md`.quiet();
    await $`git -C ${repoDir} add .`.quiet();
    await $`git -C ${repoDir} commit -m "init"`.quiet();

    manager = new WorktreeManager(repoDir);
  });

  afterEach(async () => {
    // Clean up worktrees first
    try {
      const worktrees = await manager.list();
      for (const wt of worktrees) {
        if (!wt.isMain) {
          await manager.remove(wt.path, true);
        }
      }
    } catch {}
    await rm(repoDir, { recursive: true, force: true });
  });

  test("list returns main worktree", async () => {
    const worktrees = await manager.list();
    expect(worktrees.length).toBe(1);
    // macOS: /var → /private/var symlink, so compare realpath
    const { realpathSync } = require("fs");
    expect(realpathSync(worktrees[0].path)).toBe(realpathSync(repoDir));
    expect(worktrees[0].isMain).toBe(true);
  });

  test("add creates a new worktree with new branch", async () => {
    const wtPath = join(repoDir, "..", "wt-feature");
    const wt = await manager.add(wtPath, "feature-1");

    expect(wt.path).toBe(wtPath);
    expect(wt.branch).toBe("feature-1");
    expect(wt.head).toBeTruthy();
    expect(wt.isMain).toBe(false);

    const worktrees = await manager.list();
    expect(worktrees.length).toBe(2);
  });

  test("add creates worktree from base branch", async () => {
    // Create a base branch with a commit
    await $`git -C ${repoDir} checkout -b develop`.quiet();
    await $`touch ${repoDir}/dev.txt`.quiet();
    await $`git -C ${repoDir} add .`.quiet();
    await $`git -C ${repoDir} commit -m "dev commit"`.quiet();
    await $`git -C ${repoDir} checkout -`.quiet();

    const wtPath = join(repoDir, "..", "wt-from-develop");
    const wt = await manager.add(wtPath, "feature-from-dev", "develop");

    expect(wt.branch).toBe("feature-from-dev");

    // Verify it has the dev commit
    const files = await $`ls ${wtPath}`.text();
    expect(files).toContain("dev.txt");
  });

  test("remove deletes a worktree", async () => {
    const wtPath = join(repoDir, "..", "wt-to-remove");
    await manager.add(wtPath, "to-remove");

    let worktrees = await manager.list();
    expect(worktrees.length).toBe(2);

    await manager.remove(wtPath);

    worktrees = await manager.list();
    expect(worktrees.length).toBe(1);
  });

  test("list shows multiple worktrees with correct branches", async () => {
    const wt1Path = join(repoDir, "..", "wt-a");
    const wt2Path = join(repoDir, "..", "wt-b");

    await manager.add(wt1Path, "branch-a");
    await manager.add(wt2Path, "branch-b");

    const worktrees = await manager.list();
    expect(worktrees.length).toBe(3);

    const branches = worktrees.map((w) => w.branch).sort();
    expect(branches).toContain("branch-a");
    expect(branches).toContain("branch-b");
  });
});
