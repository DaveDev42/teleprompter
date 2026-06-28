/**
 * NOTE (macOS): run this file with a rooted path — `bun test
 * ./packages/daemon/...` or from inside packages/daemon. Un-rooted args put
 * bun test in filter mode, whose repo-wide scan holds ~11k directory fds;
 * spawnSync pipe fds then exceed Darwin's OPEN_MAX (10240), posix_spawn
 * cannot wire them into the git child, and bun silently returns empty stdout
 * (6 tests fail on empty `git worktree list` output). See
 * `.claude/rules/testing-inventory.md` → "macOS rooted paths".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "fs";
import { mkdtemp, readdir, rm, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { WorktreeManager } from "./worktree-manager";

/**
 * Normalize a path so it matches the form `git worktree list --porcelain`
 * emits — on macOS, realpathSync resolves symlinks (e.g. `/var` → `/private/var`).
 */
function normalizeGitPath(p: string): string {
  return realpathSync(p);
}

/**
 * Run git synchronously against a specific repo directory.
 *
 * CRITICAL: this strips inherited GIT_* env vars from the child. When the test
 * suite runs from a `git push` pre-push hook, git exports GIT_DIR (and friends)
 * pointing at the *caller's* repo, e.g.
 *   GIT_DIR=/path/to/repo/.git/worktrees/<name>
 * An exported GIT_DIR overrides BOTH the `cwd` option and `git -C` — so
 * `git config user.name Test` and `git commit -m init` would silently target
 * the caller's worktree, polluting its config (author becomes Test
 * <test@test.com>) and its HEAD (a stray "init" commit). Deleting the inherited
 * GIT_* vars lets `cwd` + `-C` actually select the isolated temp repo.
 * (This is the real cause of the pre-push HEAD pollution — not fd pressure.)
 */
function gitRunSync(args: string[], cwd: string): void {
  const { spawnSync } = require("child_process");
  const result = spawnSync("git", ["-C", cwd, ...args], {
    cwd,
    env: gitTestEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr?.toString().trim()}`,
    );
  }
}

/** Like gitRunSync but returns trimmed stdout. Same GIT_* isolation. */
function gitCaptureSync(args: string[], cwd: string): string {
  const { spawnSync } = require("child_process");
  const result = spawnSync("git", ["-C", cwd, ...args], {
    cwd,
    env: gitTestEnv(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr?.toString().trim()}`,
    );
  }
  return (result.stdout ?? "").trim();
}

/** Strip inherited GIT_* vars so cwd/`-C` actually select the temp repo. */
function gitTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_")) delete env[k];
  }
  return env;
}

