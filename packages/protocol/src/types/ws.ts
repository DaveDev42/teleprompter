import type { RecordKind, Namespace } from "./record";

// ── Session metadata sent over WS ──

export interface WsSessionMeta {
  sid: string;
  state: string;
  cwd: string;
  worktreePath?: string;
  claudeVersion?: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
}

// ── Frontend → Daemon ──

export interface WsHello {
  t: "hello";
}

export interface WsAttach {
  t: "attach";
  sid: string;
}

export interface WsDetach {
  t: "detach";
  sid: string;
}

export interface WsResume {
  t: "resume";
  sid: string;
  c: number; // cursor (last seen seq)
}

export interface WsInChat {
  t: "in.chat";
  sid: string;
  d: string; // plain text
}

export interface WsInTerm {
  t: "in.term";
  sid: string;
  d: string; // base64
}

export interface WsPing {
  t: "ping";
}

export interface WsResize {
  t: "resize";
  sid: string;
  cols: number;
  rows: number;
}

export interface WsWorktreeCreate {
  t: "worktree.create";
  branch: string;
  /** Optional base branch */
  baseBranch?: string;
  /** Optional custom path (relative to repo root) */
  path?: string;
}

export interface WsWorktreeRemove {
  t: "worktree.remove";
  path: string;
  force?: boolean;
}

export interface WsWorktreeList {
  t: "worktree.list";
}

export interface WsSessionCreate {
  t: "session.create";
  /** Worktree path to run in */
  cwd: string;
  /** Optional session ID (auto-generated if omitted) */
  sid?: string;
}

export interface WsSessionStop {
  t: "session.stop";
  sid: string;
}

export type WsClientMessage =
  | WsHello
  | WsAttach
  | WsDetach
  | WsResume
  | WsInChat
  | WsInTerm
  | WsResize
  | WsPing
  | WsWorktreeCreate
  | WsWorktreeRemove
  | WsWorktreeList
  | WsSessionCreate
  | WsSessionStop;

// ── Daemon → Frontend ──

export interface WsHelloReply {
  t: "hello";
  d: { sessions: WsSessionMeta[] };
}

export interface WsState {
  t: "state";
  sid: string;
  d: WsSessionMeta;
}

export interface WsRec {
  t: "rec";
  sid: string;
  seq: number;
  k: RecordKind;
  ns?: Namespace;
  n?: string;
  d: string; // base64 payload
  ts: number;
}

export interface WsBatch {
  t: "batch";
  sid: string;
  d: WsRec[];
}

export interface WsPong {
  t: "pong";
}

export interface WsErr {
  t: "err";
  e: string;
  m?: string;
}

export interface WsWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

export interface WsWorktreeListReply {
  t: "worktree.list";
  d: WsWorktreeInfo[];
}

export interface WsWorktreeCreated {
  t: "worktree.created";
  d: WsWorktreeInfo;
  /** Auto-created session ID (if worktree was created with auto-session) */
  sid?: string;
}

export interface WsWorktreeRemoved {
  t: "worktree.removed";
  path: string;
}

export type WsServerMessage =
  | WsHelloReply
  | WsState
  | WsRec
  | WsBatch
  | WsPong
  | WsErr
  | WsWorktreeListReply
  | WsWorktreeCreated
  | WsWorktreeRemoved;
