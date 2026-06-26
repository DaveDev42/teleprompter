import { chmodSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Resolve the per-user runtime directory that holds the daemon IPC socket and
 * the singleton pid-file lock. Both must agree across every context that talks
 * to the daemon, otherwise the CLI cannot find a daemon another context started.
 *
 * Resolution order:
 *  1. `XDG_RUNTIME_DIR` if set — the canonical per-user runtime dir. A systemd
 *     `--user` service always has this injected (= `/run/user/<uid>`).
 *  2. `/run/user/<uid>` if it exists as a directory — the standard systemd
 *     location. This is the critical case: a systemd-managed daemon binds its
 *     socket under `XDG_RUNTIME_DIR=/run/user/<uid>`, but an interactive login
 *     shell (notably WSL, which has no graphical session manager) often has
 *     `XDG_RUNTIME_DIR` unset. Without this step the interactive `tp` would fall
 *     through to `/tmp` and miss the running daemon — reporting "not running",
 *     spawning a duplicate, and deadlocking the store DB (SQLITE_BUSY).
 *  3. `/tmp/teleprompter-<uid>` fallback — world-writable base, so the dir is
 *     created mode-0700 (and re-chmod'd) to keep the IPC socket private.
 *
 * @returns The runtime directory path (no trailing slash). Steps 1–2 only read;
 *          the caller is responsible for ensuring the dir exists. Step 3 creates
 *          and tightens the fallback dir before returning.
 */
export function resolveRuntimeDir(): string {
  const xdgRuntimeDir = process.env["XDG_RUNTIME_DIR"];
  if (xdgRuntimeDir) {
    // XDG_RUNTIME_DIR is owned and mode-0700'd by the login manager (systemd
    // et al.); we only ensure it exists (the daemon binds its IPC socket here,
    // so the parent dir must be present) and never touch its permissions.
    mkdirSync(xdgRuntimeDir, { recursive: true });
    return xdgRuntimeDir;
  }

  // XDG_RUNTIME_DIR unset (e.g. a non-graphical WSL login shell). Prefer the
  // standard systemd runtime dir if it already exists, so an interactive `tp`
  // resolves to the same socket/lock a systemd-managed daemon created. We do
  // NOT create it — its presence (mode-0700, login-manager owned) is the signal
  // that this is a real per-user runtime dir; absence means fall through.
  const uid = process.getuid?.() ?? 0;
  const systemdRuntimeDir = `/run/user/${uid}`;
  try {
    if (
      existsSync(systemdRuntimeDir) &&
      statSync(systemdRuntimeDir).isDirectory()
    ) {
      return systemdRuntimeDir;
    }
  } catch {
    // stat raced with removal or permission denied — fall through to /tmp.
  }

  // Fallback under /tmp, which is world-writable and shared across all local
  // users. The directory holds the daemon IPC socket (the Runner↔Daemon
  // command channel), so it must NOT be traversable by other users. mkdirSync's
  // mode is masked by the process umask, so follow up with an explicit chmod to
  // force 0700 even when the directory already existed (defense in depth — a
  // pre-existing world-readable dir from an earlier loose-umask run is
  // tightened here too).
  const runtimeDir = join("/tmp", `teleprompter-${uid}`);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  return runtimeDir;
}

export function getSocketPath(): string {
  return join(resolveRuntimeDir(), "daemon.sock");
}

/**
 * Reject a session id that is unsafe to interpolate into a filesystem path.
 *
 * A `sid` flows from several untrusted-ish sources — the `--tp-sid` passthrough
 * flag, and (critically) frontend-supplied `session.create` over the relay — and
 * is joined into per-session paths like `<store>/sessions/<sid>.sqlite` and the
 * `hook-<sid>.sock` socket name. Without a guard, `sid = "../../evil"` escapes the
 * intended directory and lets a confused/crafted sid create or unlink files at any
 * path the daemon user can write.
 *
 * The check is deliberately strict — an allowlist, not a denylist: a valid sid is
 * one or more of `[A-Za-z0-9_-]`. Every sid the codebase generates satisfies it
 * (`session-<base36ts>`, worktree `<sanitizeForSid(branch)>-<ts>`, the smoke
 * `sess-smoketest`), so no legitimate path breaks. Worktree sids run the branch
 * through {@link sanitizeForSid} precisely so a legal-but-non-allowlist branch
 * (`release-1.2`) cannot produce a sid this rejects. Throws a plain Error on
 * violation (callers convert to a wire error / socket teardown as appropriate).
 */
const SAFE_SID = /^[A-Za-z0-9_-]+$/;
export function assertSafeSid(sid: string): void {
  if (!SAFE_SID.test(sid)) {
    throw new Error(
      `invalid sid '${sid}': must match [A-Za-z0-9_-]+ (no path separator, '..', or empty)`,
    );
  }
}

/**
 * Collapse an arbitrary label (typically a git branch name) into a fragment that
 * is guaranteed to satisfy {@link assertSafeSid}'s `[A-Za-z0-9_-]+` allowlist.
 *
 * `git check-ref-format` accepts far more than the sid allowlist — a `.` is the
 * common case (`release-1.2`, `feat.x`, `v2.0`), but also non-ASCII letters,
 * `+`, etc. A worktree session id was derived as `<branch with '/'→'-'>-<ts>`,
 * so any of those legal-branch characters produced a sid that
 * `store.createSession`'s `assertSafeSid` then rejected — AFTER `git worktree
 * add` had already created the on-disk worktree, orphaning it. This maps every
 * non-allowlist character to `-`, collapses runs, and trims leading/trailing
 * `-` so the result is always allowlist-clean. When the input reduces to empty
 * (e.g. an all-`.` branch), returns `"wt"` so the caller still has a non-empty
 * fragment to suffix with a timestamp.
 *
 * The mapping is lossy and one-way — it is ONLY for deriving a local sid /
 * default worktree directory name (no wire/schema/peer impact). The original
 * branch name is always passed to git verbatim.
 */
export function sanitizeForSid(label: string): string {
  const cleaned = label
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "wt";
}
