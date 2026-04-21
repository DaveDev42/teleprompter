/**
 * Boundary type guards for IPC messages (Runner ↔ Daemon).
 *
 * The IPC transport hands raw decoded JSON as `unknown`. This module
 * narrows the raw value to the `IpcMessage` discriminated union with a
 * minimal, hand-rolled validator so downstream code can work in typed
 * terms and avoid ad-hoc casts.
 *
 * Validation rules:
 *  - `t` must match one of the known discriminants.
 *  - Required fields must be present and of the expected primitive type.
 *  - Optional fields, if present, must be of the expected type.
 *
 * Unknown discriminants or malformed payloads return `null`.
 */

import type {
  IpcMessage,
  IpcPairBeginErrReason,
  IpcPairErrorReason,
  IpcPairRemoveErrReason,
  IpcPairRenameErrReason,
} from "./types/ipc";
import type { Namespace, RecordKind } from "./types/record";

type PlainObject = { [key: string]: unknown };

function isObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const RECORD_KINDS: ReadonlySet<RecordKind> = new Set(["io", "event", "meta"]);
const NAMESPACES: ReadonlySet<Namespace> = new Set([
  "claude",
  "tp",
  "runner",
  "daemon",
]);
const PAIR_BEGIN_REASONS: ReadonlySet<IpcPairBeginErrReason> = new Set([
  "already-pending",
  "daemon-id-taken",
  "relay-unreachable",
  "internal",
]);
const PAIR_ERROR_REASONS: ReadonlySet<IpcPairErrorReason> = new Set([
  "relay-unreachable",
  "relay-closed",
  "kx-decrypt-failed",
  "internal",
]);
const PAIR_REMOVE_REASONS: ReadonlySet<IpcPairRemoveErrReason> = new Set([
  "not-found",
  "internal",
]);
const PAIR_RENAME_REASONS: ReadonlySet<IpcPairRenameErrReason> = new Set([
  "not-found",
  "internal",
]);

function isRecordKind(v: unknown): v is RecordKind {
  return typeof v === "string" && RECORD_KINDS.has(v as RecordKind);
}

function isOptionalNamespace(v: unknown): v is Namespace | undefined {
  if (v === undefined) return true;
  return typeof v === "string" && NAMESPACES.has(v as Namespace);
}

function isPairBeginReason(v: unknown): v is IpcPairBeginErrReason {
  return (
    typeof v === "string" && PAIR_BEGIN_REASONS.has(v as IpcPairBeginErrReason)
  );
}

function isPairErrorReason(v: unknown): v is IpcPairErrorReason {
  return (
    typeof v === "string" && PAIR_ERROR_REASONS.has(v as IpcPairErrorReason)
  );
}

function isPairRemoveReason(v: unknown): v is IpcPairRemoveErrReason {
  return (
    typeof v === "string" && PAIR_REMOVE_REASONS.has(v as IpcPairRemoveErrReason)
  );
}

function isPairRenameReason(v: unknown): v is IpcPairRenameErrReason {
  return (
    typeof v === "string" && PAIR_RENAME_REASONS.has(v as IpcPairRenameErrReason)
  );
}

/**
 * Parse a raw IPC payload into a typed IpcMessage. Returns `null` if the
 * payload is not a valid IPC message.
 */
