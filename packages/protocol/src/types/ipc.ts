import type { Namespace, RecordKind } from "./record";

export interface IpcHello {
  t: "hello";
  sid: string;
  cwd: string;
  worktreePath?: string;
  claudeVersion?: string;
  pid: number;
}

export interface IpcRec {
  t: "rec";
  sid: string;
  kind: RecordKind;
  ts: number;
  ns?: Namespace;
  name?: string;
  payload: string; // base64
}

export interface IpcBye {
  t: "bye";
  sid: string;
  exitCode: number;
}

export interface IpcAck {
  t: "ack";
  sid: string;
  seq: number;
}

export interface IpcInput {
  t: "input";
  sid: string;
  data: string; // base64
}

export interface IpcResize {
  t: "resize";
  sid: string;
  cols: number;
  rows: number;
}

export interface IpcPairBegin {
  t: "pair.begin";
  relayUrl: string;
  daemonId?: string;
  label?: string;
}

export interface IpcPairBeginOk {
  t: "pair.begin.ok";
  pairingId: string;
  qrString: string;
  daemonId: string;
}

export type IpcPairBeginErrReason =
  | "already-pending"
  | "daemon-id-taken"
  | "relay-unreachable"
  | "internal";

export interface IpcPairBeginErr {
  t: "pair.begin.err";
  reason: IpcPairBeginErrReason;
  message?: string;
}

export interface IpcPairCancel {
  t: "pair.cancel";
  pairingId: string;
}

export interface IpcPairCompleted {
  t: "pair.completed";
  pairingId: string;
  daemonId: string;
  label: string | null;
}

export interface IpcPairCancelled {
  t: "pair.cancelled";
  pairingId: string;
}

export type IpcPairErrorReason =
  | "relay-unreachable"
  | "relay-closed"
  | "kx-decrypt-failed"
  | "internal";

export interface IpcPairError {
  t: "pair.error";
  pairingId: string;
  reason: IpcPairErrorReason;
  message?: string;
}

export type IpcMessage =
  | IpcHello
  | IpcRec
  | IpcBye
  | IpcAck
  | IpcInput
  | IpcResize
  | IpcPairBegin
  | IpcPairBeginOk
  | IpcPairBeginErr
  | IpcPairCancel
  | IpcPairCompleted
  | IpcPairCancelled
  | IpcPairError;
