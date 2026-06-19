/**
 * Boundary type guard for decrypted E2EE control-plane messages.
 *
 * Frames that arrive on the RELAY_CHANNEL_CONTROL virtual session are opaque
 * ciphertext to the relay. After the daemon (or frontend) decrypts them, the
 * resulting JSON is still untyped — and these particular messages are the most
 * dangerous unguarded surface in the system: a `control.unpair` reaches the
 * pairing-removal path and a `control.rename` reaches the label-update path. A
 * malformed (or hostile-shaped) frame previously rode straight through a bare
 * `as ControlUnpair` / `as ControlRename` cast into those handlers with no
 * field validation.
 *
 * This guard narrows the parsed value to a real `ControlMessage` variant,
 * validating every field the handlers rely on, and returns `null` for anything
 * malformed. Mirror of `parseRelayControlMessage` (relay-guard.ts) and
 * `parseRelayClientMessage` (relay-client-guard.ts), but for the decrypted
 * peer-to-peer control union rather than the relay or session control planes.
 *
 * The `label` field on a rename is accepted in either wire shape (legacy
 * `string` / `""`, or the new `Label` union) and normalized via
 * `decodeWireLabel` — the same forgiving read the call site already performs —
 * so cross-version peers continue to interoperate. Only the *structural*
 * fields (`frontendId`, `daemonId`, `reason`, `ts`) are strictly validated.
 */

import { isNumber, isObject, isString } from "./guard-primitives";
import type {
  ControlMessage,
  ControlRename,
  ControlUnpair,
} from "./types/control";
import { CONTROL_RENAME, CONTROL_UNPAIR } from "./types/control";
import { decodeWireLabel } from "./types/label";

function isUnpairReason(v: unknown): v is ControlUnpair["reason"] {
  return v === "user-initiated" || v === "device-removed" || v === "rotated";
}

/**
 * Parse a raw (decrypted + JSON.parsed) control frame into a typed
 * `ControlMessage`. Returns `null` for any unrecognized discriminant or
 * malformed payload — the caller drops the frame (and logs) rather than acting
 * on an under-validated unpair/rename.
 */
export function parseControlMessage(raw: unknown): ControlMessage | null {
  if (!isObject(raw)) return null;
  const t = raw.t;
  if (!isString(t)) return null;

  switch (t) {
    case CONTROL_UNPAIR: {
      if (!isString(raw.daemonId)) return null;
      if (!isString(raw.frontendId)) return null;
      if (!isUnpairReason(raw.reason)) return null;
      if (!isNumber(raw.ts)) return null;
      return {
        t: CONTROL_UNPAIR,
        daemonId: raw.daemonId,
        frontendId: raw.frontendId,
        reason: raw.reason,
        ts: raw.ts,
      } satisfies ControlUnpair;
    }

    case CONTROL_RENAME: {
      if (!isString(raw.daemonId)) return null;
      if (!isString(raw.frontendId)) return null;
      if (!isNumber(raw.ts)) return null;
      // `label` may arrive as a legacy `string` (`""` = clear) or the new
      // `Label` union — `decodeWireLabel` normalizes both. The field is never
      // strictly type-asserted here precisely so an old peer's string still
      // parses; only the structural fields above gate validity.
      return {
        t: CONTROL_RENAME,
        daemonId: raw.daemonId,
        frontendId: raw.frontendId,
        label: decodeWireLabel(raw.label),
        ts: raw.ts,
      } satisfies ControlRename;
    }

    default:
      return null;
  }
}
