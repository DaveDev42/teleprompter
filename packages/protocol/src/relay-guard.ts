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
 *  - `pushToken` — routed via the `onPushToken` callback path
 *  - `control.unpair` / `control.rename` — intercepted inside
 *    `RelayClient.decryptAndDispatch` and never reach this guard.
 *
 * Unknown discriminants or malformed payloads return `null`.
 */

import type { RecordKind } from "./types/record";
import type {
  WsAttach,
  WsDetach,
  WsHello,
  WsPing,
  WsResize,
  WsResume,
  WsSessionCreate,
  WsSessionExport,
  WsSessionRestart,
  WsSessionStop,
  WsWorktreeCreate,
  WsWorktreeList,
  WsWorktreeRemove,
} from "./types/ws";

/**
 * Subset of frontend-originated control-plane messages the daemon handles
 * via the relay's onControlMessage path.
 */
export type RelayControlMessage =
  | WsHello
  | WsAttach
  | WsDetach
  | WsResume
  | WsResize
  | WsPing
  | WsSessionCreate
  | WsSessionStop
  | WsSessionRestart
  | WsSessionExport
  | WsWorktreeList
  | WsWorktreeCreate
  | WsWorktreeRemove;

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

function isOptionalNumber(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function isOptionalBoolean(v: unknown): v is boolean | undefined {
  return v === undefined || typeof v === "boolean";
}

const RECORD_KINDS = new Set<RecordKind>(["io", "event", "meta"]);

function isRecordKindArray(v: unknown): v is RecordKind[] | undefined {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every(
    (item) => typeof item === "string" && RECORD_KINDS.has(item as RecordKind),
  );
}

function isTimeRange(
  v: unknown,
): v is { from?: number; to?: number } | undefined {
  if (v === undefined) return true;
  if (!isObject(v)) return false;
  if (!isOptionalNumber(v.from)) return false;
  if (!isOptionalNumber(v.to)) return false;
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
  const t = raw.t;
  if (!isString(t)) return null;

  switch (t) {
    case "hello": {
      if (!isNumber(raw.v)) return null;
      return { t: "hello", v: raw.v } satisfies WsHello;
    }

    case "attach": {
      if (!isString(raw.sid)) return null;
      return { t: "attach", sid: raw.sid } satisfies WsAttach;
    }

    case "detach": {
      if (!isString(raw.sid)) return null;
      return { t: "detach", sid: raw.sid } satisfies WsDetach;
    }

    case "resume": {
      if (!isString(raw.sid)) return null;
      if (!isNumber(raw.c)) return null;
      return { t: "resume", sid: raw.sid, c: raw.c } satisfies WsResume;
    }

    case "resize": {
      if (!isString(raw.sid)) return null;
      if (!isNumber(raw.cols)) return null;
      if (!isNumber(raw.rows)) return null;
      return {
        t: "resize",
        sid: raw.sid,
        cols: raw.cols,
        rows: raw.rows,
      } satisfies WsResize;
    }

    case "ping":
      return { t: "ping" } satisfies WsPing;

    case "session.create": {
      if (!isString(raw.cwd)) return null;
      if (!isOptionalString(raw.sid)) return null;
      return {
        t: "session.create",
        cwd: raw.cwd,
        sid: raw.sid,
      } satisfies WsSessionCreate;
    }

    case "session.stop": {
      if (!isString(raw.sid)) return null;
      return { t: "session.stop", sid: raw.sid } satisfies WsSessionStop;
    }

    case "session.restart": {
      if (!isString(raw.sid)) return null;
      return { t: "session.restart", sid: raw.sid } satisfies WsSessionRestart;
    }

    case "session.export": {
      if (!isString(raw.sid)) return null;
      if (!isExportFormat(raw.format)) return null;
      if (!isRecordKindArray(raw.recordTypes)) return null;
      if (!isTimeRange(raw.timeRange)) return null;
      if (!isOptionalNumber(raw.limit)) return null;
      return {
        t: "session.export",
        sid: raw.sid,
        format: raw.format,
        recordTypes: raw.recordTypes,
        timeRange: raw.timeRange,
        limit: raw.limit,
      } satisfies WsSessionExport;
    }

    case "worktree.list":
      return { t: "worktree.list" } satisfies WsWorktreeList;

    case "worktree.create": {
      if (!isString(raw.branch)) return null;
      if (!isOptionalString(raw.baseBranch)) return null;
      if (!isOptionalString(raw.path)) return null;
      return {
        t: "worktree.create",
        branch: raw.branch,
        baseBranch: raw.baseBranch,
        path: raw.path,
      } satisfies WsWorktreeCreate;
    }

    case "worktree.remove": {
      if (!isString(raw.path)) return null;
      if (!isOptionalBoolean(raw.force)) return null;
      return {
        t: "worktree.remove",
        path: raw.path,
        force: raw.force,
      } satisfies WsWorktreeRemove;
    }

    default:
      return null;
  }
}
