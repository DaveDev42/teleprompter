/**
 * E2EE crypto module using libsodium.
 *
 * - Key exchange: X25519 (crypto_kx)
 * - Encryption: XChaCha20-Poly1305 (crypto_aead_xchacha20poly1305_ietf)
 *   — more portable than AES-256-GCM (no hardware AES-NI requirement)
 * - Key derivation: crypto_kx for session keys, BLAKE2b (crypto_generichash) for ratchet
 * - Nonce: random per frame (safe with XChaCha20's 24-byte nonce)
 *
 * All libsodium primitives are routed through a CryptoProvider seam so that
 * an alternative implementation (e.g. react-native-quick-crypto) can be
 * swapped in without touching this file or any callers.
 */

import type { CryptoProvider } from "./crypto-provider";
import { createLibsodiumProvider } from "./crypto-provider-libsodium";

// ── Provider factory + memoized promise ──────────────────────────────────────

// The factory can be replaced before first use via __setCryptoProviderFactory.
let _providerFactory: () => Promise<CryptoProvider> = createLibsodiumProvider;

// Memoize the *promise*, not the resolved object: prior code stashed the
// partially-initialized module before `await ready` resolved, so a second
// concurrent caller could observe `_sodium` as set but find APIs like
// `crypto_generichash` still undefined. Caching the promise means every
// concurrent caller awaits the same ready resolution.
let _providerPromise: Promise<CryptoProvider> | null = null;

/**
 * Override the CryptoProvider factory.
 *
 * Must be called BEFORE any crypto operation — calling it after
 * `ensureSodium()` has already resolved has no effect on existing callers
 * that are already holding a resolved provider. This function also resets the
 * memoized promise so the new factory is used on the next `ensureSodium()`
 * call.
 *
 * Intended for tests and for the react-native-quick-crypto migration (PR2/3).
 */
export function __setCryptoProviderFactory(
  fn: () => Promise<CryptoProvider>,
): void {
  _providerFactory = fn;
  _providerPromise = null;
}

export async function ensureSodium(): Promise<CryptoProvider> {
  if (!_providerPromise) {
    _providerPromise = _providerFactory();
  }
  return _providerPromise;
}

// ── Key Pair ──

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const p = await ensureSodium();
  return p.kxKeypair();
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
  const p = await ensureSodium();

  if (role === "daemon") {
    // Server side
    return p.kxServerSessionKeys(
      myKeyPair.publicKey,
      myKeyPair.secretKey,
      peerPublicKey,
    );
  } else {
    // Client side
    return p.kxClientSessionKeys(
      myKeyPair.publicKey,
      myKeyPair.secretKey,
      peerPublicKey,
    );
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
  const p = await ensureSodium();
  const nonce = p.randomBytes(p.NPUBBYTES);
  const ciphertext = p.aeadEncrypt(plaintext, null, nonce, key);
  // Concatenate nonce + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return p.toBase64(combined);
}

/**
 * Decrypt a base64-encoded nonce+ciphertext with the given key.
 * Returns plaintext bytes.
 */
export async function decrypt(
  encoded: string,
  key: Uint8Array,
): Promise<Uint8Array> {
  const p = await ensureSodium();
  const combined = p.fromBase64(encoded);
  const nonceLen = p.NPUBBYTES;
  const nonce = combined.subarray(0, nonceLen);
  const ciphertext = combined.subarray(nonceLen);
  return p.aeadDecrypt(ciphertext, null, nonce, key);
}

// ── Ephemeral Key Ratchet ──

/**
 * Derive ephemeral session keys for a specific session.
 * Each session gets unique keys by mixing the base session keys
 * with the session ID via HKDF (BLAKE2b).
 *
 * Uses a role-independent derivation: both sides compute the same
 * two key materials (k_a, k_b), then assign tx/rx based on role.
 * k_a = H(min(base_tx, base_rx) || sid || "a")
 * k_b = H(max(base_tx, base_rx) || sid || "b")
 * daemon: tx=k_a, rx=k_b. frontend: tx=k_b, rx=k_a.
 */
export async function ratchetSessionKeys(
  baseKeys: SessionKeys,
  sessionId: string,
  role: "daemon" | "frontend" = "daemon",
): Promise<SessionKeys> {
  const p = await ensureSodium();
  const sidBytes = p.fromString(sessionId);

  // Canonicalize: sort the two base keys to ensure both sides
  // use the same inputs regardless of tx/rx assignment
  const txLtRx = compareBytes(baseKeys.tx, baseKeys.rx) <= 0;
  const keyA = txLtRx ? baseKeys.tx : baseKeys.rx;
  const keyB = txLtRx ? baseKeys.rx : baseKeys.tx;

  // Derive two independent keys
  const inputA = new Uint8Array(keyA.length + sidBytes.length + 1);
  inputA.set(keyA);
  inputA.set(sidBytes, keyA.length);
  inputA.set(p.fromString("a"), keyA.length + sidBytes.length);
  const kA = p.genericHash32(inputA);

  const inputB = new Uint8Array(keyB.length + sidBytes.length + 1);
  inputB.set(keyB);
  inputB.set(sidBytes, keyB.length);
  inputB.set(p.fromString("b"), keyB.length + sidBytes.length);
  const kB = p.genericHash32(inputB);

  // Assign based on role: daemon tx=kA, rx=kB; frontend tx=kB, rx=kA
  return role === "daemon" ? { tx: kA, rx: kB } : { tx: kB, rx: kA };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined)
      throw new Error("compareBytes: index out of bounds");
    if (ai !== bi) return ai - bi;
  }
  return a.length - b.length;
}

