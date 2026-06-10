/**
 * CryptoProvider interface — low-level crypto seam.
 *
 * Abstracted over the libsodium-wrappers implementation so that a native
 * crypto bridge (e.g. react-native-quick-crypto) can be swapped in behind
 * this interface without touching any public API in crypto.ts.
 *
 * Contract notes:
 * - All Uint8Array inputs/outputs are caller-owned; implementations must not
 *   retain references to them.
 * - `aeadEncrypt` returns the combined ciphertext+tag blob (libsodium style);
 *   the nonce is NOT prepended — callers in crypto.ts prepend it themselves.
 * - `aeadDecrypt` receives the raw ciphertext+tag (no nonce prefix).
 * - `genericHash32` is BLAKE2b with outlen=32, matching libsodium's
 *   `crypto_generichash(32, input)` exactly.
 * - `NPUBBYTES` is the XChaCha20-Poly1305-IETF nonce size (24 bytes).
 * - `toBase64` / `fromBase64` use the ORIGINAL (standard) base64 variant
 *   (same as libsodium `base64_variants.ORIGINAL`).
 * - `fromString` converts a UTF-8 JS string to bytes (same as libsodium
 *   `from_string`).
 */
export interface CryptoProvider {
  // ── Key exchange ──────────────────────────────────────────────────────────

  /** Generate a fresh X25519 key-exchange keypair. */
  kxKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array };

  /**
   * Derive server-side session keys from a completed X25519 key exchange.
   * Returns `{ rx, tx }` — libsodium `crypto_kx_server_session_keys`.
   */
  kxServerSessionKeys(
    pk: Uint8Array,
    sk: Uint8Array,
    peerPk: Uint8Array,
  ): { rx: Uint8Array; tx: Uint8Array };

  /**
   * Derive client-side session keys from a completed X25519 key exchange.
   * Returns `{ rx, tx }` — libsodium `crypto_kx_client_session_keys`.
   */
  kxClientSessionKeys(
    pk: Uint8Array,
    sk: Uint8Array,
    peerPk: Uint8Array,
  ): { rx: Uint8Array; tx: Uint8Array };

  // ── AEAD (XChaCha20-Poly1305-IETF) ───────────────────────────────────────

  /**
   * Encrypt `plaintext` with `key` and optional additional data.
   * Returns the combined ciphertext+tag blob (nonce NOT included).
   * `aad` may be `null` when there is no additional data to bind.
   */
  aeadEncrypt(
    plaintext: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  /**
   * Decrypt `ciphertext` (combined ct+tag, no nonce prefix) with `key`.
   * Returns plaintext on success; throws on authentication failure.
   * `aad` must match what was used during encryption, or `null` for none.
   */
  aeadDecrypt(
    ciphertext: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  // ── Randomness ────────────────────────────────────────────────────────────

  /** Return `n` cryptographically secure random bytes. */
  randomBytes(n: number): Uint8Array;

  // ── Hashing ───────────────────────────────────────────────────────────────

  /**
   * BLAKE2b hash with 32-byte output.
   * Semantically equivalent to libsodium `crypto_generichash(32, input)`.
   */
  genericHash32(input: Uint8Array): Uint8Array;

  // ── Constants ─────────────────────────────────────────────────────────────

  /** XChaCha20-Poly1305-IETF nonce length in bytes (24). */
  NPUBBYTES: number;

  // ── Encoding helpers ──────────────────────────────────────────────────────

  /**
   * Encode bytes as standard (ORIGINAL variant) base64.
   * Equivalent to libsodium `to_base64(data, base64_variants.ORIGINAL)`.
   */
  toBase64(data: Uint8Array): string;

  /**
   * Decode standard (ORIGINAL variant) base64 to bytes.
   * Equivalent to libsodium `from_base64(encoded, base64_variants.ORIGINAL)`.
   */
  fromBase64(encoded: string): Uint8Array;

  /**
   * Encode bytes as a lowercase hex string.
   * Equivalent to libsodium `to_hex(data)`.
   */
  toHex(data: Uint8Array): string;

  /**
   * Decode a UTF-8 JS string to bytes.
   * Equivalent to libsodium `from_string(str)`.
   */
  fromString(str: string): Uint8Array;

  /**
   * Encode bytes as a UTF-8 string.
   * Equivalent to libsodium `to_string(data)`.
   */
  toString(data: Uint8Array): string;
}
