import { createLogger } from "@teleprompter/protocol";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname } from "path";

const log = createLogger("DaemonLock");

/**
 * PID file path for the daemon singleton lock.
 * Sits in the same runtime dir as the IPC socket so cleanup semantics are
 * identical — the dir is ephemeral per-boot (XDG_RUNTIME_DIR) and the file
 * survives only while the daemon process is alive.
 */
export function getDaemonLockPath(): string {
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    `/tmp/teleprompter-${process.getuid?.() ?? "0"}`;
  return `${runtimeDir}/daemon.pid`;
}

/**
 * Check whether a pid is alive by sending signal 0.
 * Returns true  → process exists (same uid, or root).
 * Returns false → ESRCH (no such process).
 * EPERM → process exists but owned by another user; treated as alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true; // EPERM → exists, different uid
  }
}

/**
 * Acquire the daemon singleton pid-file lock.
 *
 * - No lock file present: write `process.pid` exclusively and return the pid.
 * - Lock file present with a live pid: return null (caller must NOT spawn).
 * - Lock file present with a dead pid (crashed daemon): remove stale file and
 *   retry once, then return the pid on success.
 *
 * Uses `fs.openSync(..., "wx")` for exclusive create — atomic on POSIX, so
 * two concurrent callers cannot both succeed.
 *
 * @returns The pid written to the file (always === process.pid), or null when
 *          another live daemon already holds the lock.
 */
export function acquireDaemonLock(lockPath: string): number | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  return tryAcquire(lockPath, /* allowRetry */ true);
}

function tryAcquire(lockPath: string, allowRetry: boolean): number | null {
  let fd: number;
  try {
    // O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if file already exists
    fd = openSync(lockPath, "wx");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err; // unexpected — propagate

    // Lock file already exists; read the pid inside
    let existingPid: number | null = null;
    try {
      const content = readFileSync(lockPath, "utf-8").trim();
      existingPid = parseInt(content, 10);
    } catch {
      // File vanished between EEXIST and read — treat as stale below
    }

    if (
      existingPid !== null &&
      !Number.isNaN(existingPid) &&
      isPidAlive(existingPid)
    ) {
      log.info(`another daemon already running (pid=${existingPid})`);
      return null; // live holder — caller must not spawn
    }

    // Stale lock (crashed daemon): remove and retry once
    if (!allowRetry) {
      log.warn("failed to acquire daemon lock after stale cleanup");
      return null;
    }
    log.info(
      `removing stale daemon lock (pid=${existingPid ?? "unknown"}) at ${lockPath}`,
    );
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed by a racing process — fine
    }
    return tryAcquire(lockPath, /* allowRetry */ false);
  }

  // Successfully opened exclusively — write current pid and close
  const buf = Buffer.from(`${process.pid}\n`);
  writeSync(fd, buf);
  closeSync(fd);
  log.info(`acquired daemon lock (pid=${process.pid}) at ${lockPath}`);
  return process.pid;
}

/**
 * Release the daemon lock by deleting the pid file.
 * Only removes the file if it still contains our own pid (guards against
 * accidentally deleting a lock written by a new daemon after a restart).
 * Safe to call even if the file was already removed.
 */
export function releaseDaemonLock(lockPath: string): void {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (pid !== process.pid) {
      // Another daemon has taken over — don't delete their lock
      return;
    }
    unlinkSync(lockPath);
    log.info(`released daemon lock at ${lockPath}`);
  } catch {
    // best effort
  }
}

/**
 * Read the pid from the lock file without acquiring it.
 * Returns null if the file doesn't exist or contains an invalid pid.
 */
export function readDaemonLockPid(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check whether there is a live daemon according to the pid lock file.
 * Returns the pid if alive, null otherwise.
 */
export function checkDaemonLockAlive(lockPath: string): number | null {
  const pid = readDaemonLockPid(lockPath);
  if (pid === null) return null;
  return isPidAlive(pid) ? pid : null;
}
