import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import * as lockfile from "proper-lockfile";

export type PairLockRelease = (() => Promise<void>) | null;

/**
 * Acquire the pair lock. Returns a release function on success, or `null` if
 * the lock is already held by another process. Stale locks are auto-cleaned
 * after 30s of inactivity.
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
      stale: 30_000,
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
