export type SID = string;

export type SessionState = "running" | "stopped" | "error";

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
