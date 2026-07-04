/**
 * QR pairing data structure and serialization.
 *
 * The QR code contains:
 *  - pairing secret (32 bytes)
 *  - daemon public key (32 bytes)
 *  - relay URL (string)
 *  - daemon ID (string)
 *  - protocol version
 *
 * Label is **not** in the QR — daemons broadcast it to the frontend during
 * `relay.kx` (see `RelayClient.broadcastDaemonPublicKey`). Keeping label out
 * of the QR shaves the typical pairing URL by ~20 base64url chars and lets
 * users rename their daemon without re-pairing.
 *
 * Wire format: `tp://p?d=<base64url(binary)>`
 * The deep-link form lets the iPhone system camera open the app directly.
 * Short scheme + path keeps the prefix at 9 chars so module count stays low.
 */

import {
  deriveRegistrationProof,
  deriveRelayToken,
  ensureSodium,
  formatUuid,
  fromBase64,
  generateKeyPair,
  generatePairingSecret,
  type KeyPair,
  toBase64,
} from "./crypto";

const PAIRING_URL_SCHEME = "tp://p";
const PAIRING_BINARY_MAGIC = "tp"; // 2 bytes
/**
 * v2: original layout including a trailing `label_len(1) | label_bytes`. The
 *     did was stored verbatim (`daemon-…` prefix included).
 * v3: drops the label suffix entirely (label is delivered via `relay.kx`) and
 *     strips the `daemon-` prefix from the did. Decoder reattaches the prefix.
 * v4: additive over v3 — appends `pairing_id(16 raw UUID)` then
 *     `hostname_len(1) | hostname_bytes` after `pk(32)`. Carries the pairing's
 *     stable id and the daemon's display hostname in the QR (PCT redesign).
 *
 * The encoder always emits v4. The decoder accepts v2/v3/v4 — v2 reads a
 * trailing label and treats the did as already-prefixed; v3 stops at `pk` and
 * reattaches the prefix; v4 reads pairingId + hostname (empty for v2/v3).
 * Byte-exact with `rust/tp-core/src/pairing.rs`.
 */
const PAIRING_BINARY_VERSION = 4;
/**
 * Upper bound on the base64url pairing payload accepted by the decoder. A
 * legitimate v2/v3 bundle is ~772 chars; 2048 is far above any real payload
 * and bounds attacker-controlled allocation before `base64UrlToBytes` runs.
 * Mirrors `MAX_PAIRING_B64_LEN` in the live native decoder
 * (`rust/tp-core/src/pairing.rs`).
 */
const MAX_PAIRING_B64_LEN = 2048;
/**
 * Production relay URL. When the QR encodes this exact URL, the binary form
 * stores `relay_len = 0` to save ~22 bytes (`wss://relay.tpmt.dev`). Decoder
 * treats `relay_len = 0` as "use the default relay". Self-hosted relays still
 * encode the full URL inline and round-trip verbatim.
 */
export const DEFAULT_PAIRING_RELAY_URL = "wss://relay.tpmt.dev";

/**
 * The daemon ID generator (`pairing-orchestrator.ts`) always prefixes IDs
 * with `daemon-`. Storing those 7 bytes in every QR is wasted space — the
 * encoder strips the prefix before serialization and the decoder restores
 * it. The encoder enforces the prefix invariant by throwing for any id that
 * doesn't carry it.
 */
const DAEMON_ID_PREFIX = "daemon-";

export interface PairingData {
  /** Pairing secret (base64, 32 bytes) */
  ps: string;
  /** Daemon public key (base64, 32 bytes) */
  pk: string;
  /** Relay endpoint URL */
  relay: string;
  /** Daemon ID */
  did: string;
  /** Protocol version */
  v: number;
  /**
   * Pairing id — canonical UUID string. Present from v4; empty for decoded
   * v2/v3 bundles (the caller derives a legacy id from `did`).
   */
  pairingId: string;
  /** Daemon hostname (display label). Present from v4; empty for v2/v3. */
  hostname: string;
}

export interface PairingBundle {
  /** Data to encode in the QR code */
  qrData: PairingData;
  /** Daemon key pair (keep secret key safe!) */
  keyPair: KeyPair;
  /** Raw pairing secret */
  pairingSecret: Uint8Array;
  /** Derived relay auth token */
  relayToken: string;
  /** Registration proof for relay self-registration */
  registrationProof: string;
}