export function parseIpcMessage(raw: unknown): IpcMessage | null {
  if (!isObject(raw)) return null;
  const t = raw.t;
  if (!isString(t)) return null;

  switch (t) {
    case "hello": {
      if (!isString(raw.sid)) return null;
      if (!isString(raw.cwd)) return null;
      if (!isNumber(raw.pid)) return null;
      if (!isOptionalString(raw.worktreePath)) return null;
      if (!isOptionalString(raw.claudeVersion)) return null;
      return {
        t: "hello",
        sid: raw.sid,
        cwd: raw.cwd,
        pid: raw.pid,
        worktreePath: raw.worktreePath,
        claudeVersion: raw.claudeVersion,
      };
    }

    case "rec": {
      if (!isString(raw.sid)) return null;
      if (!isRecordKind(raw.kind)) return null;
      if (!isNumber(raw.ts)) return null;
      if (!isString(raw.payload)) return null;
      if (!isOptionalNamespace(raw.ns)) return null;
      if (!isOptionalString(raw.name)) return null;
      return {
        t: "rec",
        sid: raw.sid,
        kind: raw.kind,
        ts: raw.ts,
        payload: raw.payload,
        ns: raw.ns,
        name: raw.name,
      };
    }

    case "bye": {
      if (!isString(raw.sid)) return null;
      if (!isNumber(raw.exitCode)) return null;
      return { t: "bye", sid: raw.sid, exitCode: raw.exitCode };
    }

    case "ack": {
      if (!isString(raw.sid)) return null;
      if (!isNumber(raw.seq)) return null;
      return { t: "ack", sid: raw.sid, seq: raw.seq };
    }

    case "input": {
      if (!isString(raw.sid)) return null;
      if (!isString(raw.data)) return null;
      return { t: "input", sid: raw.sid, data: raw.data };
    }

    case "resize": {
      if (!isString(raw.sid)) return null;
      if (!isNumber(raw.cols)) return null;
      if (!isNumber(raw.rows)) return null;
      return { t: "resize", sid: raw.sid, cols: raw.cols, rows: raw.rows };
    }

    case "pair.begin": {
      if (!isString(raw.relayUrl)) return null;
      if (!isOptionalString(raw.daemonId)) return null;
      if (!isOptionalString(raw.label)) return null;
      return {
        t: "pair.begin",
        relayUrl: raw.relayUrl,
        daemonId: raw.daemonId,
        label: raw.label,
      };
    }

    case "pair.begin.ok": {
      if (!isString(raw.pairingId)) return null;
      if (!isString(raw.qrString)) return null;
      if (!isString(raw.daemonId)) return null;
      return {
        t: "pair.begin.ok",
        pairingId: raw.pairingId,
        qrString: raw.qrString,
        daemonId: raw.daemonId,
      };
    }

    case "pair.begin.err": {
      if (!isPairBeginReason(raw.reason)) return null;
      if (!isOptionalString(raw.message)) return null;
      return {
        t: "pair.begin.err",
        reason: raw.reason,
        message: raw.message,
      };
    }

    case "pair.cancel": {
      if (!isString(raw.pairingId)) return null;
      return { t: "pair.cancel", pairingId: raw.pairingId };
    }

    case "pair.completed": {
      if (!isString(raw.pairingId)) return null;
      if (!isString(raw.daemonId)) return null;
      if (raw.label !== null && !isString(raw.label)) return null;
      return {
        t: "pair.completed",
        pairingId: raw.pairingId,
        daemonId: raw.daemonId,
        label: raw.label,
      };
    }

    case "pair.cancelled": {
      if (!isString(raw.pairingId)) return null;
      return { t: "pair.cancelled", pairingId: raw.pairingId };
    }

    case "pair.error": {
      if (!isString(raw.pairingId)) return null;
      if (!isPairErrorReason(raw.reason)) return null;
      if (!isOptionalString(raw.message)) return null;
      return {
        t: "pair.error",
        pairingId: raw.pairingId,
        reason: raw.reason,
        message: raw.message,
      };
    }

    case "pair.remove": {
      if (!isString(raw.daemonId)) return null;
      return { t: "pair.remove", daemonId: raw.daemonId };
    }

    case "pair.remove.ok": {
      if (!isString(raw.daemonId)) return null;
      if (!isNumber(raw.notifiedPeers)) return null;
      return {
        t: "pair.remove.ok",
        daemonId: raw.daemonId,
        notifiedPeers: raw.notifiedPeers,
      };
    }

    case "pair.remove.err": {
      if (!isString(raw.daemonId)) return null;
      if (!isPairRemoveReason(raw.reason)) return null;
      if (!isOptionalString(raw.message)) return null;
      return {
        t: "pair.remove.err",
        daemonId: raw.daemonId,
        reason: raw.reason,
        message: raw.message,
      };
    }

    case "pair.rename": {
      if (!isString(raw.daemonId)) return null;
      if (raw.label !== null && !isString(raw.label)) return null;
      return {
        t: "pair.rename",
        daemonId: raw.daemonId,
        label: raw.label,
      };
    }

    case "pair.rename.ok": {
      if (!isString(raw.daemonId)) return null;
      if (raw.label !== null && !isString(raw.label)) return null;
      if (!isNumber(raw.notifiedPeers)) return null;
      return {
        t: "pair.rename.ok",
        daemonId: raw.daemonId,
        label: raw.label,
        notifiedPeers: raw.notifiedPeers,
      };
    }

    case "pair.rename.err": {
      if (!isString(raw.daemonId)) return null;
      if (!isPairRenameReason(raw.reason)) return null;
      if (!isOptionalString(raw.message)) return null;
      return {
        t: "pair.rename.err",
        daemonId: raw.daemonId,
        reason: raw.reason,
        message: raw.message,
      };
    }

    default:
      return null;
  }
}
