import { chmodSync, mkdirSync } from "fs";
import { join } from "path";

export function getSocketPath(): string {
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir) {
    // XDG_RUNTIME_DIR is owned and mode-0700'd by the login manager (systemd
    // et al.); we only ensure it exists and never touch its permissions.
    mkdirSync(xdgRuntimeDir, { recursive: true });
    return join(xdgRuntimeDir, "daemon.sock");
  }

  // Fallback under /tmp, which is world-writable and shared across all local
  // users. The directory holds the daemon IPC socket (the Runner↔Daemon
  // command channel), so it must NOT be traversable by other users. mkdirSync's
  // mode is masked by the process umask, so follow up with an explicit chmod to
  // force 0700 even when the directory already existed (defense in depth — a
  // pre-existing world-readable dir from an earlier loose-umask run is
  // tightened here too).
  const runtimeDir = join("/tmp", `teleprompter-${process.getuid?.()}`);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  return join(runtimeDir, "daemon.sock");
}
