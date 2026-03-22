/**
 * QR pairing data structure and serialization.
 *
 * The QR code contains:
 *  - pairing secret (32 bytes)
 *  - daemon public key (32 bytes)
 *  - relay URL (string)
 *  - daemon ID (string)
 *
 * Encoded as JSON for simplicity (QR codes handle text well).
 */

import {
  generateKeyPair,
  generatePairingSecret,
  deriveRelayToken,
  toBase64,
  fromBase64,
  type KeyPair,
} from "./crypto";

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
}

/**
 * Generate everything needed for a new pairing QR code.
 */
export async function createPairingBundle(
  relayUrl: string,
  daemonId: string,
): Promise<PairingBundle> {
  const keyPair = await generateKeyPair();
  const pairingSecret = await generatePairingSecret();
  const relayToken = await deriveRelayToken(pairingSecret);

  const qrData: PairingData = {
    ps: await toBase64(pairingSecret),
    pk: await toBase64(keyPair.publicKey),
    relay: relayUrl,
    did: daemonId,
    v: 1,
  };

  return { qrData, keyPair, pairingSecret, relayToken };
}

/**
 * Serialize pairing data to a QR-friendly string.
 */
export function encodePairingData(data: PairingData): string {
  return JSON.stringify(data);
}

/**
 * Parse pairing data from a QR code scan result.
 */
export function decodePairingData(raw: string): PairingData {
  const data = JSON.parse(raw);
  if (
    typeof data.ps !== "string" ||
    typeof data.pk !== "string" ||
    typeof data.relay !== "string" ||
    typeof data.did !== "string" ||
    typeof data.v !== "number"
  ) {
    throw new Error("Invalid pairing data format");
  }
  return data as PairingData;
}

/**
 * From the Frontend side: extract what's needed from scanned QR data
 * to initiate the key exchange.
 */
export async function parsePairingForFrontend(data: PairingData) {
  const pairingSecret = await fromBase64(data.ps);
  const daemonPublicKey = await fromBase64(data.pk);
  const relayToken = await deriveRelayToken(pairingSecret);

  return {
    daemonPublicKey,
    pairingSecret,
    relayToken,
    relayUrl: data.relay,
    daemonId: data.did,
  };
}
