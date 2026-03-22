import type { RecordKind, Namespace } from "./record";

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
