/**
 * Git worktree manager.
 *
 * Daemon directly manages worktrees via git commands.
 * N:1 relationship — multiple sessions per worktree allowed.
 */

import { createLogger } from "@teleprompter/protocol";
import { spawnSync } from "child_process";
import { accessSync, constants, realpathSync } from "fs";
import { basename, dirname, resolve, sep } from "path";

const log = createLogger("WorktreeManager");

/**
 * Build a child-process env with inherited GIT_* vars stripped.
 *
 * If the daemon (or a test runner) is itself spawned inside a git operation —
 * e.g. from a `git push` pre-push hook — git exports GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE pointing at the *outer* repo. Those exported vars override
 * both the `cwd` option and any `-C` flag, so every WorktreeManager git call
 * would silently target the outer repo instead of `repoRoot`. Stripping them
 * makes `cwd` authoritative, which is the contract this manager relies on
 * (it always names the repo explicitly via `cwd`).
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_")) delete env[k];
  }
  return env;
}

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
    env: gitEnv(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // `result.error` is set when the process could not be spawned at all
  // (git absent → ENOENT, timeout → ETIMEDOUT). In that case `status` is
  // `null`, so the `status !== 0` branch fires with a useless "exited null".
  // Surface the spawn error so operators see "git not found" rather than a
  // confusing exit message.
  if (result.error) {
    throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  }
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
    env: gitEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error) {
    throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  }
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
  const r = spawnSync("git", ["check-ref-format", "--branch", branch], {
    env: gitEnv(),
    stdio: "ignore",
  });
  // If git itself could not run, the branch name is not the problem — surface
  // the spawn error rather than falsely reporting a valid name as invalid.
  if (r.error) {
    throw new Error(
      `cannot validate branch name (git could not run): ${r.error.message}`,
    );
  }
  if (r.status !== 0) {
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
    } catch (err) {
      // Best-effort: an empty list is a reasonable degraded response, but
      // swallowing silently blinds operators to git-absent / repoRoot-deleted
      // / corrupt-.git / permission-denied — log so the cause is diagnosable.
      log.warn(
        `worktree list failed, returning empty list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
    const first = worktrees[0];
    if (first !== undefined && !worktrees.some((w) => w.isMain)) {
      first.isMain = true;
    }

    return worktrees;
  }

  /**
   * Reject worktree paths that escape the repo's containing directory.
   *
   * A paired (E2EE-authenticated) frontend supplies this path, so without a
   * containment check it can drive `git worktree add /etc/evil` and write a
   * worktree anywhere the daemon user can — a trust-boundary write-escape.
   *
   * The boundary is the repo root's PARENT directory, not the repo root
   * itself: by convention git worktrees are SIBLINGS of the repo
   * (`<repo>-wt-<name>`), never nested inside it (git discourages nested
   * working trees). So we allow anything under `dirname(repoRoot)` and reject
   * true escapes (`/etc`, `$HOME/.ssh`, an unrelated `/tmp` path).
   *
   * The parent of the supplied path is resolved through `realpathSync`
   * (collapsing `..` AND following symlinks) before the prefix test, so
   * neither `../../escape` nor a symlinked parent can slip past. That parent
   * is guaranteed to exist by the prior `validatePathPermissions` call.
   */
  private validatePathContainment(path: string): void {
    const base = dirname(this.repoRoot);
    const absolute = resolve(this.repoRoot, path);
    let resolved: string;
    try {
      // Use realpathSync on the parent to collapse `..` and follow symlinks so
      // neither `../../escape` nor a symlinked parent can slip past the check.
      // The parent must exist for realpath to succeed; if it doesn't, fall back
      // to lexical resolution (symlink attacks are moot when the dir is absent).
      const realParent = realpathSync(dirname(absolute));
      resolved = resolve(realParent, basename(absolute));
    } catch {
      // Parent directory does not exist yet — lexical resolution is sufficient
      // (no symlinks to follow) and still catches clear escapes like /etc/evil.
      resolved = absolute;
    }
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new Error(
        `Refusing to create worktree at '${path}': ` +
          `resolved path '${resolved}' is outside the worktree base ` +
          `directory '${base}'.`,
      );
    }
  }

  /**
   * Canonicalize a worktree path into the SAME absolute form this manager
   * stores and compares against, so two paths that name the same directory
   * compare equal regardless of how the caller spelled them.
   *
   * This mirrors `validatePathContainment`'s resolve logic exactly: resolve
   * against `repoRoot` (collapsing a trailing slash, `.`/`..` segments, and
   * making a relative path absolute), then `realpathSync(dirname(...))` +
   * `basename(...)` to follow symlinks on the parent — with a lexical fallback
   * when the parent no longer exists (the worktree dir may already be deleted).
   *
   * Applying this to BOTH a stored `worktree_path` and a frontend-supplied
   * path makes the comparison robust to trailing slashes, `..` components, and
   * symlinked parent directories — without it, a string-equality match could
   * miss a live session and let its worktree be removed out from under it.
   * The match is intentionally NOT `realpathSync` on the final component: the
   * stored value came from `add()`'s `resolve(repoRoot, path)` which never
   * realpath'd the leaf, so resolving the leaf here would make the two sides
   * diverge when the worktree dir itself is a symlink.
   */
  canonicalize(path: string): string {
    const absolute = resolve(this.repoRoot, path);
    try {
      const realParent = realpathSync(dirname(absolute));
      return resolve(realParent, basename(absolute));
    } catch {
      return absolute;
    }
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
    this.validatePathContainment(path);
    validatePathPermissions(path);

    // Resolve the path to an absolute one against the repo root. `git worktree
    // add` runs with cwd=repoRoot, so a relative `path` creates the dir under
    // the repo — but the later `rev-parse HEAD` query uses the path AS A CWD,
    // which spawnSync resolves against the DAEMON process CWD, not repoRoot.
    // Under launchd/systemd (CWD=/ or ~, the common shipped mode) the relative
    // dir does not exist there → ENOENT → the query throws AFTER the worktree
    // was already created, leaving a ghost dir. Use the absolute path for the
    // HEAD query and the returned WorktreeInfo so callers get a stable path.
    const absolutePath = resolve(this.repoRoot, path);

    // Check if branch exists
    let branchExists = false;
    try {
      gitOutput(["rev-parse", "--verify", branch], this.repoRoot);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    // `--` separates options from the path positional so a path beginning with
    // `-` is never parsed by git as a flag.
    if (branchExists) {
      gitRun(["worktree", "add", "--", path, branch], this.repoRoot);
    } else if (baseBranch) {
      gitRun(
        ["worktree", "add", "-b", branch, "--", path, baseBranch],
        this.repoRoot,
      );
    } else {
      gitRun(["worktree", "add", "-b", branch, "--", path], this.repoRoot);
    }

    log.info(`added worktree at ${path} (${branch})`);

    // Get HEAD of the new worktree (absolute cwd — see above).
    const head = gitOutput(["rev-parse", "HEAD"], absolutePath).trim();

    return { path: absolutePath, branch, head, isMain: false };
  }

  /**
   * Remove a worktree.
   */
  async remove(path: string, force = false): Promise<void> {
    // Enforce the SAME containment boundary as add(): a path is only removable
    // if it resolves under the worktree base dir. Without this, an
    // authenticated-but-misbehaving frontend could remove a git worktree
    // registered anywhere on disk (destroying work outside the sibling-dir
    // trust boundary add() enforces) — an asymmetry in the trust model.
    this.validatePathContainment(path);
    // `--` separates options from the path positional so a path beginning with
    // `-` is parsed as a positional, not a git flag.
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push("--", path);
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
