import type { WsSessionMeta } from "@teleprompter/protocol";
import type { SessionMeta } from "./store";

/**
 * Convert an internal `SessionMeta` row into the wire-format
 * `WsSessionMeta` shape frontends consume. Translates snake_case DB columns
 * and drops nullable fields in favor of `undefined` so Zod `.optional()`
 * on the frontend accepts them.
 */
export function toWsSessionMeta(meta: SessionMeta): WsSessionMeta {
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
