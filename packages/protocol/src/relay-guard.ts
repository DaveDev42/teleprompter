/**
 * Boundary type guard for relay control-plane messages (Frontend → Daemon).
 *
 * Frames that arrive on the RELAY_CHANNEL_CONTROL virtual session (and
 * per-session control frames) are opaque ciphertext to the relay. After
 * decryption by the daemon's RelayClient, the resulting JSON is still
 * untyped. This module narrows it to a `RelayControlMessage` discriminated
 * union so the daemon can branch in fully-typed terms.
 *
 * Not covered here:
 *  - `in.chat` / `in.term` — routed via the `onInput` callback path
 *  - `control.unpair` / `control.rename` — intercepted inside
 *    `RelayClient.decryptAndDispatch` and never reach this guard.
 *
 * Unknown discriminants or malformed payloads return `null`.
 */

import {
  isNonNegativeInt,
  isNumber,
  isObject,
  isOptionalBoolean,
  isOptionalNumber,
  isOptionalString,
  isOptionalTerminalDimension,
  isString,
  isTerminalDimension,
} from "./guard-primitives";
import { RECORD_KIND_SET, type RecordKind } from "./types/record";
import type {
  SessionAttach,
  SessionCreate,
  SessionDelete,
  SessionDetach,
  SessionExport,
  SessionHello,
  SessionPing,
  SessionResize,
  SessionRestart,
  SessionResume,
  SessionStop,
  SessionWorktreeCreate,
  SessionWorktreeList,
  SessionWorktreeRemove,
} from "./types/session-proto";

/**
 * Subset of frontend-originated control-plane messages the daemon handles
 * via the relay's onControlMessage path.
 */
export type RelayControlMessage =
  | SessionHello
  | SessionAttach
  | SessionDetach
  | SessionResume
  | SessionResize
  | SessionPing
  | SessionCreate
  | SessionStop
  | SessionRestart
  | SessionDelete
  | SessionExport
  | SessionWorktreeList
  | SessionWorktreeCreate
  | SessionWorktreeRemove;

function isOptionalPositiveInt(v: unknown): v is number | undefined {
  return (
    v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0)
  );
}

function isRecordKindArray(v: unknown): v is RecordKind[] | undefined {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every(
    (item) =>
      typeof item === "string" && RECORD_KIND_SET.has(item as RecordKind),
  );
}

function isTimeRange(
  v: unknown,
): v is { from?: number; to?: number } | undefined {
  if (v === undefined) return true;
  if (!isObject(v)) return false;
  if (!isOptionalNumber(v["from"])) return false;
  if (!isOptionalNumber(v["to"])) return false;
  return true;
}

function isExportFormat(v: unknown): v is "json" | "markdown" | undefined {
  return v === undefined || v === "json" || v === "markdown";
}

/**
 * Parse a raw (decrypted) relay control message into a typed discriminated
 * union. Returns `null` if the payload is not a recognized control message.
 */
export function parseRelayControlMessage(
  raw: unknown,
): RelayControlMessage | null {
  if (!isObject(raw)) return null;
  const t = raw["t"];
  if (!isString(t)) return null;

  switch (t) {
    case "hello": {
      if (!isNumber(raw["v"])) return null;
      return { t: "hello", v: raw["v"] } satisfies SessionHello;
    }

    case "attach": {
      if (!isString(raw["sid"])) return null;
      return { t: "attach", sid: raw["sid"] } satisfies SessionAttach;
    }

    case "detach": {
      if (!isString(raw["sid"])) return null;
      return { t: "detach", sid: raw["sid"] } satisfies SessionDetach;
    }

    case "resume": {
      if (!isString(raw["sid"])) return null;
      if (!isNonNegativeInt(raw["c"])) return null;
      return {
        t: "resume",
        sid: raw["sid"],
        c: raw["c"],
      } satisfies SessionResume;
    }

    case "resize": {
      if (!isString(raw["sid"])) return null;
      if (!isTerminalDimension(raw["cols"])) return null;
      if (!isTerminalDimension(raw["rows"])) return null;
      return {
        t: "resize",
        sid: raw["sid"],
        cols: raw["cols"],
        rows: raw["rows"],
      } satisfies SessionResize;
    }

    case "ping":
      return { t: "ping" } satisfies SessionPing;

    case "session.create": {
      if (!isString(raw["cwd"])) return null;
      if (!isOptionalString(raw["sid"])) return null;
      if (!isOptionalTerminalDimension(raw["cols"])) return null;
      if (!isOptionalTerminalDimension(raw["rows"])) return null;
      return {
        t: "session.create",
        cwd: raw["cwd"],
        sid: raw["sid"],
        cols: raw["cols"],
        rows: raw["rows"],
      } satisfies SessionCreate;
    }

    case "session.stop": {
      if (!isString(raw["sid"])) return null;
      return { t: "session.stop", sid: raw["sid"] } satisfies SessionStop;
    }

    case "session.restart": {
      if (!isString(raw["sid"])) return null;
      return { t: "session.restart", sid: raw["sid"] } satisfies SessionRestart;
    }

    case "session.delete": {
      if (!isString(raw["sid"])) return null;
      return { t: "session.delete", sid: raw["sid"] } satisfies SessionDelete;
    }

    case "session.export": {
      if (!isString(raw["sid"])) return null;
      if (!isExportFormat(raw["format"])) return null;
      if (!isRecordKindArray(raw["recordTypes"])) return null;
      if (!isTimeRange(raw["timeRange"])) return null;
      // `limit` must be a positive integer (or absent). isOptionalNumber would
      // accept -1, which becomes SQLite `LIMIT -1` (= no limit) after the
      // Math.min(limit, 50000) downstream, bypassing the 50000-row export cap.
      if (!isOptionalPositiveInt(raw["limit"])) return null;
      return {
        t: "session.export",
        sid: raw["sid"],
        format: raw["format"],
        recordTypes: raw["recordTypes"],
        timeRange: raw["timeRange"],
        limit: raw["limit"],
      } satisfies SessionExport;
    }

    case "worktree.list":
      return { t: "worktree.list" } satisfies SessionWorktreeList;

    case "worktree.create": {
      if (!isString(raw["branch"])) return null;
      if (!isOptionalString(raw["baseBranch"])) return null;
      if (!isOptionalString(raw["path"])) return null;
      return {
        t: "worktree.create",
        branch: raw["branch"],
        baseBranch: raw["baseBranch"],
        path: raw["path"],
      } satisfies SessionWorktreeCreate;
    }

    case "worktree.remove": {
      if (!isString(raw["path"])) return null;
      if (!isOptionalBoolean(raw["force"])) return null;
      return {
        t: "worktree.remove",
        path: raw["path"],
        force: raw["force"],
      } satisfies SessionWorktreeRemove;
    }

    default:
      return null;
  }
}