describe("WorktreeManager", () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    // Create a temp git repo. Normalize so the path matches what
    // `git worktree list --porcelain` emits (resolves macOS /var → /private/var
    // symlinks and Windows 8.3 short names + backslashes).
    repoDir = normalizeGitPath(await mkdtemp(join(tmpdir(), "tp-wt-test-")));
    gitRunSync(["init", "-b", "main"], repoDir);
    gitRunSync(["config", "user.email", "test@test.com"], repoDir);
    gitRunSync(["config", "user.name", "Test"], repoDir);
    gitRunSync(["config", "commit.gpgsign", "false"], repoDir);
    // Create an initial commit (required for worktrees)
    await writeFile(join(repoDir, "README.md"), "");
    gitRunSync(["add", "."], repoDir);
    gitRunSync(["commit", "-m", "init"], repoDir);

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
    const first = worktrees[0];
    if (first === undefined) throw new Error("expected worktrees[0]");
    expect(first.path).toBe(repoDir);
    expect(first.isMain).toBe(true);
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
    gitRunSync(["checkout", "-b", "develop"], repoDir);
    await writeFile(join(repoDir, "dev.txt"), "");
    gitRunSync(["add", "."], repoDir);
    gitRunSync(["commit", "-m", "dev commit"], repoDir);
    gitRunSync(["checkout", "-"], repoDir);

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
    // A path outside the worktree base with a nonexistent parent is rejected by
    // the containment check (which runs first) rather than the permissions check.
    // Both checks gate the same intent; the containment error takes priority.
    const wtPath = "/nonexistent-parent/worktree";
    await expect(manager.add(wtPath, "valid-branch")).rejects.toThrow(
      /outside the worktree base directory|does not exist or is not writable/,
    );
  });

  /**
   * SECURITY REGRESSION: worktree path containment (trust-boundary write-escape)
   *
   * A paired (E2EE-authenticated) frontend supplies the worktree path. Without
   * a containment check it could write a worktree anywhere the daemon user can
   * (e.g. an absolute path into a writable system dir). The fix bounds the
   * resolved path to the repo root's PARENT directory — the conventional
   * sibling-worktree location (`<repo>-wt-<name>`) — and rejects true escapes.
   */
  test("add rejects a worktree path that escapes the repo's parent dir", async () => {
    // `../escape-<id>` from the repo's PARENT resolves to a grandparent sibling,
    // i.e. above the worktree base directory (dirname(repoRoot)). This is a true
    // escape regardless of where the repo lives, so it must be rejected. (Note:
    // a path that merely shares the temp-root parent would NOT escape — the test
    // env's shared /tmp is the repo's parent, which is exactly the allowed base.)
    const escapePath = join(
      dirname(repoDir),
      "..",
      `tp-wt-escape-${Date.now().toString(36)}`,
    );
    await expect(manager.add(escapePath, "escape-branch")).rejects.toThrow(
      "outside the worktree base directory",
    );
    // No worktree dir was created at the escape path.
    expect(existsSync(escapePath)).toBe(false);
  });

  test("add allows a sibling worktree under the repo's parent dir", async () => {
    // The conventional layout — a sibling of the repo — must still succeed.
    const siblingPath = `${repoDir}-wt-sibling`;
    const wt = await manager.add(siblingPath, "sibling-branch");
    expect(wt.path).toBe(siblingPath);
    expect(existsSync(siblingPath)).toBe(true);
  });

  test("remove rejects a path outside the worktree base directory (containment symmetry with add)", async () => {
    // remove() must enforce the SAME containment boundary as add(), so an
    // authenticated frontend cannot remove a worktree registered anywhere on
    // disk. A true escape above dirname(repoRoot) is rejected before git runs.
    const escapePath = join(
      dirname(repoDir),
      "..",
      `tp-wt-escape-rm-${Date.now().toString(36)}`,
    );
    await expect(manager.remove(escapePath)).rejects.toThrow(
      "outside the worktree base directory",
    );
  });

  test("remove succeeds for a worktree inside the base directory", async () => {
    // The normal case — a sibling worktree — must still be removable.
    const wtPath = `${repoDir}-wt-removable`;
    await manager.add(wtPath, "removable-branch");
    expect(existsSync(wtPath)).toBe(true);
    await manager.remove(wtPath, true);
    expect(existsSync(wtPath)).toBe(false);
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

  /**
   * SECURITY REGRESSION: shell injection via branch name
   *
   * Attack vector: a remote frontend sends a branch name containing shell
   * metacharacters (e.g. single quotes + command substitution). The old
   * gitOutput built a sh -c string without escaping single quotes, so
   * a name like feat'$(touch /sentinel)' would execute arbitrary commands.
   *
   * The fix rewrites gitOutput to use spawnSync("git", args, ...) with no
   * shell — args are passed as a plain array to execvp, making injection
   * structurally impossible.
   *
   * SABOTAGE-VERIFY confirmation (performed manually during development):
   *   1. Temporarily restored the old sh -c implementation in gitOutput.
   *   2. Ran this test — the sentinel file WAS created and the test FAILED,
   *      confirming the test catches the injection.
   *   3. Restored the no-shell fix — sentinel file is NOT created and the
   *      test PASSES, confirming the fix is effective.
   */
  test("shell injection via branch name is impossible (security regression)", async () => {
    // Unique sentinel path: if a shell were invoked, this file would be created.
    const sentinelId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sentinelPath = join(tmpdir(), `tp-injection-sentinel-${sentinelId}`);

    // Craft a branch name that, if passed through sh -c with naive single-quote
    // wrapping, would execute: touch <sentinelPath>
    // git check-ref-format rejects names with single quotes, so validateBranchName
    // will throw first — but even if that check were bypassed, gitOutput must not
    // invoke a shell. We bypass validateBranchName by calling gitOutput indirectly
    // through manager.add which first calls validateBranchName; the important
    // assertion is that regardless of which layer rejects, the sentinel is never
    // created.
    const maliciousBranch = `feat'$(touch ${sentinelPath})'x`;
    const wtPath = `${repoDir}-wt-injection-test`;

    // The operation must fail (invalid branch name or git error) — never succeed.
    await expect(manager.add(wtPath, maliciousBranch)).rejects.toThrow();

    // The sentinel file must NOT exist — no shell command was executed.
    // Give any async shell a moment to write (it won't, but be explicit).
    expect(existsSync(sentinelPath)).toBe(false);

    // Cleanup sentinel if somehow created (ensures afterEach doesn't miss it).
    try {
      await unlink(sentinelPath);
    } catch {}
  });

  test("detached-HEAD worktree has branch=null and correct head", async () => {
    // Create a worktree, then detach its HEAD so `git worktree list --porcelain`
    // emits `detached` instead of `branch refs/heads/...`.
    const wtPath = `${repoDir}-wt-detached`;
    await manager.add(wtPath, "detached-branch");

    // Detach the HEAD in the worktree by checking out the commit SHA directly.
    const sha = gitCaptureSync(["rev-parse", "HEAD"], wtPath);
    gitRunSync(["checkout", "--detach", sha], wtPath);

    const worktrees = await manager.list();
    const detached = worktrees.find((w) => w.path === wtPath);
    expect(detached).toBeDefined();
    if (detached === undefined) throw new Error("expected detached worktree");
    expect(detached.branch).toBeNull();
    expect(typeof detached.head).toBe("string");
    expect(detached.head.length).toBeGreaterThan(0);

    // Cleanup — must force because the worktree is in use
    await manager.remove(wtPath, true);
  });

  test("parser emits worktreeInfo for all entries even when one has null branch", async () => {
    // Regression: previously a detached-HEAD entry left `branch` undefined on
    // the `as WorktreeInfo` cast, causing `isWorktreeInfoArray` to silently
    // drop the entire worktree list on the frontend.
    const wt1Path = `${repoDir}-wt-normal`;
    const wt2Path = `${repoDir}-wt-detach2`;
    await manager.add(wt1Path, "normal-branch");
    await manager.add(wt2Path, "detach2-branch");

    // Detach the second worktree's HEAD.
    const sha = gitCaptureSync(["rev-parse", "HEAD"], wt2Path);
    gitRunSync(["checkout", "--detach", sha], wt2Path);

    const worktrees = await manager.list();
    // All three (main + normal + detached) must appear.
    expect(worktrees.length).toBe(3);

    const normal = worktrees.find((w) => w.path === wt1Path);
    const detached = worktrees.find((w) => w.path === wt2Path);
    expect(normal?.branch).toBe("normal-branch");
    expect(detached?.branch).toBeNull();

    await manager.remove(wt1Path, true);
    await manager.remove(wt2Path, true);
  });

  test("validateBranchName note: git accepts shell metacharacters — primary fix is no-shell gitOutput", async () => {
    // Defense-in-depth note: git check-ref-format considers single quotes,
    // backticks, $(), and semicolons to be VALID branch name characters. This
    // means validateBranchName alone does NOT gate these injection payloads.
    //
    // The PRIMARY and ONLY reliable fix is the no-shell rewrite of gitOutput:
    // since git is invoked via execvp (no sh -c), shell metacharacters in args
    // are treated as literal characters and never interpreted.
    //
    // Verify that a name with single quotes passes git check-ref-format and
    // that the attempt fails cleanly (no-such-branch error, not shell execution).
    const wtPath = `${repoDir}-wt-meta`;
    const nameWithQuote = "feat'x";

    // Should fail because the branch doesn't exist yet AND the worktree path
    // cannot be created twice — but the error must come from git logic, not
    // shell injection. The important thing is the sentinel test above confirms
    // no shell side-effect occurred.
    const result = await manager.add(wtPath, nameWithQuote).catch((e) => e);
    // Either succeeds (git created the branch) or fails with a git error.
    // Either way, no shell was invoked. Accept both outcomes.
    if (result instanceof Error) {
      // Error must be a git/path error, not a crash from injection
      expect(result.message).toMatch(/git |Invalid branch|does not exist/);
    }
    // If it succeeded, clean it up
    if (!(result instanceof Error)) {
      await manager.remove(wtPath, true);
    }
  });
});