/**
 * Generate everything needed for a new pairing QR code.
 *
 * `label` is intentionally not part of the QR — it is delivered to the
 * frontend in-band via `relay.kx`. The argument is accepted (and ignored
 * for QR purposes) for compatibility with the daemon's pairing setup which
 * still threads it through to the RelayClient config.
 *
 * `pairingId` is the stable canonical UUID for this pairing (carried in the QR
 * v4 payload and used for PCT derivation). The daemon owns pairing-id
 * generation (`tp pair new` → random UUID) and passes it explicitly; when
 * omitted a fresh random UUID is generated here so the bundle is always a valid
 * v4 QR. `hostname` is the daemon's display label (empty when unknown). Callers
 * read the resolved values back from `bundle.qrData.pairingId` / `.hostname`.
 */
export async function createPairingBundle(
  relayUrl: string,
  daemonId: string,
  opts?: {
    label?: string | undefined;
    pairingId?: string | undefined;
    hostname?: string | undefined;
  },
): Promise<PairingBundle> {
  const p = await ensureSodium();
  const keyPair = await generateKeyPair();
  const pairingSecret = await generatePairingSecret();
  const relayToken = await deriveRelayToken(pairingSecret);
  const registrationProof = await deriveRegistrationProof(pairingSecret);
  // The daemon supplies a stable UUID; fall back to a fresh random UUID so a
  // caller that omits it still emits a structurally valid v4 QR.
  const pairingId = opts?.pairingId ?? formatUuid(p.randomBytes(16));

  const qrData: PairingData = {
    ps: await toBase64(pairingSecret),
    pk: await toBase64(keyPair.publicKey),
    relay: relayUrl,
    did: daemonId,
    v: PAIRING_BINARY_VERSION,
    pairingId,
    hostname: opts?.hostname ?? "",
  };

  return { qrData, keyPair, pairingSecret, relayToken, registrationProof };
}

/**
 * Normalize a relay URL for default-detection only. Strict equality on the
 * raw input would silently fall back to inline encoding for trivial variants
 * like a trailing slash or accidental whitespace. We do not mutate the
 * outgoing `data.relay` — the round-trip still preserves whatever the daemon
 * generated, this is purely the comparison key for "is this the default?".
 */
