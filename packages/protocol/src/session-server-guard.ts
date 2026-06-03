/**
 * Boundary type guard for the daemon → frontend session-data plane.
 *
 * After the frontend's RelayClient decrypts a `relay.frame` with its
 * per-session key, the resulting JSON is still untyped. The receive switch in
 * `handleFrame` previously cast that value to `any` and dereferenced
 * `msg.d.sessions`, `msg.seq`, `msg.d` (as arrays), `msg.format`, etc. with no
 * validation — a daemon on a mismatched protocol version, a truncated payload
 * that happens to decrypt, or a future record shape would crash deep inside an
 * event handler with a cryptic `Cannot read properties of undefined` instead of
 * being dropped cleanly at the boundary.
 *
 * This guard narrows the parsed value to a `SessionServerMessage` discriminated
 * union, validating every field the frontend handlers rely on, and returns
 * `null` for anything malformed. It is the daemon→frontend mirror of
 * `parseRelayControlMessage` (relay-guard.ts, frontend→daemon) and a sibling of
 * `parseRelayServerMessage` (relay-server-guard.ts, relay→client transport).
 *
 * Scope: only the session-DATA union (`SessionServerMessage`). The two
 * peer-to-peer control messages that ride the same decrypted channel
 * (`control.unpair` / `control.rename`) are guarded separately by
 * `parseControlMessage` (control-guard.ts) — the caller tries that guard first
 * on the control sid, then falls back to this one.
 */

import type { Label } from "./types/label";
import type { RecordKind } from "./types/record";
import { isSessionState } from "./types/session";
import type {
  SessionBatch,
  SessionErr,
  SessionExported,
  SessionHelloReply,
  SessionMeta,
  SessionPong,
  SessionRec,
  SessionServerMessage,
  SessionStateMsg,
  SessionWorktreeCreated,
  SessionWorktreeInfo,
  SessionWorktreeListReply,
  SessionWorktreeRemoved,
} from "./types/session-proto";

type PlainObject = { [key: string]: unknown };

function isObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

const RECORD_KINDS = new Set<RecordKind>(["io", "event", "meta"]);

function isRecordKind(v: unknown): v is RecordKind {
  return typeof v === "string" && RECORD_KINDS.has(v as RecordKind);
}

function isNamespace(v: unknown): v is SessionRec["ns"] {
  return v === "claude" || v === "tp" || v === "runner" || v === "daemon";
}

function isExportFormat(v: unknown): v is "json" | "markdown" {
  return v === "json" || v === "markdown";
}

/**
 * Validate a `SessionMeta` object (carried by `hello`, `state`). Every field a
 * Sessions-list row or session header reads must be present and well-typed —
 * `state` is narrowed to the `SessionState` union (not just any string) so a
 * corrupt/legacy value can't slip into UI that switches on it.
 */
function isSessionMeta(v: unknown): v is SessionMeta {
  if (!isObject(v)) return false;
  if (!isString(v.sid)) return false;
  if (!isSessionState(v.state)) return false;
  if (!isString(v.cwd)) return false;
  if (!isOptionalString(v.worktreePath)) return false;
  if (!isOptionalString(v.claudeVersion)) return false;
  if (!isNumber(v.createdAt)) return false;
  if (!isNumber(v.updatedAt)) return false;
  if (!isNumber(v.lastSeq)) return false;
  return true;
}

/**
 * Validate a single `SessionRec` (an element of a `batch`, or a standalone
 * `rec`). `k` (RecordKind) and the optional `ns` (Namespace) are narrowed to
 * their literal unions; `d` is the base64 payload string.
 */
function isSessionRec(v: unknown): v is SessionRec {
  if (!isObject(v)) return false;
  if (v.t !== "rec") return false;
  if (!isString(v.sid)) return false;
  if (!isNumber(v.seq)) return false;
  if (!isRecordKind(v.k)) return false;
  if (v.ns !== undefined && !isNamespace(v.ns)) return false;
  if (!isOptionalString(v.n)) return false;
  if (!isString(v.d)) return false;
  if (!isNumber(v.ts)) return false;
  return true;
}

function isSessionRecArray(v: unknown): v is SessionRec[] {
  return Array.isArray(v) && v.every(isSessionRec);
}

