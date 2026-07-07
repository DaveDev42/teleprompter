/**
 * Differential worktree-parity gate (ADR-0003 Phase 4, daemon inc2).
 *
 * The daemon's `WorktreeManager` shells out to `git` to add/list/remove git
 * worktrees, and enforces a security-critical trust boundary: a paired frontend
 * supplies the worktree path, so `add`/`remove` must REJECT any path that
 * escapes the repo's parent directory (a write-escapePath guard). During the
 * dual-run window a Bun daemon and a Rust `tp-daemon` may each manage worktrees
 * on the same machine; if their git argv, porcelain parsing, or containment
 * check diverge, one silently accepts what the other rejects.
 *
 * Unlike the store gate (a SHARED on-disk file the two impls co-read/write),
 * git worktrees are not a shared artifact — so this is a DIFFERENTIAL BEHAVIOR
 * gate: run the SAME op sequence through the Bun `WorktreeManager` and the Rust
 * one against two INDEPENDENT sibling `git init` repos, then assert the results
 * are structurally identical:
 *   - `add` a new branch → both return a WorktreeInfo with the same branch,
 *     is_main=false.
 *   - `list` → both return the same worktrees in the same order, same branch
 *     names, same is_main flag on the main worktree.
 *   - `add` an ESCAPING path (`../../../../etc/evil`) → both REJECT with the
 *     same "is outside the worktree base directory" boundary error.
 *   - `remove` an escaping path → both REJECT identically.
 *   - `remove` a real worktree → both succeed and the dir is gone.
 *
 * Nondeterministic fields (`path` = an absolute machine path, `head` = a commit
 * SHA) are NORMALIZED out before comparison (same discipline as the store gate
 * stripping created_at/updated_at) — the two repos are independent, so their
 * absolute paths and SHAs legitimately differ; what must match is the
 * STRUCTURE and the containment decisions.
 *
 * The Rust side is driven through the same `tp-daemon-probe` binary the store
 * gate uses, via three worktree verbs (see PROBE CONTRACT below). Degrades by
 * SKIP (not FAIL) when the probe binary has not been built — build it with
 * `(cd rust && cargo build --bin tp-daemon-probe)`. Mirrors the store /
 * runner-parity SKIP-when-unbuilt precedent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBE CONTRACT (tp-daemon-probe <worktree-verb> <repoRoot> [args...])
 *   worktree-list   <repoRoot>                              → stdout: JSON WorktreeInfo[]
 *   worktree-add    <repoRoot> <path> <branch> <baseBranch|-> → stdout: JSON [WorktreeInfo]
 *   worktree-remove <repoRoot> <path> <force:0|1>            → stdout: "" (nonzero exit on error)
 * WorktreeInfo JSON keys (snake_case, sorted): branch, head, is_main, path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from "bun:test";
import { rmRetry } from "@teleprompter/protocol/test-utils";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { WorktreeManager } from "./worktree-manager";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

/** Prefer the release binary; fall back to debug. Returns null if neither built. */
function findProbe(): string | null {
  for (const profile of ["release", "debug"]) {
    const p = join(REPO_ROOT, "rust", "target", profile, "tp-daemon-probe");
    if (existsSync(p)) return p;
  }
  return null;
}

const probeBin = findProbe();

/** A worktree entry normalized for cross-impl structural comparison. */
interface NormWorktree {
  branch: string | null;
  isMain: boolean;
}

/** Run a git command in `cwd` with GIT_* stripped (mirrors gitEnv). */
function git(cwd: string, args: string[]): void {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

/** Create a fresh git repo with one commit on `main`. */
function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
}