function normalizeRelayForDefaultMatch(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

const NORMALIZED_DEFAULT_RELAY = normalizeRelayForDefaultMatch(
  DEFAULT_PAIRING_RELAY_URL,
);

/**
 * Parse a canonical UUID string (`8-4-4-4-12`, hyphens optional) into 16 raw
 * bytes. Accepts upper/lowercase hex; rejects any other shape. Byte-exact twin
 * of the Rust `parse_uuid_16`.
 *
 * Exported so the daemon can convert a stored canonical `pairing_id` back to the
 * 16 raw bytes `derivePairingConfirmationTag` requires (it takes `pairingId:
 * Uint8Array`, not a string).
 */
export function parseUuid16(s: string): Uint8Array {
  const hexOnly = s.replace(/-/g, "");
  if (hexOnly.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hexOnly)) {
    throw new Error("pairing id must be a 16-byte UUID");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hexOnly.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Serialize pairing data to a QR-friendly deep-link string.
 *
 * Output: `tp://p?d=<base64url(binary)>`
 *
 * Binary layout (v4 — additive over v3):
 *   magic(2) | version(1)=4 |
 *   did_len(1) | did_bytes (with `daemon-` prefix stripped) |
 *   relay_len(1) | relay_bytes |
 *   ps(32) | pk(32) |
 *   pairing_id(16 raw UUID bytes) |
 *   hostname_len(1) | hostname_bytes
 *
 * `did`/`relay`/`hostname` are utf-8 encoded, each capped at 255 bytes.
 *
 * `relay_len = 0` is the wire signal for "default relay" — see
 * `DEFAULT_PAIRING_RELAY_URL`. Saves ~22 bytes on the most common case
 * (production relay) and shaves a noticeable chunk off the QR module count.
 *
 * The encoder strips the canonical `daemon-` prefix from did and the decoder
 * reattaches it, saving 7 bytes per QR without changing the in-memory or
 * stored representation. Byte-exact with `rust/tp-core/src/pairing.rs`.
 */
export function encodePairingData(data: PairingData): string {
  const enc = new TextEncoder();
  // The daemon ID generator always prefixes with `daemon-`. Encode the
  // suffix only — decoder reattaches the prefix. We enforce the invariant
  // here rather than silently encoding raw IDs to keep the wire format
  // unambiguous: every decoded did is prefix + suffix.
  if (!data.did.startsWith(DAEMON_ID_PREFIX)) {
    throw new Error(`daemon id must start with "${DAEMON_ID_PREFIX}"`);
  }
  const wireDid = data.did.slice(DAEMON_ID_PREFIX.length);
  const did = enc.encode(wireDid);
  const useDefaultRelay =
    normalizeRelayForDefaultMatch(data.relay) === NORMALIZED_DEFAULT_RELAY;
  const relay = useDefaultRelay ? new Uint8Array(0) : enc.encode(data.relay);
  const ps = base64ToBytes(data.ps);
  const pk = base64ToBytes(data.pk);
  const pairingId = parseUuid16(data.pairingId);
  const hostname = enc.encode(data.hostname);

  if (did.length === 0) {
    throw new Error("daemon id suffix must not be empty");
  }
  if (did.length > 255) throw new Error("daemon id exceeds 255 bytes");
  if (relay.length > 255) throw new Error("relay url exceeds 255 bytes");
  if (hostname.length > 255) throw new Error("hostname exceeds 255 bytes");
  if (ps.length !== 32) throw new Error("pairing secret must be 32 bytes");
  if (pk.length !== 32) throw new Error("daemon public key must be 32 bytes");

  const totalLen =
    2 +
    1 +
    1 +
    did.length +
    1 +
    relay.length +
    32 +
    32 +
    16 +
    1 +
    hostname.length;
  const buf = new Uint8Array(totalLen);
  let o = 0;
  buf.set(enc.encode(PAIRING_BINARY_MAGIC), o);
  o += 2;
  buf[o++] = PAIRING_BINARY_VERSION;
  buf[o++] = did.length;
  buf.set(did, o);
  o += did.length;
  buf[o++] = relay.length;
  buf.set(relay, o);
  o += relay.length;
  buf.set(ps, o);
  o += 32;
  buf.set(pk, o);
  o += 32;
  buf.set(pairingId, o);
  o += 16;
  buf[o++] = hostname.length;
  buf.set(hostname, o);

  return `${PAIRING_URL_SCHEME}?d=${bytesToBase64Url(buf)}`;
}

/**
 * Parse pairing data from a `tp://p?d=<base64url>` deep link.
 */
export function decodePairingData(raw: string): PairingData {
  // Strip ASCII whitespace and a UTF-8 BOM (some clipboards prepend a BOM
  // that survives copy/paste through iOS).
  const trimmed = raw.trim().replace(/^\uFEFF/, "");
  if (!trimmed.startsWith(PAIRING_URL_SCHEME)) {
    throw new Error("Invalid pairing data format");
  }

  const queryIdx = trimmed.indexOf("?");
  if (queryIdx < 0) throw new Error("Invalid pairing data format");
  const params = new URLSearchParams(trimmed.slice(queryIdx + 1));
  const d = params.get("d");
  if (!d) throw new Error("Invalid pairing data format");
  return decodeBinaryPairing(d);
}

function decodeBinaryPairing(b64: string): PairingData {
  // Reject oversized input before allocating the decoded buffer. Mirrors the
  // native decoder's pre-cap (rust/tp-core/src/pairing.rs) so both decoders
  // bound attacker-controlled allocation identically.
  if (b64.length > MAX_PAIRING_B64_LEN) {
    throw new Error("Invalid pairing data format");
  }
  let buf: Uint8Array;
  try {
    buf = base64UrlToBytes(b64);
  } catch {
    throw new Error("Invalid pairing data format");
  }
  if (buf.length < 2 + 1 + 1 + 1 + 32 + 32) {
    throw new Error("Invalid pairing data format");
  }

  // `fatal: true` rejects invalid UTF-8 (vs. the default lenient decoder, which
  // substitutes U+FFFD). Matches the native decoder's strict `str::from_utf8`
  // (rust/tp-core/src/pairing.rs) so both reject the same malformed payloads.
  // `decodeUtf8` normalizes the resulting TypeError into the standard error.
  const dec = new TextDecoder("utf-8", { fatal: true });
  const decodeUtf8 = (bytes: Uint8Array): string => {
    try {
      return dec.decode(bytes);
    } catch {
      throw new Error("Invalid pairing data format");
    }
  };
  let o = 0;
  const magic = decodeUtf8(buf.subarray(o, o + 2));
  o += 2;
  if (magic !== PAIRING_BINARY_MAGIC) {
    throw new Error("Invalid pairing data format");
  }
  const version = buf[o++];
  if (version === undefined) throw new Error("Invalid pairing data format");
  // Accept v2 (legacy trailing label), v3 (…|pk), and v4 (…|pk|pairingId|hostname).
  if (version < 2 || version > PAIRING_BINARY_VERSION) {
    throw new Error("Invalid pairing data format");
  }

  const didLen = buf[o++];
  if (didLen === undefined) throw new Error("Invalid pairing data format");
  if (didLen === 0) throw new Error("Invalid pairing data format");
  if (o + didLen > buf.length) throw new Error("Invalid pairing data format");
  const wireDid = decodeUtf8(buf.subarray(o, o + didLen));
  o += didLen;
  // v2 stored the did verbatim; v3 strips the canonical `daemon-` prefix.
  const did = version === 2 ? wireDid : `${DAEMON_ID_PREFIX}${wireDid}`;

  const relayLen = buf[o++];
  if (relayLen === undefined) throw new Error("Invalid pairing data format");
  if (o + relayLen > buf.length) throw new Error("Invalid pairing data format");
  // relay_len=0 is the wire signal for the default production relay.
  const relay =
    relayLen === 0
      ? DEFAULT_PAIRING_RELAY_URL
      : decodeUtf8(buf.subarray(o, o + relayLen));
  o += relayLen;

  if (o + 32 + 32 > buf.length) {
    throw new Error("Invalid pairing data format");
  }
  const ps = buf.subarray(o, o + 32);
  o += 32;
  const pk = buf.subarray(o, o + 32);
  o += 32;

  // Trailing fields differ by version. v2/v3 leave pairingId/hostname empty so
  // the caller can derive a legacy id; v4 reads them from the payload. Byte-exact
  // with the Rust decoder's `match version` arms.
  let pairingId = "";
  let hostname = "";
  if (version === 2) {
    // v2 carried a trailing `label_len(1) | label_bytes`. We discard the label
    // (it now arrives via relay.kx) but must still validate the length so a
    // malformed v2 payload doesn't silently decode as if it were truncated.
    if (o >= buf.length) throw new Error("Invalid pairing data format");
    const labelLen = buf[o++];
    if (labelLen === undefined) throw new Error("Invalid pairing data format");
    if (o + labelLen > buf.length) {
      throw new Error("Invalid pairing data format");
    }
  } else if (version === 4) {
    // v4 appends pairing_id(16 raw UUID) | hostname_len(1) | hostname.
    if (o + 16 + 1 > buf.length) {
      throw new Error("Invalid pairing data format");
    }
    pairingId = formatUuid(buf.subarray(o, o + 16));
    o += 16;
    const hostLen = buf[o++];
    if (hostLen === undefined) throw new Error("Invalid pairing data format");
    if (o + hostLen > buf.length) {
      throw new Error("Invalid pairing data format");
    }
    hostname = decodeUtf8(buf.subarray(o, o + hostLen));
    o += hostLen;
  }
  // version === 3 stops at pk — nothing more to read.

  return {
    ps: bytesToBase64(ps),
    pk: bytesToBase64(pk),
    relay,
    did,
    v: version,
    pairingId,
    hostname,
  };
}

// ── base64/base64url helpers ──
// We avoid the sodium-based helpers for these because pairing decode runs
// from deep-link handlers before sodium has been initialized.

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) throw new Error("bytesToBase64: index out of bounds");
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const padLen = (4 - (b64url.length % 4)) % 4;
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return base64ToBytes(b64);
}

/**
 * From the Frontend side: extract what's needed from scanned QR data
 * to initiate the key exchange.
 */
export async function parsePairingForFrontend(data: PairingData) {
  const pairingSecret = await fromBase64(data.ps);
  const daemonPublicKey = await fromBase64(data.pk);
  const relayToken = await deriveRelayToken(pairingSecret);
  const registrationProof = await deriveRegistrationProof(pairingSecret);

  return {
    daemonPublicKey,
    pairingSecret,
    relayToken,
    registrationProof,
    relayUrl: data.relay,
    daemonId: data.did,
    // v4 carries these; empty for legacy v2/v3 bundles (caller derives a legacy
    // pairing-id from `daemonId` in that case).
    pairingId: data.pairingId,
    hostname: data.hostname,
  };
}