// ── Pairing Secret ──

/**
 * Generate a random 32-byte pairing secret.
 */
export async function generatePairingSecret(): Promise<Uint8Array> {
  const p = await ensureSodium();
  return p.randomBytes(32);
}

/**
 * Shared BLAKE2b KDF pattern: H(secret || domain) → 32-byte digest.
 * All three public derivation functions (relay token, kx key, registration
 * proof) use this exact concat-and-hash shape; centralising it here ensures
 * a KDF algorithm upgrade propagates to all three sites at once.
 */
async function deriveBlake2b(
  p: CryptoProvider,
  secret: Uint8Array,
  domain: string,
): Promise<Uint8Array> {
  const domainBytes = p.fromString(domain);
  const input = new Uint8Array(secret.length + domainBytes.length);
  input.set(secret);
  input.set(domainBytes, secret.length);
  return p.genericHash32(input);
}

/**
 * Derive an auth token from the pairing secret (for relay authentication).
 * Uses BLAKE2b hash: H(pairing_secret || "relay-auth")
 */
export async function deriveRelayToken(
  pairingSecret: Uint8Array,
): Promise<string> {
  const p = await ensureSodium();
  const hash = await deriveBlake2b(p, pairingSecret, "relay-auth");
  return p.toHex(hash);
}

// ── Key Exchange Envelope ──

/**
 * Derive a symmetric key for encrypting key-exchange envelopes.
 * Both daemon and frontend derive the same key from the shared pairing secret.
 * H(pairing_secret || "kx-envelope")
 */
export async function deriveKxKey(
  pairingSecret: Uint8Array,
): Promise<Uint8Array> {
  const p = await ensureSodium();
  return deriveBlake2b(p, pairingSecret, "kx-envelope");
}

/**
 * Derive a relay-side push-seal key from a secret.
 * H(secret || "relay-push-seal") — distinct domain from "relay-auth",
 * "kx-envelope", and "relay-register".
 */
export async function derivePushSealKey(
  secret: Uint8Array,
): Promise<Uint8Array> {
  const p = await ensureSodium();
  return deriveBlake2b(p, secret, "relay-push-seal");
}

/**
 * Encrypt plaintext with AEAD and bind additional data into the tag.
 * Returns base64(nonce24 || ciphertext) — same layout as `encrypt`, but
 * passes `aad` instead of `null` so the tag covers both the ciphertext and
 * the AAD. Decryption with a different AAD throws (wrong tag).
 */
export async function sealWithAad(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const p = await ensureSodium();
  const nonce = p.randomBytes(p.NPUBBYTES);
  const ciphertext = p.aeadEncrypt(
    plaintext,
    aad, // additional data bound into the AEAD tag
    nonce,
    key,
  );
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return p.toBase64(combined);
}

/**
 * Decrypt a base64-encoded nonce+ciphertext sealed with `sealWithAad`.
 * `aad` must match the value used during sealing exactly; any mismatch
 * (wrong AAD, wrong key, tampered ciphertext) causes the provider to throw.
 */
export async function openWithAad(
  encoded: string,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const p = await ensureSodium();
  const combined = p.fromBase64(encoded);
  const nonceLen = p.NPUBBYTES;
  const nonce = combined.subarray(0, nonceLen);
  const ciphertext = combined.subarray(nonceLen);
  return p.aeadDecrypt(
    ciphertext,
    aad, // additional data — must match what was used to seal
    nonce,
    key,
  );
}

/**
 * Derive a registration proof for relay self-registration.
 * Proves knowledge of the pairing secret without exposing it.
 * H(pairing_secret || "relay-register")
 */
export async function deriveRegistrationProof(
  pairingSecret: Uint8Array,
): Promise<string> {
  const p = await ensureSodium();
  const hash = await deriveBlake2b(p, pairingSecret, "relay-register");
  return p.toHex(hash);
}

// ── Helpers ──

export async function toBase64(data: Uint8Array): Promise<string> {
  const p = await ensureSodium();
  return p.toBase64(data);
}

export async function fromBase64(encoded: string): Promise<Uint8Array> {
  const p = await ensureSodium();
  return p.fromBase64(encoded);
}

export async function toHex(data: Uint8Array): Promise<string> {
  const p = await ensureSodium();
  return p.toHex(data);
}
