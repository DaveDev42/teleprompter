/**
 * E2EE crypto module using libsodium.
 *
 * - Key exchange: X25519 (crypto_kx)
 * - Encryption: AES-256-GCM (via secretbox with XSalsa20-Poly1305 as
 *   libsodium's crypto_aead_xchacha20poly1305_ietf is more portable
 *   than AES-256-GCM which requires hardware support)
 * - Key derivation: crypto_kdf from shared secret
 * - Nonce: random per frame (safe with XChaCha20's 24-byte nonce)
 */

// Use require() to avoid ESM relative import issues in pnpm hoisted monorepo
const _sodium = require("libsodium-wrappers-sumo") as typeof import("libsodium-wrappers-sumo");

let ready = false;

export async function ensureSodium() {
  if (!ready) {
    await _sodium.ready;
    ready = true;
  }
  return _sodium;
}

// ── Key Pair ──

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const sodium = await ensureSodium();
  const kp = sodium.crypto_kx_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// ── Key Exchange (ECDH) ──

export interface SessionKeys {
  /** Key for encrypting data sent to the peer */
  tx: Uint8Array;
  /** Key for decrypting data received from the peer */
  rx: Uint8Array;
}

/**
 * Derive session keys from a key exchange.
 * The daemon is the "server" side, the frontend is the "client" side.
 */
export async function deriveSessionKeys(
  myKeyPair: KeyPair,
  peerPublicKey: Uint8Array,
  role: "daemon" | "frontend",
): Promise<SessionKeys> {
  const sodium = await ensureSodium();

  if (role === "daemon") {
    // Server side
    const keys = sodium.crypto_kx_server_session_keys(
      myKeyPair.publicKey,
      myKeyPair.secretKey,
      peerPublicKey,
    );
    return { rx: keys.sharedRx, tx: keys.sharedTx };
  } else {
    // Client side
    const keys = sodium.crypto_kx_client_session_keys(
      myKeyPair.publicKey,
      myKeyPair.secretKey,
      peerPublicKey,
    );
    return { rx: keys.sharedRx, tx: keys.sharedTx };
  }
}

// ── Encrypt / Decrypt ──

/**
 * Encrypt plaintext with the given key.
 * Returns: nonce + ciphertext concatenated, base64-encoded.
 */
export async function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<string> {
  const sodium = await ensureSodium();
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null, // additional data
    null, // nsec (unused)
    nonce,
    key,
  );
  // Concatenate nonce + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypt a base64-encoded nonce+ciphertext with the given key.
 * Returns plaintext bytes.
 */
export async function decrypt(
  encoded: string,
  key: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await ensureSodium();
  const combined = sodium.from_base64(
    encoded,
    sodium.base64_variants.ORIGINAL,
  );
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = combined.subarray(0, nonceLen);
  const ciphertext = combined.subarray(nonceLen);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, // nsec (unused)
    ciphertext,
    null, // additional data
    nonce,
    key,
  );
}

// ── Pairing Secret ──

/**
 * Generate a random 32-byte pairing secret.
 */
export async function generatePairingSecret(): Promise<Uint8Array> {
  const sodium = await ensureSodium();
  return sodium.randombytes_buf(32);
}

/**
 * Derive an auth token from the pairing secret (for relay authentication).
 * Uses BLAKE2b hash: H(pairing_secret || "relay-auth")
 */
export async function deriveRelayToken(
  pairingSecret: Uint8Array,
): Promise<string> {
  const sodium = await ensureSodium();
  const context = sodium.from_string("relay-auth");
  const input = new Uint8Array(pairingSecret.length + context.length);
  input.set(pairingSecret);
  input.set(context, pairingSecret.length);
  const hash = sodium.crypto_generichash(32, input);
  return sodium.to_hex(hash);
}

// ── Helpers ──

export async function toBase64(data: Uint8Array): Promise<string> {
  const sodium = await ensureSodium();
  return sodium.to_base64(data, sodium.base64_variants.ORIGINAL);
}

export async function fromBase64(encoded: string): Promise<Uint8Array> {
  const sodium = await ensureSodium();
  return sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL);
}

export async function toHex(data: Uint8Array): Promise<string> {
  const sodium = await ensureSodium();
  return sodium.to_hex(data);
}
