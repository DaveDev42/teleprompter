/**
 * react-native-quick-crypto (RNQC) CryptoProvider implementation.
 *
 * This module is guarded by USE_NATIVE_CRYPTO in apps/app/index.ts and is
 * NEVER imported unconditionally. The JSI module (RNQC) is lazy-required
 * inside the factory body so that merely importing this file does NOT crash
 * RN Web or bun:test.
 *
 * genericHash32 — the trap
 * ─────────────────────────
 * `crypto_generichash(32, x)` in libsodium is BLAKE2b with outlen=32.
 * BLAKE2b folds the output length into its init parameter block, so
 *   blake2b512(x).slice(0, 32) ≠ blake2b(x, outlen=32)
 * RNQC 1.1.5 has BLAKE3 (not BLAKE2b) natively; we therefore use
 * `blakejs.blake2b(input, undefined, 32)` which correctly initialises
 * BLAKE2b with outlen=32. blakejs is pure-JS (no JSI/native code),
 * safe on every runtime.
 *
 * kx session key derivation (replicates libsodium crypto_kx exactly)
 * ────────────────────────────────────────────────────────────────────
 *   q        = X25519_ECDH(my_sk, peer_pk)
 *   combined = q ‖ client_pk ‖ server_pk   (fixed order)
 *   h512     = BLAKE2b-512(combined)
 *   client:  rx = h512[0:32],  tx = h512[32:64]
 *   server:  rx = h512[32:64], tx = h512[0:32]   (swap vs client)
 *
 * AEAD (XChaCha20-Poly1305-IETF) layout
 * ───────────────────────────────────────
 * RNQC's createCipheriv / createDecipheriv work like Node.js crypto:
 * encrypt returns ciphertext; getAuthTag() returns the 16-byte tag.
 * We concatenate ct‖tag to match libsodium's combined output.
 * decrypt must split the last 16 bytes as the tag and call setAuthTag
 * before final().
 */

import type { CryptoProvider } from "@teleprompter/protocol/client";

// blakejs is pure-JS — safe to import statically on every runtime.
import { blake2b } from "blakejs";

// ── Type helpers (avoid importing RNQC types which pull in craftzdog/Buffer) ──

interface RnqcBuffer {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

function toU8(buf: RnqcBuffer | Uint8Array): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Slice a Uint8Array's underlying buffer into a fresh ArrayBuffer for RNQC. */
function u8ToAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
}

// ── Base64 (ORIGINAL variant — standard alphabet, padded) ────────────────────
// Pure-TS codec. Hermes does not guarantee btoa/atob globals, and the
// `btoa(String.fromCharCode(...data))` idiom overflows the call stack on large
// payloads (terminal io frames can be tens of KB). A plain loop has no payload
// size limit and works identically on every runtime.

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

function bytesToBase64(data: Uint8Array): string {
  const len = data.length;
  const parts: string[] = [];
  let out = "";
  for (let i = 0; i < len; i += 3) {
    const b0 = data[i] ?? 0;
    const b1 = data[i + 1] ?? 0;
    const b2 = data[i + 2] ?? 0;
    out +=
      B64_ALPHABET.charAt(b0 >> 2) +
      B64_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4)) +
      (i + 1 < len
        ? B64_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6))
        : "=") +
      (i + 2 < len ? B64_ALPHABET.charAt(b2 & 0x3f) : "=");
    // Flush periodically so the rope never degrades into one huge string append.
    if (out.length >= 8192) {
      parts.push(out);
      out = "";
    }
  }
  if (parts.length === 0) {
    return out;
  }
  parts.push(out);
  return parts.join("");
}

