/**
 * Boundary type guard for Client → Relay messages.
 *
 * The relay's `handleMessage` receives a raw WebSocket frame, `JSON.parse`s it,
 * and previously *asserted* the result was a `RelayClientMessage` with a bare
 * type cast — no runtime validation. That is a zero-trust hole: a hostile or
 * buggy peer can send `{"t":"relay.pub"}` with no `sid`/`ct`/`seq`, or a
 * `relay.auth` missing `token`, and every downstream handler would dereference
 * fields the type system swore were present. This guard narrows the parsed
 * value to a real `RelayClientMessage` variant, validating every field each
 * handler relies on, and returns `null` for anything malformed.
 *
 * Mirror of `parseRelayControlMessage` (relay-guard.ts), but for the
 * control-plane *between* client and relay rather than the daemon's decrypted
 * application control messages.
 */

import {
  isNonNegativeInt,
  isNumber,
  isObject,
  isOptionalNumber,
  isOptionalString,
  isPlatform,
  isRole,
  isString,
} from "./guard-primitives";
import type {
  PushInterruptionLevel,
  RelayAuth,
  RelayAuthResume,
  RelayClientMessage,
  RelayKeyExchange,
  RelayPing,
  RelayPublish,
  RelayPush,
  RelayPushRegister,
  RelayRegister,
  RelaySubscribe,
  RelayUnsubscribe,
} from "./types/relay";

/**
 * Maximum accepted length of a `relay.push.register` device token, per platform.
 * Bounds the value at the zero-trust boundary so an oversized token can't drive
 * a large `pushSealer.seal()` allocation before the relay even checks for a
 * connected daemon. Both bounds are generous headroom over the real wire shapes:
 *  - iOS (APNs): device tokens are a fixed 64 hex chars → 128 is 2× headroom.
 *  - Android (FCM): registration tokens are opaque and typically ~140–200 chars
 *    (and can be longer) → 1024 covers current and future FCM tokens with margin.
 * The `platform` field is validated before this is applied, so the bound is
 * chosen by the (trusted-shape) platform discriminant.
 */
const MAX_PUSH_TOKEN_LEN: Record<"ios" | "android", number> = {
  ios: 128,
  android: 1024,
};

/**
 * Validate the optional `data` navigation payload on a relay.push. When
 * present it must be an object with three string fields — push-notifier reads
 * `data.sid` / `data.daemonId` / `data.event` unconditionally.
 */
function isOptionalPushData(
  v: unknown,
): v is { sid: string; daemonId: string; event: string } | undefined {
  if (v === undefined) return true;
  if (!isObject(v)) return false;
  return isString(v["sid"]) && isString(v["daemonId"]) && isString(v["event"]);
}

/**
 * Validate the optional `interruptionLevel` on a relay.push. Absent is valid
 * (treated as "active" downstream). Only the two non-privileged levels we ever
 * emit are accepted; any other string (including the privileged "critical") is
 * rejected so a malicious/buggy peer can't smuggle an unintended APNs level
 * through the zero-trust boundary.
 */
function isOptionalInterruptionLevel(
  v: unknown,
): v is PushInterruptionLevel | undefined {
  return v === undefined || v === "active" || v === "time-sensitive";
}

/**
 * Parse a raw (JSON.parsed) client→relay frame into a typed discriminated
 * union. Returns `null` if the payload is not a recognized, well-formed
 * `RelayClientMessage`. The relay replies `relay.err`/`UNKNOWN_TYPE` on null
 * and never dispatches an under-validated frame to a handler.
 */