/**
 * Validate a `SessionWorktreeInfo` (carried by `worktree.list` /
 * `worktree.created`). All four fields flow into the worktree UI.
 */
function isWorktreeInfo(v: unknown): v is SessionWorktreeInfo {
  if (!isObject(v)) return false;
  if (!isString(v.path)) return false;
  if (!isString(v.branch)) return false;
  if (!isString(v.head)) return false;
  if (!isBoolean(v.isMain)) return false;
  return true;
}

function isWorktreeInfoArray(v: unknown): v is SessionWorktreeInfo[] {
  return Array.isArray(v) && v.every(isWorktreeInfo);
}

/**
 * Parse a raw (decrypted + JSON.parsed) daemon→frontend frame into a typed
 * `SessionServerMessage`. Returns `null` for any unrecognized discriminant or
 * malformed payload — the caller drops the frame (and logs) rather than acting
 * on an under-validated record/state/worktree event.
 */
export function parseSessionServerMessage(
  raw: unknown,
): SessionServerMessage | null {
  if (!isObject(raw)) return null;
  const t = raw.t;
  if (!isString(t)) return null;

  switch (t) {
    case "hello": {
      if (!isNumber(raw.v)) return null;
      if (!isObject(raw.d)) return null;
      if (!Array.isArray(raw.d.sessions)) return null;
      if (!raw.d.sessions.every(isSessionMeta)) return null;
      // `daemonLabel` is a keep-current label surface decoded forgivingly at
      // the call site (`decodeKxLabelOrKeep`): a legacy daemon sends a bare
      // `string`, a v2 daemon the `Label` union, an old daemon nothing at all.
      // We deliberately do NOT gate validity on it (that would reject an older
      // peer's string), so it rides through as-is and the reader normalizes the
      // shape. The single targeted cast is the field where the typed `Label`
      // and the legacy wire string diverge.
      return {
        t: "hello",
        v: raw.v,
        d: {
          sessions: raw.d.sessions,
          ...(raw.d.daemonLabel !== undefined
            ? { daemonLabel: raw.d.daemonLabel as Label }
            : {}),
        },
      } satisfies SessionHelloReply;
    }

    case "state": {
      if (!isString(raw.sid)) return null;
      if (!isSessionMeta(raw.d)) return null;
      return {
        t: "state",
        sid: raw.sid,
        d: raw.d,
      } satisfies SessionStateMsg;
    }

    case "rec": {
      if (!isSessionRec(raw)) return null;
      return raw;
    }

    case "batch": {
      if (!isString(raw.sid)) return null;
      if (!isSessionRecArray(raw.d)) return null;
      return {
        t: "batch",
        sid: raw.sid,
        d: raw.d,
      } satisfies SessionBatch;
    }

    case "pong":
      return { t: "pong" } satisfies SessionPong;

    case "err": {
      if (!isString(raw.e)) return null;
      if (!isOptionalString(raw.m)) return null;
      return {
        t: "err",
        e: raw.e,
        ...(raw.m !== undefined ? { m: raw.m } : {}),
      } satisfies SessionErr;
    }

    case "worktree.list": {
      if (!isWorktreeInfoArray(raw.d)) return null;
      return {
        t: "worktree.list",
        d: raw.d,
      } satisfies SessionWorktreeListReply;
    }

    case "worktree.created": {
      if (!isWorktreeInfo(raw.d)) return null;
      if (!isOptionalString(raw.sid)) return null;
      return {
        t: "worktree.created",
        d: raw.d,
        ...(raw.sid !== undefined ? { sid: raw.sid } : {}),
      } satisfies SessionWorktreeCreated;
    }

    case "worktree.removed": {
      if (!isString(raw.path)) return null;
      return {
        t: "worktree.removed",
        path: raw.path,
      } satisfies SessionWorktreeRemoved;
    }

    case "session.exported": {
      if (!isString(raw.sid)) return null;
      if (!isExportFormat(raw.format)) return null;
      if (!isString(raw.d)) return null;
      return {
        t: "session.exported",
        sid: raw.sid,
        format: raw.format,
        d: raw.d,
      } satisfies SessionExported;
    }

    default:
      return null;
  }
}
