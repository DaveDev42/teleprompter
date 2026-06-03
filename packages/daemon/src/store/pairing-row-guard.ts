/**
 * Boundary type guard for pairing rows read back out of SQLite.
 *
 * `Store.loadPairings()` previously cast `SELECT * FROM pairings` rows straight
 * to a typed shape and handed the three BLOB columns (`public_key`,
 * `secret_key`, `pairing_secret`) to libsodium via
 * `new Uint8Array(row.public_key)` with no validation. A truncated, NULL, or
 * wrong-length BLOB — from a crash mid-write, DB corruption, or a tampered
 * store file — would then flow into key construction:
 *
 *  - a bad `pairing_secret` survives `deriveKxKey` (BLAKE2b is length-tolerant)
 *    and silently produces a bogus kx envelope key — wrong, but no crash;
 *  - a wrong-length `public_key`/`secret_key` makes
 *    `crypto_kx_server_session_keys` throw deep inside the wasm binding, killing
 *    the whole reconnect with no useful context.
 *
 * This guard narrows one raw row to a typed `StoredPairing` (or `null`),
 * enforcing that every key column is a `Uint8Array` of exactly
 * `PAIRING_KEY_BYTES` (32 — X25519 key size, also the pairing-secret size; see
 * `packages/protocol/src/pairing.ts` and `crypto.ts`) and that the string
 * columns are non-empty. It is the SQLite sibling of the wire guards
 * (`parseIpcMessage`, `parseControlMessage`, `parseHookEvent`): validate at the
 * boundary where untrusted bytes cross into typed key objects, reconstruct
 * field-by-field, return `null` on anything malformed.
 *
 * A corrupt row is filtered out (logged + skipped by the caller) rather than
 * thrown — a single bad pairing must not block every other pairing from
 * reconnecting at daemon startup.
 */

import { decodeWireLabel, type Label } from "@teleprompter/protocol";

/**
 * Byte length every pairing key column must have. X25519 public and secret keys
 * are 32 bytes (`crypto_kx_PUBLICKEYBYTES` / `crypto_kx_SECRETKEYBYTES`), and
 * the pairing secret is a 32-byte random value (`generatePairingSecret`). The
 * literal `32` is asserted at the QR-decode boundary in `pairing.ts` too.
 */
export const PAIRING_KEY_BYTES = 32;

export interface StoredPairing {
  daemonId: string;
  relayUrl: string;
  relayToken: string;
  registrationProof: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  pairingSecret: Uint8Array;
  label: Label;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Narrow a raw BLOB column to a `Uint8Array` of exactly `len` bytes. Bun's
 * SQLite driver hands back a `Buffer` for BLOB columns (a `Uint8Array`
 * subclass), so the `instanceof Uint8Array` check accepts it; a NULL column
 * arrives as `null` and is rejected, as is any short/long byte run.
 */
function toKeyBytes(value: unknown, len: number): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  if (value.byteLength !== len) return null;
  // Re-wrap into a plain Uint8Array so callers never observe a Buffer subclass
  // (and any over-allocated Buffer pool slack cannot leak via .buffer).
  return new Uint8Array(value);
}

/**
 * Validate one raw row from the `pairings` table. Returns a typed
 * `StoredPairing` or `null` if any required field is missing, the wrong type,
 * or a key column is not exactly `PAIRING_KEY_BYTES` bytes.
 */
export function parseStoredPairing(raw: unknown): StoredPairing | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;

  if (!isNonEmptyString(r.daemon_id)) return null;
  if (!isNonEmptyString(r.relay_url)) return null;
  if (!isNonEmptyString(r.relay_token)) return null;
  if (!isNonEmptyString(r.registration_proof)) return null;
  if (!isFiniteNumber(r.created_at)) return null;

  const publicKey = toKeyBytes(r.public_key, PAIRING_KEY_BYTES);
  if (!publicKey) return null;
  const secretKey = toKeyBytes(r.secret_key, PAIRING_KEY_BYTES);
  if (!secretKey) return null;
  const pairingSecret = toKeyBytes(r.pairing_secret, PAIRING_KEY_BYTES);
  if (!pairingSecret) return null;

  // `label` is the only nullable column; `decodeWireLabel` normalizes NULL and
  // a legacy "" both to `{ set: false }`, and accepts any string otherwise.
  const labelRaw = r.label;
  const label: Label = decodeWireLabel(
    typeof labelRaw === "string" ? labelRaw : null,
  );

  return {
    daemonId: r.daemon_id,
    relayUrl: r.relay_url,
    relayToken: r.relay_token,
    registrationProof: r.registration_proof,
    publicKey,
    secretKey,
    pairingSecret,
    label,
  } satisfies StoredPairing;
}
