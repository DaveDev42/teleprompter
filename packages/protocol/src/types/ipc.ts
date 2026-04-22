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

/**
 * CLI → Daemon: delete a pairing. Daemon sends a `control.unpair` to any
 * connected peer on that pairing, tears down the RelayClient, and removes
 * the pairing from the store. The reply mirrors the matched daemonId so the
 * CLI can print it alongside the user's prefix input.
 */
export interface IpcPairRemove {
  t: "pair.remove";
  daemonId: string;
}

export interface IpcPairRemoveOk {
  t: "pair.remove.ok";
  daemonId: string;
  notifiedPeers: number;
}

export type IpcPairRemoveErrReason = "not-found" | "internal";

export interface IpcPairRemoveErr {
  t: "pair.remove.err";
  daemonId: string;
  reason: IpcPairRemoveErrReason;
  message?: string;
}

/**
 * CLI → Daemon: rename a pairing's label. Daemon updates the store and
 * pushes a `control.rename` frame to any connected peer. `label: null`
 * clears the label.
 */
export interface IpcPairRename {
  t: "pair.rename";
  daemonId: string;
  label: string | null;
}

export interface IpcPairRenameOk {
  t: "pair.rename.ok";
  daemonId: string;
  label: string | null;
  notifiedPeers: number;
}

export type IpcPairRenameErrReason = "not-found" | "internal";

export interface IpcPairRenameErr {
  t: "pair.rename.err";
  daemonId: string;
  reason: IpcPairRenameErrReason;
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
  | IpcPairError
  | IpcPairRemove
  | IpcPairRemoveOk
  | IpcPairRemoveErr
  | IpcPairRename
  | IpcPairRenameOk
  | IpcPairRenameErr;
