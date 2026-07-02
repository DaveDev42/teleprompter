import type { Label } from "./label";
import type { Namespace, RecordKind } from "./record";

export interface IpcHello {
  t: "hello";
  sid: string;
  cwd: string;
  worktreePath?: string | undefined;
  claudeVersion?: string | undefined;
  pid: number;
}

export interface IpcRec {
  t: "rec";
  sid: string;
  kind: RecordKind;
  ts: number;
  ns?: Namespace | undefined;
  name?: string | undefined;
  payload: string; // base64
}

export interface IpcBye {
  t: "bye";
  sid: string;
  exitCode: number;
  /**
   * `process.pid` of the Runner that sent this bye. Optional for wire
   * back-compat (an older Runner omits it). The daemon uses it as a
   * generation guard: after `session.restart` kills the old Runner and spawns
   * a new one for the same sid, the old Runner's bye (sent on SIGTERM) must
   * not tear down the freshly-registered new generation. When present and it
   * does not match the currently-registered Runner's pid, the bye is ignored.
   */
  pid?: number | undefined;
  /**
   * Why `Runner.stop()` was invoked. Optional for wire back-compat (an older
   * Runner omits it — the daemon then falls back to exitCode-based state).
   * `"signal"` means stop() was triggered by something OTHER than claude's
   * own process exit (graceful SIGTERM/SIGINT shutdown, or the IPC socket
   * being torn down) — these are daemon/transport-initiated stops (e.g. the
   * user tapping Stop, or `session.restart`) and must always resolve to
   * session state "stopped", regardless of the exitCode the shell reports for
   * a signal-killed process. `"exit"` means claude's own process exited on
   * its own (the PTY's `onExit` callback), so the real exitCode is
   * meaningful and non-zero means "error".
   */
  reason?: "signal" | "exit" | undefined;
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
  daemonId?: string | undefined;
  /** Pairing label as a tagged union; `{ set: false }` = use the default. */
  label?: Label | undefined;
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
  message?: string | undefined;
}

export interface IpcPairCancel {
  t: "pair.cancel";
  pairingId: string;
}

export interface IpcPairCompleted {
  t: "pair.completed";
  pairingId: string;
  daemonId: string;
  /** Pairing label as a tagged union; `{ set: false }` = no label. */
  label: Label;
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
  message?: string | undefined;
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
  message?: string | undefined;
}

/**
 * CLI → Daemon: rename a pairing's label. Daemon updates the store and
 * pushes a `control.rename` frame to any connected peer. `{ set: false }`
 * clears the label.
 */
export interface IpcPairRename {
  t: "pair.rename";
  daemonId: string;
  /** New label as a tagged union; `{ set: false }` clears it. */
  label: Label;
}

export interface IpcPairRenameOk {
  t: "pair.rename.ok";
  daemonId: string;
  /** The applied label, echoed back to the CLI for display. */
  label: Label;
  notifiedPeers: number;
}

export type IpcPairRenameErrReason = "not-found" | "internal";

export interface IpcPairRenameErr {
  t: "pair.rename.err";
  daemonId: string;
  reason: IpcPairRenameErrReason;
  message?: string | undefined;
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
  message?: string | undefined;
}

/**
 * Discriminated union describing the age filter for `session.prune`.
 *
 * - `{ kind: "all" }` — select every stopped/error session regardless of age.
 * - `{ kind: "olderThan"; ms: number }` — select sessions whose `updated_at`
 *   is older than `ms` milliseconds ago (must be a positive non-negative integer).
 *
 * Replaces the former `olderThanMs: number | null` sentinel, where `null` was
 * overloaded to mean "no age filter".
 */
export type AgeFilter = { kind: "all" } | { kind: "olderThan"; ms: number };

/**
 * CLI → Daemon: prune sessions matching a filter. `age` scopes to
 * stopped/error sessions; `{ kind: "all" }` matches every stopped/error
 * session, `{ kind: "olderThan"; ms }` matches sessions older than `ms`.
 * `includeRunning` forces running sessions into the selection (their Runner
 * is killed first). `dryRun` returns the selection without deleting.
 */
export interface IpcSessionPrune {
  t: "session.prune";
  /** Age filter; see {@link AgeFilter}. */
  age: AgeFilter;
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

export type IpcSessionPruneErrReason = "internal";

export interface IpcSessionPruneErr {
  t: "session.prune.err";
  reason: IpcSessionPruneErrReason;
  message?: string | undefined;
  /**
   * Sids already deleted before the throw occurred, so the CLI can report
   * "deleted 2/5, then error" instead of suggesting nothing happened.
   * Always present (possibly empty) so callers don't branch on undefined.
   */
  partialSids: string[];
  /**
   * Runners killed before the throw (<= partialSids.length). Lets the CLI
   * distinguish "2 stopped rows deleted" from "2 live sessions killed and
   * deleted" in the partial-failure report.
   */
  partialRunningKilled: number;
}

/**
 * CLI → Daemon: request relay connection health from the daemon's live
 * RelayClient instances. The daemon replies with per-pairing status without
 * opening a second WebSocket connection to the relay.
 */
export interface IpcDoctorProbe {
  t: "doctor.probe";
}

/** Per-pairing relay health snapshot returned by the daemon. */
export interface IpcDoctorRelayStatus {
  daemonId: string;
  relayUrl: string;
  connected: boolean;
  /** Number of frontends that have completed key exchange. */
  peerCount: number;
  /**
   * `true` when this pairing is in the dead-pairing reconnect throttle
   * (`peerlessReconnects >= PEERLESS_RECONNECT_THRESHOLD`): the socket keeps
   * reconnecting but no frontend has ever completed key exchange, so the client
   * has backed off to the long (30-min) interval. In that state
   * `connected: false` is EXPECTED and healthy — the pairing is simply idle
   * (closed tab / old app instance / never-scanned QR), NOT a relay outage or
   * auth failure. `doctor` uses this to avoid the misleading "relay unreachable
   * or auth failed" verdict. Optional for wire back-compat: an older daemon
   * omits it (readers treat absent as `false`).
   */
  throttled?: boolean;
}

export interface IpcDoctorProbeOk {
  t: "doctor.probe.ok";
  relays: IpcDoctorRelayStatus[];
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
  | IpcSessionPruneErr
  | IpcDoctorProbe
  | IpcDoctorProbeOk;
