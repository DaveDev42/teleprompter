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
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
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
