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
 * Wire format: `teleprompter://pair?d=<base64url(binary)>`
 * The deep-link form lets the iPhone system camera open the app directly,
 * and stays compact enough for terminal QR rendering even with longer labels.
 *
 * Decoding accepts the deep-link form, the raw base64url payload, and the
 * legacy JSON form so old terminals/QRs keep working.
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

const PAIRING_URL_SCHEME = "teleprompter://pair";
const PAIRING_BINARY_MAGIC = "tp"; // 2 bytes
const PAIRING_BINARY_VERSION = 1;

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
    v: 1,
    ...(opts?.label ? { label: opts.label } : {}),
  };

  return { qrData, keyPair, pairingSecret, relayToken, registrationProof };
}

/**
 * Serialize pairing data to a QR-friendly deep-link string.
 *
 * Output: `teleprompter://pair?d=<base64url(binary)>`
 *
 * Binary layout:
 *   magic(2) | version(1) |
 *   did_len(1) | did_bytes |
 *   relay_len(1) | relay_bytes |
 *   ps(32) | pk(32) |
 *   label_len(1) | label_bytes
 *
 * `did`/`relay`/`label` are utf-8 encoded, each capped at 255 bytes.
 */
export function encodePairingData(data: PairingData): string {
  const enc = new TextEncoder();
  const did = enc.encode(data.did);
  const relay = enc.encode(data.relay);
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
 * Parse pairing data from a QR code scan result.
 *
 * Accepts (in order):
 *   1. `teleprompter://pair?d=<base64url>` (current)
 *   2. raw `<base64url>` payload (without scheme — manual paste convenience)
 *   3. legacy JSON object string (pre-deep-link daemons)
 */
export function decodePairingData(raw: string): PairingData {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Invalid pairing data format");

  // Form 1: deep link
  if (trimmed.startsWith(PAIRING_URL_SCHEME)) {
    const queryIdx = trimmed.indexOf("?");
    if (queryIdx < 0) throw new Error("Invalid pairing data format");
    const params = new URLSearchParams(trimmed.slice(queryIdx + 1));
    const d = params.get("d");
    if (!d) throw new Error("Invalid pairing data format");
    return decodeBinaryPairing(d);
  }

  // Form 3: legacy JSON
  if (trimmed.startsWith("{")) {
    return decodeJsonPairing(trimmed);
  }

  // Form 2: bare base64url payload
  return decodeBinaryPairing(trimmed);
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

  const didLen = buf[o++];
  if (o + didLen > buf.length) throw new Error("Invalid pairing data format");
  const did = dec.decode(buf.subarray(o, o + didLen));
  o += didLen;

  const relayLen = buf[o++];
  if (o + relayLen > buf.length) throw new Error("Invalid pairing data format");
  const relay = dec.decode(buf.subarray(o, o + relayLen));
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

function decodeJsonPairing(raw: string): PairingData {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Invalid pairing data format");
  }
  const obj = data as Record<string, unknown>;
  if (
    typeof obj.ps !== "string" ||
    typeof obj.pk !== "string" ||
    typeof obj.relay !== "string" ||
    typeof obj.did !== "string" ||
    typeof obj.v !== "number"
  ) {
    throw new Error("Invalid pairing data format");
  }
  if (obj.label !== undefined && typeof obj.label !== "string") {
    throw new Error("Invalid pairing data format");
  }
  return obj as unknown as PairingData;
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
