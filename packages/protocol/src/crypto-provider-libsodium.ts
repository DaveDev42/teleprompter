/**
 * Libsodium-wrappers implementation of CryptoProvider.
 *
 * Lifted verbatim from the initialization pattern in crypto.ts so that
 * crypto.ts can delegate all primitive calls through the seam.
 *
 * Notes on wasm2js / init-noise:
 *   libsodium first tries to instantiate native WebAssembly; on runtimes
 *   without it (Hermes/React Native) that path fails and libsodium falls
 *   back to its bundled wasm2js polyfill. The failure is expected and crypto
 *   still initialises correctly, but emscripten emits two noisy init lines.
 *   We do NOT suppress them here — see the init-noise filter in
 *   apps/app/src/lib/crypto-polyfill.ts which wraps console.error BEFORE
 *   libsodium is ever required.
 */

import type { CryptoProvider } from "./crypto-provider";

export async function createLibsodiumProvider(): Promise<CryptoProvider> {
  const s = require("libsodium-wrappers") as typeof import("libsodium-wrappers");
  await s.ready;

  return {
    kxKeypair() {
      const kp = s.crypto_kx_keypair();
      return { publicKey: kp.publicKey, secretKey: kp.privateKey };
    },

    kxServerSessionKeys(pk, sk, peerPk) {
      const keys = s.crypto_kx_server_session_keys(pk, sk, peerPk);
      return { rx: keys.sharedRx, tx: keys.sharedTx };
    },

    kxClientSessionKeys(pk, sk, peerPk) {
      const keys = s.crypto_kx_client_session_keys(pk, sk, peerPk);
      return { rx: keys.sharedRx, tx: keys.sharedTx };
    },

    aeadEncrypt(plaintext, aad, nonce, key) {
      return s.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        aad,
        null, // nsec (unused by this primitive)
        nonce,
        key,
      );
    },

    aeadDecrypt(ciphertext, aad, nonce, key) {
      return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, // nsec (unused by this primitive)
        ciphertext,
        aad,
        nonce,
        key,
      );
    },

    randomBytes(n) {
      return s.randombytes_buf(n);
    },

    genericHash32(input) {
      return s.crypto_generichash(32, input);
    },

    NPUBBYTES: s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,

    toBase64(data) {
      return s.to_base64(data, s.base64_variants.ORIGINAL);
    },

    fromBase64(encoded) {
      return s.from_base64(encoded, s.base64_variants.ORIGINAL);
    },

    toHex(data) {
      return s.to_hex(data);
    },

    fromString(str) {
      return s.from_string(str);
    },
  };
}
