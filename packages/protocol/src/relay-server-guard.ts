/**
 * Boundary type guard for Relay → Client messages.
 *
 * Both RelayClients — the daemon's (`packages/daemon/src/transport/relay-client.ts`)
 * and the frontend's (`apps/app/src/lib/relay-client.ts`) — receive a raw
 * WebSocket frame, `JSON.parse` it, and previously *asserted* the result was a
 * `RelayServerMessage` with a bare cast (`JSON.parse(event.data) as
 * RelayServerMessage`) before switching on `.t`. That is the outermost
 * zero-trust hole on the inbound path: a hostile or buggy relay (or a
 * man-in-the-middle that cannot read ciphertext but can inject frames) could
 * send a `relay.frame` with no `ct`/`seq`/`from`, a `relay.presence` with a
 * non-array `sessions`, or an unknown discriminant the switch silently drops.
 *
 * This guard narrows the parsed value to a real `RelayServerMessage` variant,
 * validating every field the handlers rely on, and returns `null` for anything
 * malformed. Symmetric counterpart to `parseRelayClientMessage`
 * (relay-client-guard.ts), which guards the *client → relay* direction.
 *
 * Exported from both `index.ts` (daemon) and `client.ts` (frontend) since both
 * call sites need it.
 */

import {
  isNonNegativeInt,
  isNumber,
  isObject,
  isOptionalBoolean,
  isOptionalNumber,
  isOptionalString,
  isPlatform,
  isRole,
  isString,
  isStringArray,
} from "./guard-primitives";
import type {
  RelayAuthErr,
  RelayAuthOk,
  RelayError,
  RelayFrame,
  RelayKeyExchangeFrame,
  RelayNotification,
  RelayPong,
  RelayPresence,
  RelayPushTokenSealed,
  RelayRegisterErr,
  RelayRegisterOk,
  RelayServerMessage,
} from "./types/relay";

/**
 * Validate the optional `data` navigation payload shared by relay.notification.
 * When present it must be an object with three string fields — the notification
 * handler reads `data.sid` / `data.daemonId` / `data.event`.
 */
function isOptionalNotifData(
  v: unknown,
): v is { sid: string; daemonId: string; event: string } | undefined {
  if (v === undefined) return true;
  if (!isObject(v)) return false;
  return isString(v["sid"]) && isString(v["daemonId"]) && isString(v["event"]);
}

/**
 * Parse a raw (JSON.parsed) relay→client frame into a typed discriminated
 * union. Returns `null` if the payload is not a recognized, well-formed
 * `RelayServerMessage`. Callers drop the frame on null and never dispatch an
 * under-validated frame into their switch.
 */
export function parseRelayServerMessage(
  raw: unknown,
): RelayServerMessage | null {
  if (!isObject(raw)) return null;
  const t = raw["t"];
  if (!isString(t)) return null;

  switch (t) {
    case "relay.auth.ok": {
      if (!isString(raw["daemonId"])) return null;
      if (!isOptionalString(raw["resumeToken"])) return null;
      if (!isOptionalNumber(raw["resumeExpiresAt"])) return null;
      if (!isOptionalBoolean(raw["resumed"])) return null;
      // H2: when resumed===true the client skips kx rebroadcast (trusting that
      // the prior sessionKeys are still valid). That optimization is only safe
      // when the relay also issues a fresh token for the *next* reconnect.
      // A well-formed relay always includes both resumeToken and resumeExpiresAt
      // in a resumed response; without them the client would lose the ability to
      // resume on the following disconnect. Treat the missing-token case as a
      // protocol violation and reject the message so the caller falls back to a
      // full register+auth cycle rather than silently operating degraded.
      if (raw["resumed"] === true) {
        if (!isString(raw["resumeToken"])) return null;
        if (!isNumber(raw["resumeExpiresAt"])) return null;
      }
      return {
        t: "relay.auth.ok",
        daemonId: raw["daemonId"],
        resumeToken: raw["resumeToken"],
        resumeExpiresAt: raw["resumeExpiresAt"],
        resumed: raw["resumed"],
      } satisfies RelayAuthOk;
    }

    case "relay.auth.err": {
      if (!isString(raw["e"])) return null;
      return { t: "relay.auth.err", e: raw["e"] } satisfies RelayAuthErr;
    }

    case "relay.register.ok": {
      if (!isString(raw["daemonId"])) return null;
      return {
        t: "relay.register.ok",
        daemonId: raw["daemonId"],
      } satisfies RelayRegisterOk;
    }

    case "relay.register.err": {
      if (!isString(raw["e"])) return null;
      return {
        t: "relay.register.err",
        e: raw["e"],
      } satisfies RelayRegisterErr;
    }

    case "relay.frame": {
      if (!isString(raw["sid"])) return null;
      if (!isString(raw["ct"])) return null;
      if (!isNonNegativeInt(raw["seq"])) return null;
      if (!isRole(raw["from"])) return null;
      if (!isOptionalString(raw["frontendId"])) return null;
      return {
        t: "relay.frame",
        sid: raw["sid"],
        ct: raw["ct"],
        seq: raw["seq"],
        from: raw["from"],
        frontendId: raw["frontendId"],
      } satisfies RelayFrame;
    }

    case "relay.kx.frame": {
      if (!isString(raw["ct"])) return null;
      if (!isRole(raw["from"])) return null;
      return {
        t: "relay.kx.frame",
        ct: raw["ct"],
        from: raw["from"],
      } satisfies RelayKeyExchangeFrame;
    }

    case "relay.presence": {
      if (!isString(raw["daemonId"])) return null;
      if (typeof raw["online"] !== "boolean") return null;
      if (!isStringArray(raw["sessions"])) return null;
      if (!isNumber(raw["lastSeen"])) return null;
      return {
        t: "relay.presence",
        daemonId: raw["daemonId"],
        online: raw["online"],
        sessions: raw["sessions"],
        lastSeen: raw["lastSeen"],
      } satisfies RelayPresence;
    }

    case "relay.pong": {
      if (!isOptionalNumber(raw["ts"])) return null;
      return { t: "relay.pong", ts: raw["ts"] } satisfies RelayPong;
    }

    case "relay.err": {
      if (!isString(raw["e"])) return null;
      if (!isOptionalString(raw["m"])) return null;
      return { t: "relay.err", e: raw["e"], m: raw["m"] } satisfies RelayError;
    }

    case "relay.notification": {
      if (!isString(raw["title"])) return null;
      if (!isString(raw["body"])) return null;
      if (!isOptionalNotifData(raw["data"])) return null;
      return {
        t: "relay.notification",
        title: raw["title"],
        body: raw["body"],
        data: raw["data"],
      } satisfies RelayNotification;
    }

    case "relay.push.token": {
      if (!isString(raw["frontendId"])) return null;
      if (!isString(raw["sealed"])) return null;
      if (!isPlatform(raw["platform"])) return null;
      return {
        t: "relay.push.token",
        frontendId: raw["frontendId"],
        sealed: raw["sealed"],
        platform: raw["platform"],
      } satisfies RelayPushTokenSealed;
    }

    default:
      return null;
  }
}
