export type SID = string;

export type SessionState = "running" | "stopped" | "error";

const SESSION_STATES: readonly SessionState[] = ["running", "stopped", "error"];

/** Type guard: is `v` one of the known `SessionState` literals? */
export function isSessionState(v: unknown): v is SessionState {
  return (
    typeof v === "string" && (SESSION_STATES as readonly string[]).includes(v)
  );
}

/**
 * Narrow an arbitrary string (e.g. a raw SQLite `state` column) to a
 * `SessionState`. Unknown values fall back to `"error"` rather than silently
 * crossing the wire as an unvalidated string — a corrupt/legacy row surfaces
 * as a read-only "error" session instead of a value the frontend can't match.
 */
export function toSessionState(v: string): SessionState {
  return isSessionState(v) ? v : "error";
}

export interface Session {
  sid: SID;
  state: SessionState;
  worktreePath?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  claudeVersion?: string;
  lastSeq: number;
}
