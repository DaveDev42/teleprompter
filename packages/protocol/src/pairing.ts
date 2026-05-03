/**
 * QR pairing data structure and serialization.
 *
 * The QR code contains:
 *  - pairing secret (32 bytes)
 *  - daemon public key (32 bytes)
 *  - relay URL (string)
 *  - daemon ID (string)
 *  - protocol version
 *  - optional human-readable label
 *
 * Wire format: `tp://p?d=<base64url(binary)>`
 * The deep-link form lets the iPhone system camera open the app directly,
 * and stays compact enough for terminal QR rendering even with longer labels.
 * Short scheme + path keeps the prefix at 9 chars so module count stays low.
 */

import {
  deriveRegistrationProof,
  deriveRelayToken,
  fromBase64,
  generateKeyPair,
  generatePairingSecret,
  type KeyPair,
  toBase64,
} from "./crypto";

const PAIRING_URL_SCHEME = "tp://p";
const PAIRING_BINARY_MAGIC = "tp"; // 2 bytes
const PAIRING_BINARY_VERSION = 2;
/**
 * Production relay URL. When the QR encodes this exact URL, the binary form
 * stores `relay_len = 0` to save ~22 bytes (`wss://relay.tpmt.dev`). Decoder
 * treats `relay_len = 0` as "use the default relay". Self-hosted relays still
 * encode the full URL inline and round-trip verbatim.
 */
export const DEFAULT_PAIRING_RELAY_URL = "wss://relay.tpmt.dev";

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
  /** Optional human-readable daemon label */
  label?: string;
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
 */
export async function createPairingBundle(
  relayUrl: string,
  daemonId: string,
  opts?: { label?: string },
): Promise<PairingBundle> {
  const keyPair = await generateKeyPair();
  const pairingSecret = await generatePairingSecret();
  const relayToken = await deriveRelayToken(pairingSecret);
  const registrationProof = await deriveRegistrationProof(pairingSecret);

  const qrData: PairingData = {
    ps: await toBase64(pairingSecret),
    pk: await toBase64(keyPair.publicKey),
    relay: relayUrl,
    did: daemonId,
    v: PAIRING_BINARY_VERSION,
    ...(opts?.label ? { label: opts.label } : {}),
  };

  return { qrData, keyPair, pairingSecret, relayToken, registrationProof };
}

/**
 * Serialize pairing data to a QR-friendly deep-link string.
 *
 * Output: `tp://p?d=<base64url(binary)>`
 *
 * Binary layout:
 *   magic(2) | version(1) |
 *   did_len(1) | did_bytes |
 *   relay_len(1) | relay_bytes |
 *   ps(32) | pk(32) |
 *   label_len(1) | label_bytes
 *
 * `did`/`relay`/`label` are utf-8 encoded, each capped at 255 bytes.
 *
 * `relay_len = 0` is the wire signal for "default relay" — see
 * `DEFAULT_PAIRING_RELAY_URL`. Saves ~22 bytes on the most common case
 * (production relay) and shaves a noticeable chunk off the QR module count.
 */
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

export function encodePairingData(data: PairingData): string {
  const enc = new TextEncoder();
  const did = enc.encode(data.did);
  const useDefaultRelay =
    normalizeRelayForDefaultMatch(data.relay) === NORMALIZED_DEFAULT_RELAY;
  const relay = useDefaultRelay ? new Uint8Array(0) : enc.encode(data.relay);
  const label = enc.encode(data.label ?? "");
  const ps = base64ToBytes(data.ps);
  const pk = base64ToBytes(data.pk);

  if (did.length > 255) throw new Error("daemon id exceeds 255 bytes");
  if (relay.length > 255) throw new Error("relay url exceeds 255 bytes");
  if (label.length > 255) throw new Error("label exceeds 255 bytes");
  if (ps.length !== 32) throw new Error("pairing secret must be 32 bytes");
  if (pk.length !== 32) throw new Error("daemon public key must be 32 bytes");

  const totalLen =
    2 + 1 + 1 + did.length + 1 + relay.length + 32 + 32 + 1 + label.length;
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
  buf[o++] = label.length;
  buf.set(label, o);

  return `${PAIRING_URL_SCHEME}?d=${bytesToBase64Url(buf)}`;
}

/**
 * Parse pairing data from a `tp://p?d=<base64url>` deep link.
 */
export function decodePairingData(raw: string): PairingData {
  // Strip ASCII whitespace and a UTF-8 BOM (clipboards on Windows can prepend
  // a BOM that survives copy/paste through iOS).
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
  let buf: Uint8Array;
  try {
    buf = base64UrlToBytes(b64);
  } catch {
    throw new Error("Invalid pairing data format");
  }
  if (buf.length < 2 + 1 + 1 + 1 + 32 + 32 + 1) {
    throw new Error("Invalid pairing data format");
  }

  const dec = new TextDecoder();
  let o = 0;
  const magic = dec.decode(buf.subarray(o, o + 2));
  o += 2;
  if (magic !== PAIRING_BINARY_MAGIC) {
    throw new Error("Invalid pairing data format");
  }
  const version = buf[o++];
  if (version !== PAIRING_BINARY_VERSION) {
    throw new Error("Invalid pairing data format");
  }

  const didLen = buf[o++];
  if (didLen === 0) throw new Error("Invalid pairing data format");
  if (o + didLen > buf.length) throw new Error("Invalid pairing data format");
  const did = dec.decode(buf.subarray(o, o + didLen));
  o += didLen;

  const relayLen = buf[o++];
  if (o + relayLen > buf.length) throw new Error("Invalid pairing data format");
  // relay_len=0 is the wire signal for the default production relay.
  const relay =
    relayLen === 0
      ? DEFAULT_PAIRING_RELAY_URL
      : dec.decode(buf.subarray(o, o + relayLen));
  o += relayLen;

  if (o + 32 + 32 + 1 > buf.length) {
    throw new Error("Invalid pairing data format");
  }
  const ps = buf.subarray(o, o + 32);
  o += 32;
  const pk = buf.subarray(o, o + 32);
  o += 32;

  const labelLen = buf[o++];
  if (o + labelLen > buf.length) throw new Error("Invalid pairing data format");
  const label = labelLen > 0 ? dec.decode(buf.subarray(o, o + labelLen)) : "";

  return {
    ps: bytesToBase64(ps),
    pk: bytesToBase64(pk),
    relay,
    did,
    v: version,
    ...(label.length > 0 ? { label } : {}),
  };
}

// ── base64/base64url helpers ──
// We avoid the sodium-based helpers for these because pairing decode runs
// from deep-link handlers before sodium has been initialized.

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
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
  };
}
