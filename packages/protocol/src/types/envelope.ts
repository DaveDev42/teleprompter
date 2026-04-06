import type { Namespace, RecordKind } from "./record";

export type FrameType =
  | "hello"
  | "attach"
  | "detach"
  | "resume"
  | "rec"
  | "batch"
  | "in.chat"
  | "in.term"
  | "state"
  | "ping"
  | "pong"
  | "pushToken"
  | "err";

export interface Envelope {
  t: FrameType;
  sid?: string;
  seq?: number;
  k?: RecordKind;
  ns?: Namespace;
  n?: string;
  d?: unknown;
  c?: number;
  ts?: number;
  e?: string;
  m?: string;
}
