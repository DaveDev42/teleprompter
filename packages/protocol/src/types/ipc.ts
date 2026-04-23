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

/**
 * CLI → Daemon: delete a single session. If the session is currently running
 * the daemon kills the Runner first, then removes the metadata row and the
 * per-session record database. The reply mirrors the matched sid so the CLI
 * can print it alongside the user's prefix input.
 */
export interface IpcSessionDelete {
  t: "session.delete";
  sid: string;
}

export interface IpcSessionDeleteOk {
  t: "session.delete.ok";
  sid: string;
  /** Whether the session was running at the moment of deletion. */
  wasRunning: boolean;
}

export type IpcSessionDeleteErrReason = "not-found" | "internal";

export interface IpcSessionDeleteErr {
  t: "session.delete.err";
  sid: string;
  reason: IpcSessionDeleteErrReason;
  message?: string;
}

/**
 * CLI → Daemon: prune sessions matching a filter. `olderThanMs` scopes to
 * stopped/error sessions whose `updated_at` is older than the given age.
 * `includeRunning` forces running sessions into the selection (their Runner
 * is killed first). `dryRun` returns the selection without deleting.
 */
export interface IpcSessionPrune {
  t: "session.prune";
  /** Milliseconds; stopped/error sessions whose `updated_at` is older than
   * this cutoff are selected. `null` means no age filter (all). */
  olderThanMs: number | null;
  /** When true, running sessions are also selected and killed before delete. */
  includeRunning: boolean;
  /** When true, return the selection without deleting. */
  dryRun: boolean;
}

export interface IpcSessionPruneOk {
  t: "session.prune.ok";
  /** sids selected (and deleted, unless `dryRun` was true). */
  sids: string[];
  /** How many of the deleted sessions were running (kill count). */
  runningKilled: number;
  dryRun: boolean;
}

export interface IpcSessionPruneErr {
  t: "session.prune.err";
  reason: "internal";
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
  | IpcPairRenameErr
  | IpcSessionDelete
  | IpcSessionDeleteOk
  | IpcSessionDeleteErr
  | IpcSessionPrune
  | IpcSessionPruneOk
  | IpcSessionPruneErr;
