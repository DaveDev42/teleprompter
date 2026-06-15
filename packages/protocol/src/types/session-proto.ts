// Session control/data protocol — messages exchanged between frontend and
// daemon over the relay (Session* types). Formerly Ws-prefixed; renamed after
// the direct-WS transport was removed, since these are shared protocol types
// rather than WebSocket-transport-specific.
import type { Label } from "./label";
import type { Namespace, RecordKind } from "./record";
import type { SessionState } from "./session";

// ── Session metadata sent to the frontend ──

export interface SessionMeta {
  sid: string;
  state: SessionState;
  cwd: string;
  worktreePath?: string;
  claudeVersion?: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
}

// ── Frontend → Daemon ──

export interface SessionHello {
  t: "hello";
  /** Protocol version */
  v: number;
}

export interface SessionAttach {
  t: "attach";
  sid: string;
}

export interface SessionDetach {
  t: "detach";
  sid: string;
}

export interface SessionResume {
  t: "resume";
  sid: string;
  c: number; // cursor (last seen seq)
}

export interface SessionInChat {
  t: "in.chat";
  sid: string;
  d: string; // plain text
}

export interface SessionInTerm {
  t: "in.term";
  sid: string;
  d: string; // base64
}

export interface SessionPing {
  t: "ping";
}

export interface SessionResize {
  t: "resize";
  sid: string;
  cols: number;
  rows: number;
}

export interface SessionWorktreeCreate {
  t: "worktree.create";
  branch: string;
  /** Optional base branch */
  baseBranch?: string;
  /** Optional custom path (relative to repo root) */
  path?: string;
}

export interface SessionWorktreeRemove {
  t: "worktree.remove";
  path: string;
  force?: boolean;
}

export interface SessionWorktreeList {
  t: "worktree.list";
}

export interface SessionCreate {
  t: "session.create";
  /** Worktree path to run in */
  cwd: string;
  /** Optional session ID (auto-generated if omitted) */
  sid?: string;
  /**
   * Optional initial PTY dimensions. When supplied, the runner spawns
   * claude at this winsize so the TUI splash anchors correctly and a
   * later SIGWINCH isn't needed to rectify the layout. Frontends sending
   * `session.create` should pass their current terminal canvas size.
   */
  cols?: number;
  rows?: number;
}

export interface SessionStop {
  t: "session.stop";
  sid: string;
}

export interface SessionRestart {
  t: "session.restart";
  sid: string;
}

export interface SessionExport {
  t: "session.export";
  sid: string;
  format?: "json" | "markdown";
  recordTypes?: RecordKind[];
  timeRange?: { from?: number; to?: number };
  limit?: number;
}

export type SessionClientMessage =
  | SessionHello
  | SessionAttach
  | SessionDetach
  | SessionResume
  | SessionInChat
  | SessionInTerm
  | SessionResize
  | SessionPing
  | SessionWorktreeCreate
  | SessionWorktreeRemove
  | SessionWorktreeList
  | SessionCreate
  | SessionStop
  | SessionRestart
  | SessionExport;

// ── Daemon → Frontend ──

export interface SessionHelloReply {
  t: "hello";
  v: number;
  d: {
    sessions: SessionMeta[];
    /**
     * The daemon's pairing label, broadcast on the meta `hello` so a frontend
     * that reconnected after the initial `relay.kx` can still adopt it. A
     * keep-current surface: `{ set: false }` / absence both mean "keep my
     * fallback", so the reader decodes it forgivingly via `decodeKxLabelOrKeep`
     * (which also accepts the legacy `string` shape from an older daemon).
     */
    daemonLabel?: Label;
  };
}

export interface SessionStateMsg {
  t: "state";
  sid: string;
  d: SessionMeta;
}

export interface SessionRec {
  t: "rec";
  sid: string;
  seq: number;
  k: RecordKind;
  ns?: Namespace;
  n?: string;
  d: string; // base64 payload
  ts: number;
}

export interface SessionBatch {
  t: "batch";
  sid: string;
  d: SessionRec[];
}

export interface SessionPong {
  t: "pong";
}

export interface SessionErr {
  t: "err";
  e: string;
  m?: string;
}

export interface SessionWorktreeInfo {
  path: string;
  /**
   * The checked-out branch name, or `null` for detached-HEAD and bare
   * worktrees where no branch is active.
   */
  branch: string | null;
  head: string;
  isMain: boolean;
}

export interface SessionWorktreeListReply {
  t: "worktree.list";
  d: SessionWorktreeInfo[];
}

export interface SessionWorktreeCreated {
  t: "worktree.created";
  d: SessionWorktreeInfo;
  /** Auto-created session ID (if worktree was created with auto-session) */
  sid?: string;
}

export interface SessionWorktreeRemoved {
  t: "worktree.removed";
  path: string;
}

export interface SessionExported {
  t: "session.exported";
  sid: string;
  format: "json" | "markdown";
  d: string;
}

export type SessionServerMessage =
  | SessionHelloReply
  | SessionStateMsg
  | SessionRec
  | SessionBatch
  | SessionPong
  | SessionErr
  | SessionWorktreeListReply
  | SessionWorktreeCreated
  | SessionWorktreeRemoved
  | SessionExported;