function base64ToBytes(encoded: string): Uint8Array {
  let end = encoded.length;
  while (end > 0 && encoded.charCodeAt(end - 1) === 0x3d /* '=' */) {
    end--;
  }
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = encoded.charCodeAt(i);
    const v = code < 128 ? (B64_LOOKUP[code] ?? -1) : -1;
    if (v < 0) {
      throw new Error("crypto-provider-native: invalid base64 input");
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createNativeCryptoProvider(): Promise<CryptoProvider> {
  // Lazy-require so the JSI module is only loaded on native when this factory
  // is actually invoked.
  // biome-ignore lint/suspicious/noExplicitAny: RNQC types pull in craftzdog/Buffer
  const QC = require("react-native-quick-crypto") as any;

  // ── ECDH ─────────────────────────────────────────────────────────────────

  function x25519Ecdh(
    myPrivateKey: Uint8Array,
    peerPublicKey: Uint8Array,
  ): Uint8Array {
    const result: RnqcBuffer = QC.diffieHellman({
      privateKey: {
        key: u8ToAB(myPrivateKey),
        format: "raw-private",
        asymmetricKeyType: "x25519",
      },
      publicKey: {
        key: u8ToAB(peerPublicKey),
        format: "raw-public",
        asymmetricKeyType: "x25519",
      },
    });
    return toU8(result);
  }

  /**
   * Derive session keys via BLAKE2b-512 over the KX combined input.
   * Returns the first 32 and last 32 bytes of the 64-byte hash.
   */
  function kxDerive(
    q: Uint8Array,
    clientPk: Uint8Array,
    serverPk: Uint8Array,
  ): { first32: Uint8Array; last32: Uint8Array } {
    const combined = new Uint8Array(
      q.length + clientPk.length + serverPk.length,
    );
    combined.set(q, 0);
    combined.set(clientPk, q.length);
    combined.set(serverPk, q.length + clientPk.length);
    // BLAKE2b-512 (outlen=64) — the exact primitive libsodium crypto_kx uses.
    const h512 = blake2b(combined, undefined, 64);
    return {
      first32: new Uint8Array(h512.slice(0, 32)),
      last32: new Uint8Array(h512.slice(32, 64)),
    };
  }

  // ── Provider implementation ───────────────────────────────────────────────

  return {
    // ── Key exchange ───────────────────────────────────────────────────────

    kxKeypair() {
      // generateKeyPairSync('x25519') returns KeyObjectKeyPair when no encoding options
      const { publicKey, privateKey } = QC.generateKeyPairSync("x25519") as {
        publicKey: { export(opts: object): RnqcBuffer };
        privateKey: { export(opts: object): RnqcBuffer };
      };
      return {
        publicKey: toU8(publicKey.export({ format: "raw-public" })),
        secretKey: toU8(privateKey.export({ format: "raw-private" })),
      };
    },

    kxClientSessionKeys(clientPk, clientSk, serverPk) {
      const q = x25519Ecdh(clientSk, serverPk);
      const { first32, last32 } = kxDerive(q, clientPk, serverPk);
      return { rx: first32, tx: last32 };
    },

    kxServerSessionKeys(serverPk, serverSk, clientPk) {
      const q = x25519Ecdh(serverSk, clientPk);
      const { first32, last32 } = kxDerive(q, clientPk, serverPk);
      // Server swaps: rx = last32, tx = first32
      return { rx: last32, tx: first32 };
    },

    // ── AEAD (XChaCha20-Poly1305-IETF) ────────────────────────────────────

    aeadEncrypt(plaintext, aad, nonce, key) {
      // RNQC accepts Uint8Array as BinaryLike/BinaryLikeNode — no Buffer conversion needed.
      const cipher = QC.createCipheriv("xchacha20-poly1305", key, nonce, {
        authTagLength: 16,
      });
      if (aad !== null) {
        cipher.setAAD(aad);
      }
      const ctBuf: RnqcBuffer = cipher.update(plaintext);
      cipher.final(); // xchacha20-poly1305 produces no additional bytes on final
      const tagBuf: RnqcBuffer = cipher.getAuthTag();
      const ct = toU8(ctBuf);
      const tag = toU8(tagBuf);
      // Combined: ct ‖ tag (libsodium style)
      const combined = new Uint8Array(ct.length + tag.length);
      combined.set(ct, 0);
      combined.set(tag, ct.length);
      return combined;
    },

    aeadDecrypt(ciphertext, aad, nonce, key) {
      const tagLength = 16;
      const ct = ciphertext.subarray(0, ciphertext.length - tagLength);
      const tag = ciphertext.subarray(ciphertext.length - tagLength);

      const decipher = QC.createDecipheriv("xchacha20-poly1305", key, nonce, {
        authTagLength: 16,
      });
      decipher.setAuthTag(tag);
      if (aad !== null) {
        decipher.setAAD(aad);
      }
      const ptBuf: RnqcBuffer = decipher.update(ct);
      decipher.final();
      return toU8(ptBuf);
    },

    // ── Randomness ────────────────────────────────────────────────────────

    randomBytes(n) {
      return toU8(QC.randomBytes(n) as RnqcBuffer);
    },

    // ── Hashing ───────────────────────────────────────────────────────────

    /**
     * BLAKE2b with outlen=32, matching libsodium crypto_generichash(32, input).
     *
     * We use blakejs (pure-JS) with outlen=32. Do NOT truncate a 64-byte digest:
     * BLAKE2b folds outlen into the parameter block, so those are different hashes.
     */
    genericHash32(input) {
      return blake2b(input, undefined, 32);
    },

    // ── Constants ─────────────────────────────────────────────────────────

    NPUBBYTES: 24,

    // ── Encoding helpers ─────────────────────────────────────────────────

    toBase64(data) {
      // Standard (ORIGINAL) base64: + / with padding — matches libsodium ORIGINAL
      return bytesToBase64(data);
    },

    fromBase64(encoded) {
      return base64ToBytes(encoded);
    },

    toHex(data) {
      return Array.from(data)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },

    fromString(str) {
      return new TextEncoder().encode(str);
    },

    toString(data) {
      return new TextDecoder().decode(data);
    },
  };
}
