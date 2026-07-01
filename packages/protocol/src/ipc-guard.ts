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

import {
  isNonNegativeInt,
  isNumber,
  isObject,
  isOptionalString,
  isPositiveInt,
  isString,
  isStringArray,
  isTerminalDimension,
  type PlainObject,
} from "./guard-primitives";
import type {
  AgeFilter,
  IpcMessage,
  IpcPairBeginErrReason,
  IpcPairErrorReason,
  IpcPairRemoveErrReason,
  IpcPairRenameErrReason,
  IpcSessionDeleteErrReason,
  IpcSessionPruneErrReason,
} from "./types/ipc";
import { decodeWireLabel, type Label } from "./types/label";
import {
  NAMESPACE_SET,
  type Namespace,
  RECORD_KIND_SET,
  type RecordKind,
} from "./types/record";

/**
 * Forgivingly narrow a raw `label` field to the `Label` union. Accepts the
 * new union object, the legacy `string` (`""` = clear), and legacy
 * `null`/`undefined`, all via `decodeWireLabel`. Returns `null` only for
 * shapes that are neither — a primitive like a number or boolean — so the
 * caller can reject a malformed frame. (`decodeWireLabel` itself never
 * throws and would map those to `{ set: false }`, but at this zero-trust
 * boundary we prefer to reject an outright wrong-typed field.)
 */
function parseLabelField(v: unknown): Label | null {
  if (
    v !== null &&
    v !== undefined &&
    typeof v !== "string" &&
    !(typeof v === "object" && "set" in (v as PlainObject))
  ) {
    return null;
  }
  return decodeWireLabel(v);
}

/**
 * Parse a raw `age` field into an {@link AgeFilter} tagged union.
 * Returns `null` when the shape is malformed.
 *
 * Valid shapes:
 *   `{ kind: "all" }`
 *   `{ kind: "olderThan"; ms: <non-negative integer> }`
 */
function parseAgeFilter(v: unknown): AgeFilter | null {
  if (!isObject(v)) return null;
  const kind = v["kind"];
  if (kind === "all") return { kind: "all" };
  if (kind === "olderThan") {
    const ms = v["ms"];
    if (!isNonNegativeInt(ms)) return null;
    return { kind: "olderThan", ms };
  }
  return null;
}

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
const SESSION_DELETE_REASONS: ReadonlySet<IpcSessionDeleteErrReason> = new Set([
  "not-found",
  "internal",
]);
const SESSION_PRUNE_REASONS: ReadonlySet<IpcSessionPruneErrReason> = new Set([
  "internal",
]);

function isRecordKind(v: unknown): v is RecordKind {
  return typeof v === "string" && RECORD_KIND_SET.has(v as RecordKind);
}

function isOptionalNamespace(v: unknown): v is Namespace | undefined {
  if (v === undefined) return true;
  return typeof v === "string" && NAMESPACE_SET.has(v as Namespace);
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
    typeof v === "string" &&
    PAIR_REMOVE_REASONS.has(v as IpcPairRemoveErrReason)
  );
}

function isPairRenameReason(v: unknown): v is IpcPairRenameErrReason {
  return (
    typeof v === "string" &&
    PAIR_RENAME_REASONS.has(v as IpcPairRenameErrReason)
  );
}

function isSessionDeleteReason(v: unknown): v is IpcSessionDeleteErrReason {
  return (
    typeof v === "string" &&
    SESSION_DELETE_REASONS.has(v as IpcSessionDeleteErrReason)
  );
}

function isSessionPruneReason(v: unknown): v is IpcSessionPruneErrReason {
  return (
    typeof v === "string" &&
    SESSION_PRUNE_REASONS.has(v as IpcSessionPruneErrReason)
  );
}

/**
 * Parse a raw IPC payload into a typed IpcMessage. Returns `null` if the
 * payload is not a valid IPC message.
 */