export function parseRelayClientMessage(
  raw: unknown,
): RelayClientMessage | null {
  if (!isObject(raw)) return null;
  const t = raw["t"];
  if (!isString(t)) return null;

  switch (t) {
    case "relay.auth": {
      if (!isRole(raw["role"])) return null;
      if (!isString(raw["daemonId"])) return null;
      if (!isString(raw["token"])) return null;
      if (!isNumber(raw["v"])) return null;
      if (!isOptionalString(raw["frontendId"])) return null;
      return {
        t: "relay.auth",
        role: raw["role"],
        daemonId: raw["daemonId"],
        token: raw["token"],
        v: raw["v"],
        frontendId: raw["frontendId"],
      } satisfies RelayAuth;
    }

    case "relay.auth.resume": {
      if (!isString(raw["token"])) return null;
      if (!isNumber(raw["v"])) return null;
      return {
        t: "relay.auth.resume",
        token: raw["token"],
        v: raw["v"],
      } satisfies RelayAuthResume;
    }

    case "relay.register": {
      if (!isString(raw["daemonId"])) return null;
      if (!isString(raw["proof"])) return null;
      if (!isString(raw["token"])) return null;
      if (!isNumber(raw["v"])) return null;
      return {
        t: "relay.register",
        daemonId: raw["daemonId"],
        proof: raw["proof"],
        token: raw["token"],
        v: raw["v"],
      } satisfies RelayRegister;
    }

    case "relay.kx": {
      if (!isString(raw["ct"])) return null;
      if (!isRole(raw["role"])) return null;
      return {
        t: "relay.kx",
        ct: raw["ct"],
        role: raw["role"],
      } satisfies RelayKeyExchange;
    }

    case "relay.pub": {
      if (!isString(raw["sid"])) return null;
      if (!isString(raw["ct"])) return null;
      if (!isNonNegativeInt(raw["seq"])) return null;
      return {
        t: "relay.pub",
        sid: raw["sid"],
        ct: raw["ct"],
        seq: raw["seq"],
      } satisfies RelayPublish;
    }

    case "relay.sub": {
      if (!isString(raw["sid"])) return null;
      // `after` is a subscription cursor (frame index) — non-negative integer or absent
      if (raw["after"] !== undefined && !isNonNegativeInt(raw["after"]))
        return null;
      return {
        t: "relay.sub",
        sid: raw["sid"],
        after: raw["after"] as number | undefined,
      } satisfies RelaySubscribe;
    }

    case "relay.unsub": {
      if (!isString(raw["sid"])) return null;
      return { t: "relay.unsub", sid: raw["sid"] } satisfies RelayUnsubscribe;
    }

    case "relay.ping": {
      if (!isOptionalNumber(raw["ts"])) return null;
      return { t: "relay.ping", ts: raw["ts"] } satisfies RelayPing;
    }

    case "relay.push": {
      if (!isString(raw["frontendId"])) return null;
      // `sealed` is now required — the legacy plaintext `token` field has been
      // removed. Any frame arriving without a `sealed` string is rejected at
      // the zero-trust boundary.
      if (!isString(raw["sealed"])) return null;
      if (!isString(raw["title"])) return null;
      if (!isString(raw["body"])) return null;
      if (!isOptionalInterruptionLevel(raw["interruptionLevel"])) return null;
      if (!isOptionalPushData(raw["data"])) return null;
      return {
        t: "relay.push",
        frontendId: raw["frontendId"],
        sealed: raw["sealed"],
        title: raw["title"],
        body: raw["body"],
        interruptionLevel: raw["interruptionLevel"],
        data: raw["data"],
      } satisfies RelayPush;
    }

    case "relay.push.register": {
      if (!isString(raw["frontendId"])) return null;
      if (!isPlatform(raw["platform"])) return null;
      // Cap the token length at the zero-trust boundary so an oversized value
      // can't force a large pushSealer.seal()/alloc before any daemon-presence
      // check. The bound is platform-aware: APNs (ios) tokens are 64 hex chars,
      // but FCM (android) tokens are opaque and far longer (~140–200+ chars).
      if (
        !isString(raw["token"]) ||
        raw["token"].length > MAX_PUSH_TOKEN_LEN[raw["platform"]]
      ) {
        return null;
      }
      return {
        t: "relay.push.register",
        frontendId: raw["frontendId"],
        token: raw["token"],
        platform: raw["platform"],
      } satisfies RelayPushRegister;
    }

    default:
      return null;
  }
}
