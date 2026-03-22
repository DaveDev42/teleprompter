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

export type WsClientMessage =
  | WsHello
  | WsAttach
  | WsDetach
  | WsResume
  | WsInChat
  | WsInTerm
  | WsPing;

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

export type WsServerMessage =
  | WsHelloReply
  | WsState
  | WsRec
  | WsBatch
  | WsPong
  | WsErr;
