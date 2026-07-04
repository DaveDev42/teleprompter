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
  worktreePath?: string | undefined;
  claudeVersion?: string | undefined;
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
  baseBranch?: string | undefined;
  /** Optional custom path (relative to repo root) */
  path?: string | undefined;
}

export interface SessionWorktreeRemove {
  t: "worktree.remove";
  path: string;
  force?: boolean | undefined;
}

export interface SessionWorktreeList {
  t: "worktree.list";
}

export interface SessionCreate {
  t: "session.create";
  /** Worktree path to run in */
  cwd: string;
  /** Optional session ID (auto-generated if omitted) */
  sid?: string | undefined;
  /**
   * Optional initial PTY dimensions. When supplied, the runner spawns
   * claude at this winsize so the TUI splash anchors correctly and a
   * later SIGWINCH isn't needed to rectify the layout. Frontends sending
   * `session.create` should pass their current terminal canvas size.
   */
  cols?: number | undefined;
  rows?: number | undefined;
}

export interface SessionStop {
  t: "session.stop";
  sid: string;
}

export interface SessionRestart {
  t: "session.restart";
  sid: string;
}

/**
 * Frontend → daemon (over relay): permanently delete a session. Kills the
 * runner if it is running, then drops the store row. The relay-plane sibling
 * of the CLI's IPC `session.delete` — the app previously could only remove a
 * session from its local list (`tp session delete <sid>` was the only way to
 * delete daemon data). The daemon replies `session.delete.ok`/`err` to the
 * originating frontend and broadcasts a `state` (state="deleted") to all
 * frontends so every connected app drops the row.
 */
export interface SessionDelete {
  t: "session.delete";
  sid: string;
}

/** Daemon → frontend: a `session.delete` succeeded. */
export interface SessionDeleteOk {
  t: "session.delete.ok";
  sid: string;
  /** True if a live runner was killed as part of the delete. */
  wasRunning: boolean;
}

/** Daemon → frontend: a `session.delete` failed. */
export interface SessionDeleteErr {
  t: "session.delete.err";
  sid: string;
  reason: "not-found" | "internal";
  message?: string | undefined;
}

export interface SessionExport {
  t: "session.export";
  sid: string;
  format?: "json" | "markdown" | undefined;
  recordTypes?: RecordKind[] | undefined;
  timeRange?: { from?: number; to?: number } | undefined;
  limit?: number | undefined;
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
  | SessionDelete
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
    /**
     * The daemon's Pairing Confirmation Tag for the receiving frontend
     * (base64 of the 32-byte BLAKE2b-256 commit over the kx session keys —
     * `derivePairingConfirmationTag`). Additive-optional: a pre-PCT daemon
     * omits it and a pre-PCT app ignores it, so the field never gates hello
     * validity. The app compares it against its own locally-derived PCT to
     * confirm both sides share the same ECDH session (pairing redesign). Only
     * present from a PCT-capable daemon (effective WS protocol v≥3).
     */
    pct?: string;
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
  ns?: Namespace | undefined;
  n?: string | undefined;
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

/**
 * Daemon → frontend: a session was permanently removed (deleted or pruned),
 * broadcast to every currently-subscribed relay client for `sid` — not just
 * the frontend that requested the delete/prune. Without this, a frontend
 * actively attached to `sid` (Chat/Terminal tab open) learns nothing until
 * its next `hello` snapshot (on reconnect), leaving a ghost row/attach in
 * place indefinitely. Mirrors `SessionWorktreeRemoved`'s shape and broadcast
 * pattern exactly, but for a session (not a worktree) removal. `state`
 * (`SessionState`) is intentionally left unchanged — removal is a distinct
 * message, not a 4th state, matching how `worktree.removed` is separate from
 * `state`.
 */
export interface SessionRemoved {
  t: "session.removed";
  sid: string;
}

/**
 * Synchronous acknowledgement that a `session.create` was accepted by the
 * daemon. Emitted on the originating frontend's peer channel immediately after
 * the runner is spawned and the relay is subscribed to the new sid — before the
 * runner's IPC `hello` round-trips. The mirror of `SessionErr` on the failure
 * path. The canonical session-metadata signal remains the `state` broadcast
 * (from `handleHello`); this ack only confirms acceptance so the frontend can
 * optimistically attach without waiting for the hello.
 */
export interface SessionCreateOk {
  t: "session.create.ok";
  sid: string;
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
  | SessionExported
  | SessionCreateOk
  | SessionDeleteOk
  | SessionDeleteErr
  | SessionRemoved;
