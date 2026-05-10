import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import * as lockfile from "proper-lockfile";

export type PairLockRelease = (() => Promise<void>) | null;

/**
 * proper-lockfile's stale window. The lock holder updates the lockfile
 * mtime on a `stale/2` cadence by default, so a holder that's still alive
 * will refresh the mtime well before this window elapses. A holder that
 * crashed (SIGKILL) leaves the directory behind without further updates,
 * and the next `tp pair new` will treat the lock as stale once the mtime
 * is older than this threshold.
 *
 * 10s was chosen so that a user re-running `tp pair new` after a daemon
 * crash recovers within ~10s, without being so short that the holder's
 * own update cadence (5s default = stale/2) races against self-eviction.
 * The historical value (30s) blocked the first-run wizard for half a
 * minute after `pkill -9`.
 */
const STALE_MS = 10_000;

/**
 * Acquire the pair lock. Returns a release function on success, or `null` if
 * the lock is genuinely held by another live process. Stale locks (holder
 * crashed) auto-clean on the very first attempt: proper-lockfile's mkdir
 * fails with EEXIST, it stats the existing dir, and removes it as stale
 * if the mtime is older than {@link STALE_MS}. A live holder still wins
 * here — fresh mtime means we return null promptly and the caller can
 * print a clear "already running" error.
 */
export async function acquirePairLock(
  lockPath: string,
): Promise<PairLockRelease> {
  mkdirSync(dirname(lockPath), { recursive: true });
  // proper-lockfile requires the target file to exist.
  try {
    writeFileSync(lockPath, "", { flag: "a" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  try {
    const release = await lockfile.lock(lockPath, {
      stale: STALE_MS,
      retries: 0,
    });
    return release;
  } catch {
    return null;
  }
}

export async function releasePairLock(release: PairLockRelease): Promise<void> {
  if (release) {
    try {
      await release();
    } catch {
      // best effort
    }
  }
}