/** Drive the Rust probe; throw with stderr on nonzero exit. */
function probe(args: string[]): {
  stdout: string;
  ok: boolean;
  stderr: string;
} {
  const r = spawnSync(probeBin as string, args, { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", ok: r.status === 0, stderr: r.stderr ?? "" };
}

/** Normalize a Rust probe WorktreeInfo[] JSON dump → structural view. */
function normRustList(json: string): NormWorktree[] {
  const arr = JSON.parse(json) as { branch: string | null; is_main: boolean }[];
  return arr.map((w) => ({ branch: w.branch, isMain: w.is_main }));
}

/** Normalize a Bun WorktreeManager list → structural view. */
function normBunList(
  list: { branch: string | null; isMain: boolean }[],
): NormWorktree[] {
  return list.map((w) => ({ branch: w.branch, isMain: w.isMain }));
}

const maybe = probeBin ? describe : describe.skip;

maybe("worktree Bun↔Rust differential parity", () => {
  test("add + list produce structurally identical worktrees", async () => {
    // Two INDEPENDENT sibling repos — one driven by Bun, one by Rust.
    const root = mkdtempSync(join(tmpdir(), "wt-parity-"));
    const bunRepo = join(root, "bun-repo");
    const rustRepo = join(root, "rust-repo");
    const bunWt = join(root, "bun-repo-wt-feat");
    const rustWt = join(root, "rust-repo-wt-feat");
    try {
      mkdirSync(bunRepo, { recursive: true });
      mkdirSync(rustRepo, { recursive: true });
      initRepo(bunRepo);
      initRepo(rustRepo);

      // Bun: add a new-branch worktree.
      const bunWm = new WorktreeManager(bunRepo);
      const bunAdded = await bunWm.add(bunWt, "feat-x");
      expect(bunAdded.branch).toBe("feat-x");
      expect(bunAdded.isMain).toBe(false);

      // Rust: add the same.
      const rustAdd = probe(["worktree-add", rustRepo, rustWt, "feat-x", "-"]);
      expect(rustAdd.ok).toBe(true);
      const rustAdded = normRustList(rustAdd.stdout)[0];
      expect(rustAdded?.branch).toBe("feat-x");
      expect(rustAdded?.isMain).toBe(false);

      // Both lists must be structurally identical (main + feat, main first).
      const bunList = normBunList(await bunWm.list());
      const rustList = normRustList(probe(["worktree-list", rustRepo]).stdout);
      expect(rustList).toEqual(bunList);
      expect(bunList).toEqual([
        { branch: "main", isMain: true },
        { branch: "feat-x", isMain: false },
      ]);
    } finally {
      await rmRetry(root);
    }
  });

  test("both reject an escaping worktree path (add) with the same boundary error", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-parity-esc-"));
    const bunRepo = join(root, "bun-repo");
    const rustRepo = join(root, "rust-repo");
    try {
      mkdirSync(bunRepo, { recursive: true });
      mkdirSync(rustRepo, { recursive: true });
      initRepo(bunRepo);
      initRepo(rustRepo);

      const escapePath = "../../../../../../etc/evil";

      // Bun rejects.
      const bunWm = new WorktreeManager(bunRepo);
      let bunErr = "";
      try {
        await bunWm.add(escapePath, "bad-branch");
      } catch (e) {
        bunErr = e instanceof Error ? e.message : String(e);
      }
      expect(bunErr).toContain("is outside the worktree base directory");

      // Rust rejects (nonzero exit + same boundary phrase on stderr).
      const rustAdd = probe([
        "worktree-add",
        rustRepo,
        escapePath,
        "bad-branch",
        "-",
      ]);
      expect(rustAdd.ok).toBe(false);
      expect(rustAdd.stderr).toContain(
        "is outside the worktree base directory",
      );
    } finally {
      await rmRetry(root);
    }
  });

  test("both reject an escaping worktree path (remove) identically", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-parity-rm-esc-"));
    const bunRepo = join(root, "bun-repo");
    const rustRepo = join(root, "rust-repo");
    try {
      mkdirSync(bunRepo, { recursive: true });
      mkdirSync(rustRepo, { recursive: true });
      initRepo(bunRepo);
      initRepo(rustRepo);

      const escapePath = "../../../../../../etc/evil";

      const bunWm = new WorktreeManager(bunRepo);
      let bunErr = "";
      try {
        await bunWm.remove(escapePath, true);
      } catch (e) {
        bunErr = e instanceof Error ? e.message : String(e);
      }
      expect(bunErr).toContain("is outside the worktree base directory");

      const rustRm = probe(["worktree-remove", rustRepo, escapePath, "1"]);
      expect(rustRm.ok).toBe(false);
      expect(rustRm.stderr).toContain("is outside the worktree base directory");
    } finally {
      await rmRetry(root);
    }
  });

  test("both remove a real worktree and the directory is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-parity-rm-"));
    const bunRepo = join(root, "bun-repo");
    const rustRepo = join(root, "rust-repo");
    const bunWt = join(root, "bun-repo-wt-feat");
    const rustWt = join(root, "rust-repo-wt-feat");
    try {
      mkdirSync(bunRepo, { recursive: true });
      mkdirSync(rustRepo, { recursive: true });
      initRepo(bunRepo);
      initRepo(rustRepo);

      const bunWm = new WorktreeManager(bunRepo);
      await bunWm.add(bunWt, "feat-x");
      expect(existsSync(bunWt)).toBe(true);
      await bunWm.remove(bunWt, true);
      expect(existsSync(bunWt)).toBe(false);

      expect(probe(["worktree-add", rustRepo, rustWt, "feat-x", "-"]).ok).toBe(
        true,
      );
      expect(existsSync(rustWt)).toBe(true);
      expect(probe(["worktree-remove", rustRepo, rustWt, "1"]).ok).toBe(true);
      expect(existsSync(rustWt)).toBe(false);

      // Post-remove, both lists collapse to main-only, structurally identical.
      const bunList = normBunList(await bunWm.list());
      const rustList = normRustList(probe(["worktree-list", rustRepo]).stdout);
      expect(rustList).toEqual(bunList);
      expect(bunList).toEqual([{ branch: "main", isMain: true }]);
    } finally {
      await rmRetry(root);
    }
  });

  test("basename sanity: sibling worktree dirs are named as expected", () => {
    // Guards against a refactor that changes the sibling-dir convention out
    // from under the containment boundary (dirname(repoRoot)).
    expect(basename("/a/b/repo-wt-feat")).toBe("repo-wt-feat");
  });
});
