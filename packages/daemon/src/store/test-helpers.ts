import type { Store } from "./store";

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