export function parseIpcMessage(raw: unknown): IpcMessage | null {
  if (!isObject(raw)) return null;
  const t = raw["t"];
  if (!isString(t)) return null;

  switch (t) {
    case "hello": {
      if (!isString(raw["sid"])) return null;
      if (!isString(raw["cwd"])) return null;
      if (!isPositiveInt(raw["pid"])) return null;
      if (!isOptionalString(raw["worktreePath"])) return null;
      if (!isOptionalString(raw["claudeVersion"])) return null;
      return {
        t: "hello",
        sid: raw["sid"],
        cwd: raw["cwd"],
        pid: raw["pid"],
        worktreePath: raw["worktreePath"],
        claudeVersion: raw["claudeVersion"],
      };
    }

    case "rec": {
      if (!isString(raw["sid"])) return null;
      if (!isRecordKind(raw["kind"])) return null;
      if (!isNumber(raw["ts"])) return null;
      if (!isString(raw["payload"])) return null;
      if (!isOptionalNamespace(raw["ns"])) return null;
      if (!isOptionalString(raw["name"])) return null;
      return {
        t: "rec",
        sid: raw["sid"],
        kind: raw["kind"],
        ts: raw["ts"],
        payload: raw["payload"],
        ns: raw["ns"],
        name: raw["name"],
      };
    }

    case "bye": {
      if (!isString(raw["sid"])) return null;
      if (!isNumber(raw["exitCode"])) return null;
      // `pid` is optional for wire back-compat (an older Runner omits it).
      // When present it must be a valid positive int; the daemon uses it as a
      // generation guard so a restarted session's old Runner bye cannot tear
      // down the freshly-registered new generation.
      if (raw["pid"] !== undefined && !isPositiveInt(raw["pid"])) return null;
      return {
        t: "bye",
        sid: raw["sid"],
        exitCode: raw["exitCode"],
        pid: raw["pid"] as number | undefined,
      };
    }

    case "ack": {
      if (!isString(raw["sid"])) return null;
      if (!isNonNegativeInt(raw["seq"])) return null;
      return { t: "ack", sid: raw["sid"], seq: raw["seq"] };
    }

    case "input": {
      if (!isString(raw["sid"])) return null;
      if (!isString(raw["data"])) return null;
      return { t: "input", sid: raw["sid"], data: raw["data"] };
    }

    case "resize": {
      if (!isString(raw["sid"])) return null;
      // cols/rows are uint16 at the kernel (TIOCSWINSZ ws_col/ws_row); cap at
      // 65535 so a relay-plane value the daemon forwards here cannot truncate.
      if (!isTerminalDimension(raw["cols"])) return null;
      if (!isTerminalDimension(raw["rows"])) return null;
      return {
        t: "resize",
        sid: raw["sid"],
        cols: raw["cols"],
        rows: raw["rows"],
      };
    }

    case "pair.begin": {
      if (!isString(raw["relayUrl"])) return null;
      if (!isOptionalString(raw["daemonId"])) return null;
      // `label` is optional here (absent → daemon resolves the default).
      // When present, narrow it to the Label union; reject only outright
      // wrong-typed shapes (number/boolean) as `parseLabelField` does.
      let label: Label | undefined;
      if (raw["label"] !== undefined) {
        const parsed = parseLabelField(raw["label"]);
        if (parsed === null) return null;
        label = parsed;
      }
      return {
        t: "pair.begin",
        relayUrl: raw["relayUrl"],
        daemonId: raw["daemonId"],
        label,
      };
    }

    case "pair.begin.ok": {
      if (!isString(raw["pairingId"])) return null;
      if (!isString(raw["qrString"])) return null;
      if (!isString(raw["daemonId"])) return null;
      return {
        t: "pair.begin.ok",
        pairingId: raw["pairingId"],
        qrString: raw["qrString"],
        daemonId: raw["daemonId"],
      };
    }

    case "pair.begin.err": {
      if (!isPairBeginReason(raw["reason"])) return null;
      if (!isOptionalString(raw["message"])) return null;
      return {
        t: "pair.begin.err",
        reason: raw["reason"],
        message: raw["message"],
      };
    }

    case "pair.cancel": {
      if (!isString(raw["pairingId"])) return null;
      return { t: "pair.cancel", pairingId: raw["pairingId"] };
    }

    case "pair.completed": {
      if (!isString(raw["pairingId"])) return null;
      if (!isString(raw["daemonId"])) return null;
      const label = parseLabelField(raw["label"]);
      if (label === null) return null;
      return {
        t: "pair.completed",
        pairingId: raw["pairingId"],
        daemonId: raw["daemonId"],
        label,
      };
    }

    case "pair.cancelled": {
      if (!isString(raw["pairingId"])) return null;
      return { t: "pair.cancelled", pairingId: raw["pairingId"] };
    }

    case "pair.error": {
      if (!isString(raw["pairingId"])) return null;
      if (!isPairErrorReason(raw["reason"])) return null;
      if (!isOptionalString(raw["message"])) return null;
      return {
        t: "pair.error",
        pairingId: raw["pairingId"],
        reason: raw["reason"],
        message: raw["message"],
      };
    }

    case "pair.remove": {
      if (!isString(raw["daemonId"])) return null;
      return { t: "pair.remove", daemonId: raw["daemonId"] };
    }

    case "pair.remove.ok": {
      if (!isString(raw["daemonId"])) return null;
      if (!isNonNegativeInt(raw["notifiedPeers"])) return null;
      return {
        t: "pair.remove.ok",
        daemonId: raw["daemonId"],
        notifiedPeers: raw["notifiedPeers"],
      };
    }

    case "pair.remove.err": {
      if (!isString(raw["daemonId"])) return null;
      if (!isPairRemoveReason(raw["reason"])) return null;
      if (!isOptionalString(raw["message"])) return null;
      return {
        t: "pair.remove.err",
        daemonId: raw["daemonId"],
        reason: raw["reason"],
        message: raw["message"],
      };
    }

    case "pair.rename": {
      if (!isString(raw["daemonId"])) return null;
      const label = parseLabelField(raw["label"]);
      if (label === null) return null;
      return {
        t: "pair.rename",
        daemonId: raw["daemonId"],
        label,
      };
    }

    case "pair.rename.ok": {
      if (!isString(raw["daemonId"])) return null;
      const label = parseLabelField(raw["label"]);
      if (label === null) return null;
      if (!isNonNegativeInt(raw["notifiedPeers"])) return null;
      return {
        t: "pair.rename.ok",
        daemonId: raw["daemonId"],
        label,
        notifiedPeers: raw["notifiedPeers"],
      };
    }

    case "pair.rename.err": {
      if (!isString(raw["daemonId"])) return null;
      if (!isPairRenameReason(raw["reason"])) return null;
      if (!isOptionalString(raw["message"])) return null;
      return {
        t: "pair.rename.err",
        daemonId: raw["daemonId"],
        reason: raw["reason"],
        message: raw["message"],
      };
    }

    case "session.delete": {
      if (!isString(raw["sid"])) return null;
      return { t: "session.delete", sid: raw["sid"] };
    }

    case "session.delete.ok": {
      if (!isString(raw["sid"])) return null;
      if (typeof raw["wasRunning"] !== "boolean") return null;
      return {
        t: "session.delete.ok",
        sid: raw["sid"],
        wasRunning: raw["wasRunning"],
      };
    }

    case "session.delete.err": {
      if (!isString(raw["sid"])) return null;
      if (!isSessionDeleteReason(raw["reason"])) return null;
      if (!isOptionalString(raw["message"])) return null;
      return {
        t: "session.delete.err",
        sid: raw["sid"],
        reason: raw["reason"],
        message: raw["message"],
      };
    }

    case "session.prune": {
      const age = parseAgeFilter(raw["age"]);
      if (age === null) return null;
      if (typeof raw["includeRunning"] !== "boolean") return null;
      if (typeof raw["dryRun"] !== "boolean") return null;
      return {
        t: "session.prune",
        age,
        includeRunning: raw["includeRunning"],
        dryRun: raw["dryRun"],
      };
    }

    case "session.prune.ok": {
      if (!isStringArray(raw["sids"])) return null;
      if (!isNonNegativeInt(raw["runningKilled"])) return null;
      if (typeof raw["dryRun"] !== "boolean") return null;
      return {
        t: "session.prune.ok",
        sids: raw["sids"],
        runningKilled: raw["runningKilled"],
        dryRun: raw["dryRun"],
      };
    }

    case "session.prune.err": {
      if (!isSessionPruneReason(raw["reason"])) return null;
      if (!isOptionalString(raw["message"])) return null;
      if (!isStringArray(raw["partialSids"])) return null;
      if (!isNonNegativeInt(raw["partialRunningKilled"])) return null;
      return {
        t: "session.prune.err",
        reason: raw["reason"],
        message: raw["message"],
        partialSids: raw["partialSids"],
        partialRunningKilled: raw["partialRunningKilled"],
      };
    }

    case "doctor.probe":
      return { t: "doctor.probe" };

    case "doctor.probe.ok": {
      if (!Array.isArray(raw["relays"])) return null;
      const relays: {
        daemonId: string;
        relayUrl: string;
        connected: boolean;
        peerCount: number;
        throttled?: boolean;
      }[] = [];
      for (const r of raw["relays"]) {
        if (!isObject(r)) return null;
        if (!isString(r["daemonId"])) return null;
        if (!isString(r["relayUrl"])) return null;
        if (typeof r["connected"] !== "boolean") return null;
        if (!isNonNegativeInt(r["peerCount"])) return null;
        // `throttled` is optional for wire back-compat: an older daemon omits
        // it. Present → must be a real boolean; absent → left undefined (the
        // CLI treats undefined as false).
        if (r["throttled"] !== undefined && typeof r["throttled"] !== "boolean")
          return null;
        relays.push({
          daemonId: r["daemonId"],
          relayUrl: r["relayUrl"],
          connected: r["connected"],
          peerCount: r["peerCount"],
          ...(r["throttled"] !== undefined
            ? { throttled: r["throttled"] }
            : {}),
        });
      }
      return { t: "doctor.probe.ok", relays };
    }

    default:
      return null;
  }
}
