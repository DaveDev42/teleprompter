import { rmSync } from "fs";
import type { Store } from "./store";

/**
 * Recursive rm with retries for Windows, where SQLite WAL sidecar handles
 * may not be released immediately after `db.close()`. Mirrors the retry
 * policy in `Store.unlinkRetry`.
 */
export function rmRetry(path: string, maxAttempts = 6): void {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
        // Force sqlite finalizer to run and release OS handles on Windows.
        if (process.platform === "win32") {
          Bun.gc(true);
        }
        Bun.sleepSync(25 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  // Best-effort: do not throw from test teardown on persistent lock.
}

/**
 * Backdate a session's updated_at timestamp for testing pruning behavior.
 */
export function backdateSession(store: Store, sid: string, ms: number): void {
  const updatedAt = Date.now() - ms;
  const metaDb = (
    store as unknown as {
      metaDb: { run: (sql: string, params: unknown[]) => void };
    }
  ).metaDb;
  metaDb.run(`UPDATE sessions SET updated_at = ? WHERE sid = ?`, [
    updatedAt,
    sid,
  ]);
}
