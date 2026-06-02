import type { SessionMeta } from "@teleprompter/protocol";
import type { SessionMeta as StoreSessionMeta } from "./store";

/**
 * Convert an internal store row (`StoreSessionMeta`, snake_case DB columns)
 * into the wire-format `SessionMeta` shape frontends consume. Drops nullable
 * fields in favor of `undefined` so Zod `.optional()` on the frontend accepts
 * them.
 */
export function toSessionMeta(meta: StoreSessionMeta): SessionMeta {
  return {
    sid: meta.sid,
    state: meta.state,
    cwd: meta.cwd,
    worktreePath: meta.worktree_path ?? undefined,
    claudeVersion: meta.claude_version ?? undefined,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    lastSeq: meta.last_seq,
  };
}
