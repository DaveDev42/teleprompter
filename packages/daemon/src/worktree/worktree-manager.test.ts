import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { WorktreeManager } from "./worktree-manager";

/** Run git with explicit stdout pipe (Bun.$ doesn't capture stdout reliably in test runner) */
async function gitRun(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args[0]} failed: ${err}`);
  }
}

describe("WorktreeManager", () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    // Create a temp git repo (resolve symlinks: macOS /var → /private/var)
    repoDir = realpathSync(await mkdtemp(join(tmpdir(), "tp-wt-test-")));
    await gitRun(["init", "-b", "main"], repoDir);
    await gitRun(["config", "user.email", "test@test.com"], repoDir);
    await gitRun(["config", "user.name", "Test"], repoDir);
    await gitRun(["config", "commit.gpgsign", "false"], repoDir);
    // Create an initial commit (required for worktrees)
    await writeFile(join(repoDir, "README.md"), "");
    await gitRun(["add", "."], repoDir);
    await gitRun(["commit", "-m", "init"], repoDir);

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
    // Remove repo dir and any sibling worktree dirs (repoDir + "-wt-*")
    await rm(repoDir, { recursive: true, force: true });
    const parent = dirname(repoDir);
    const prefix = basename(repoDir);
    try {
      const entries = await readdir(parent);
      for (const entry of entries) {
        if (entry.startsWith(`${prefix}-wt-`)) {
          await rm(join(parent, entry), { recursive: true, force: true });
        }
      }
    } catch {}
  });

  test("list returns main worktree", async () => {
    const worktrees = await manager.list();
    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe(repoDir);
    expect(worktrees[0].isMain).toBe(true);
  });

  test("add creates a new worktree with new branch", async () => {
    const wtPath = `${repoDir}-wt-feature`;
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
    await gitRun(["checkout", "-b", "develop"], repoDir);
    await writeFile(join(repoDir, "dev.txt"), "");
    await gitRun(["add", "."], repoDir);
    await gitRun(["commit", "-m", "dev commit"], repoDir);
    await gitRun(["checkout", "-"], repoDir);

    const wtPath = `${repoDir}-wt-from-develop`;
    const wt = await manager.add(wtPath, "feature-from-dev", "develop");

    expect(wt.branch).toBe("feature-from-dev");

    // Verify it has the dev commit
    const entries = await readdir(wtPath);
    expect(entries).toContain("dev.txt");
  });

  test("remove deletes a worktree", async () => {
    const wtPath = `${repoDir}-wt-to-remove`;
    await manager.add(wtPath, "to-remove");

    let worktrees = await manager.list();
    expect(worktrees.length).toBe(2);

    await manager.remove(wtPath);

    worktrees = await manager.list();
    expect(worktrees.length).toBe(1);
  });

  test("add rejects invalid branch names", async () => {
    const wtPath = `${repoDir}-wt-invalid`;
    const invalidNames = [
      "has space",
      "has..double-dot",
      "has~tilde",
      "has^caret",
      "has:colon",
      ".starts-with-dot",
      "ends-with-dot.",
      "has/lock.lock",
    ];

    for (const name of invalidNames) {
      await expect(manager.add(wtPath, name)).rejects.toThrow(
        "Invalid branch name",
      );
    }
  });

  test("add rejects unwritable parent directory", async () => {
    const wtPath = "/nonexistent-parent/worktree";
    await expect(manager.add(wtPath, "valid-branch")).rejects.toThrow(
      "does not exist or is not writable",
    );
  });

  test("list shows multiple worktrees with correct branches", async () => {
    const wt1Path = `${repoDir}-wt-a`;
    const wt2Path = `${repoDir}-wt-b`;

    await manager.add(wt1Path, "branch-a");
    await manager.add(wt2Path, "branch-b");

    const worktrees = await manager.list();
    expect(worktrees.length).toBe(3);

    const branches = worktrees.map((w) => w.branch).sort();
    expect(branches).toContain("branch-a");
    expect(branches).toContain("branch-b");
  });
});
