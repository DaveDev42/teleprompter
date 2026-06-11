/**
 * Unit tests for crypto-provider-native.ts.
 *
 * bun cannot load JSI modules, so we mock "react-native-quick-crypto" with a
 * stub that mimics the RNQC API surface used by createNativeCryptoProvider().
 *
 * What each mock is backed by — and what that means for the oracle:
 *
 * - diffieHellman / generateKeyPairSync → Node's X25519 (BoringSSL) via DER
 *   wrapping of raw keys. INDEPENDENT of libsodium, so the kx byte-identity
 *   tests are a real cross-implementation oracle (BoringSSL ECDH + blakejs
 *   BLAKE2b vs libsodium crypto_kx).
 * - createCipheriv / createDecipheriv → libsodium-backed, because Bun's
 *   node:crypto does NOT support xchacha20-poly1305. The AEAD tests therefore
 *   validate the provider's ct‖tag combine/split layout and aad-null handling,
 *   not an independent cipher implementation. True native AEAD interop is
 *   verified on-device (see docs/local-verification-queue.md).
 * - genericHash32 / kx derivation use the REAL blakejs import (pure JS), so
 *   all BLAKE2b oracle tests are independent of libsodium.
 *
 * mock.module leaks process-wide; we only mock "react-native-quick-crypto"
 * (no other app test imports it) and restore the protocol crypto factory in
 * afterAll so later test files get the default libsodium provider.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as protocolClient from "@teleprompter/protocol/client";
import { createLibsodiumProvider } from "@teleprompter/protocol/crypto-provider-libsodium";
import { blake2b } from "blakejs";
import { createNativeCryptoProvider } from "./crypto-provider-native";

let sodiumProvider: Awaited<ReturnType<typeof createLibsodiumProvider>>;

beforeAll(async () => {
  sodiumProvider = await createLibsodiumProvider();
});

afterAll(() => {
  // KDF tests mutate the protocol module's provider factory (module state,
  // not the module registry) — restore the true default for later test files.
  protocolClient.__setCryptoProviderFactory(createLibsodiumProvider);
});

// ── RNQC mock ────────────────────────────────────────────────────────────────

// X25519 raw↔DER framing: pkcs8 private = prefix ‖ raw32, spki public = prefix ‖ raw32.
const PKCS8_X25519_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function makeMockRnqc() {
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  const s = () => sodiumProvider;

  return {
    randomBytes(n: number) {
      return Buffer.from(s().randomBytes(n));
    },

    // Provider calls publicKey/privateKey.export({ format: "raw-..." }).
    generateKeyPairSync(_type: string) {
      const kp = s().kxKeypair();
      return {
        publicKey: {
          export(_opts: object) {
            return Buffer.from(kp.publicKey);
          },
        },
        privateKey: {
          export(_opts: object) {
            return Buffer.from(kp.secretKey);
          },
        },
      };
    },

    // Provider passes RAW 32-byte keys (format: "raw-private"/"raw-public").
    // Node has no raw import for X25519, so wrap them in fixed DER prefixes.
    diffieHellman(opts: {
      privateKey: {
        key: ArrayBuffer;
        format: string;
        asymmetricKeyType: string;
      };
      publicKey: {
        key: ArrayBuffer;
        format: string;
        asymmetricKeyType: string;
      };
    }) {
      const privateKey = nodeCrypto.createPrivateKey({
        key: Buffer.concat([
          PKCS8_X25519_PREFIX,
          Buffer.from(opts.privateKey.key),
        ]),
        format: "der",
        type: "pkcs8",
      });
      const publicKey = nodeCrypto.createPublicKey({
        key: Buffer.concat([
          SPKI_X25519_PREFIX,
          Buffer.from(opts.publicKey.key),
        ]),
        format: "der",
        type: "spki",
      });
      return nodeCrypto.diffieHellman({ privateKey, publicKey });
    },

    // Bun's node:crypto lacks xchacha20-poly1305 — back the cipher mock with
    // libsodium's combined-output AEAD and split/store the tag ourselves.
    // Call order in the provider: setAAD? → update → final → getAuthTag.
    createCipheriv(
      _algorithm: string,
      key: Uint8Array,
      nonce: Uint8Array,
      _opts: object,
    ) {
      let aad: Uint8Array | null = null;
      let tag: Buffer | null = null;
      return {
        setAAD(a: Uint8Array) {
          aad = new Uint8Array(a);
          return this;
        },
        update(plaintext: Uint8Array) {
          const combined = s().aeadEncrypt(
            new Uint8Array(plaintext),
            aad,
            new Uint8Array(nonce),
            new Uint8Array(key),
          );
          tag = Buffer.from(combined.subarray(combined.length - 16));
          return Buffer.from(combined.subarray(0, combined.length - 16));
        },
        final() {
          return Buffer.alloc(0);
        },
        getAuthTag() {
          if (!tag) {
            throw new Error("mock cipher: getAuthTag before update");
          }
          return tag;
        },
      };
    },

    // Call order in the provider: setAuthTag → setAAD? → update → final.
    // Authentication happens inside update (libsodium verifies the tag there).
    createDecipheriv(
      _algorithm: string,
      key: Uint8Array,
      nonce: Uint8Array,
      _opts: object,
    ) {
      let aad: Uint8Array | null = null;
      let tag: Uint8Array | null = null;
      return {
        setAuthTag(t: Uint8Array) {
          tag = new Uint8Array(t);
          return this;
        },
        setAAD(a: Uint8Array) {
          aad = new Uint8Array(a);
          return this;
        },
        update(ct: Uint8Array) {
          if (!tag) {
            throw new Error("mock decipher: update before setAuthTag");
          }
          const combined = new Uint8Array(ct.length + tag.length);
          combined.set(new Uint8Array(ct), 0);
          combined.set(tag, ct.length);
          return Buffer.from(
            s().aeadDecrypt(
              combined,
              aad,
              new Uint8Array(nonce),
              new Uint8Array(key),
            ),
          );
        },
        final() {
          return Buffer.alloc(0);
        },
      };
    },
  };
}

// Registered once, process-wide. The callback runs lazily on the provider's
// first require("react-native-quick-crypto") — after beforeAll has resolved
// sodiumProvider.
mock.module("react-native-quick-crypto", () => makeMockRnqc());

// ── Helpers ───────────────────────────────────────────────────────────────────

function hex(u8: Uint8Array): string {
  return Buffer.from(u8).toString("hex");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("crypto-provider-native — kx session keys", () => {
  test("kxClientSessionKeys matches libsodium provider (rx and tx)", async () => {
    const clientKp = sodiumProvider.kxKeypair();
    const serverKp = sodiumProvider.kxKeypair();
    const native = await createNativeCryptoProvider();

    const nativeKeys = native.kxClientSessionKeys(
      clientKp.publicKey,
      clientKp.secretKey,
      serverKp.publicKey,
    );
    const libsodiumKeys = sodiumProvider.kxClientSessionKeys(
      clientKp.publicKey,
      clientKp.secretKey,
      serverKp.publicKey,
    );

    expect(hex(nativeKeys.rx)).toBe(hex(libsodiumKeys.rx));
    expect(hex(nativeKeys.tx)).toBe(hex(libsodiumKeys.tx));
  });

  test("kxServerSessionKeys matches libsodium provider (rx and tx)", async () => {
    const clientKp = sodiumProvider.kxKeypair();
    const serverKp = sodiumProvider.kxKeypair();
    const native = await createNativeCryptoProvider();

    const nativeKeys = native.kxServerSessionKeys(
      serverKp.publicKey,
      serverKp.secretKey,
      clientKp.publicKey,
    );
    const libsodiumKeys = sodiumProvider.kxServerSessionKeys(
      serverKp.publicKey,
      serverKp.secretKey,
      clientKp.publicKey,
    );

    expect(hex(nativeKeys.rx)).toBe(hex(libsodiumKeys.rx));
    expect(hex(nativeKeys.tx)).toBe(hex(libsodiumKeys.tx));
  });

  test("client rx == server tx and client tx == server rx (role symmetry)", async () => {
    const clientKp = sodiumProvider.kxKeypair();
    const serverKp = sodiumProvider.kxKeypair();
    const native = await createNativeCryptoProvider();

    const clientKeys = native.kxClientSessionKeys(
      clientKp.publicKey,
      clientKp.secretKey,
      serverKp.publicKey,
    );
    const serverKeys = native.kxServerSessionKeys(
      serverKp.publicKey,
      serverKp.secretKey,
      clientKp.publicKey,
    );

    expect(hex(clientKeys.rx)).toBe(hex(serverKeys.tx));
    expect(hex(clientKeys.tx)).toBe(hex(serverKeys.rx));
  });

  test("native kxKeypair interops with libsodium kx derivation", async () => {
    const native = await createNativeCryptoProvider();
    const clientKp = native.kxKeypair();
    const serverKp = sodiumProvider.kxKeypair();

    const nativeKeys = native.kxClientSessionKeys(
      clientKp.publicKey,
      clientKp.secretKey,
      serverKp.publicKey,
    );
    const libsodiumKeys = sodiumProvider.kxClientSessionKeys(
      clientKp.publicKey,
      clientKp.secretKey,
      serverKp.publicKey,
    );

    expect(hex(nativeKeys.rx)).toBe(hex(libsodiumKeys.rx));
    expect(hex(nativeKeys.tx)).toBe(hex(libsodiumKeys.tx));
  });
});

describe("crypto-provider-native — AEAD layout (ct‖tag combine/split)", () => {
  test("native encrypt → libsodium decrypt (aad=null)", async () => {
    const native = await createNativeCryptoProvider();
    const key = sodiumProvider.randomBytes(32);
    const nonce = sodiumProvider.randomBytes(24);
    const plaintext = new TextEncoder().encode("hello native → libsodium");

    const ct = native.aeadEncrypt(plaintext, null, nonce, key);
    const pt = sodiumProvider.aeadDecrypt(ct, null, nonce, key);

    expect(new TextDecoder().decode(pt)).toBe("hello native → libsodium");
  });

  test("native encrypt → libsodium decrypt (aad≠null)", async () => {
    const native = await createNativeCryptoProvider();
    const key = sodiumProvider.randomBytes(32);
    const nonce = sodiumProvider.randomBytes(24);
    const aad = new TextEncoder().encode("authenticated metadata");
    const plaintext = new TextEncoder().encode("hello with aad");

    const ct = native.aeadEncrypt(plaintext, aad, nonce, key);
    const pt = sodiumProvider.aeadDecrypt(ct, aad, nonce, key);

    expect(new TextDecoder().decode(pt)).toBe("hello with aad");
  });

  test("libsodium encrypt → native decrypt (aad=null)", async () => {
    const native = await createNativeCryptoProvider();
    const key = sodiumProvider.randomBytes(32);
    const nonce = sodiumProvider.randomBytes(24);
    const plaintext = new TextEncoder().encode("hello libsodium → native");

    const ct = sodiumProvider.aeadEncrypt(plaintext, null, nonce, key);
    const pt = native.aeadDecrypt(ct, null, nonce, key);

    expect(new TextDecoder().decode(pt)).toBe("hello libsodium → native");
  });

  test("libsodium encrypt → native decrypt (aad≠null)", async () => {
    const native = await createNativeCryptoProvider();
    const key = sodiumProvider.randomBytes(32);
    const nonce = sodiumProvider.randomBytes(24);
    const aad = new TextEncoder().encode("some additional data");
    const plaintext = new TextEncoder().encode("libsodium aad test");

    const ct = sodiumProvider.aeadEncrypt(plaintext, aad, nonce, key);
    const pt = native.aeadDecrypt(ct, aad, nonce, key);

    expect(new TextDecoder().decode(pt)).toBe("libsodium aad test");
  });
});

describe("crypto-provider-native — genericHash32 (BLAKE2b outlen=32)", () => {
  test("provider genericHash32 matches libsodium crypto_generichash(32, input)", async () => {
    const native = await createNativeCryptoProvider();
    const input = new TextEncoder().encode("test genericHash32 oracle");
    expect(hex(native.genericHash32(input))).toBe(
      hex(sodiumProvider.genericHash32(input)),
    );
  });

  test("blake2b(outlen=32) ≠ blake2b(outlen=64).slice(0,32) — the trap", () => {
    const input = new TextEncoder().encode("the blake2b outlen trap");
    const correct = blake2b(input, undefined, 32);
    const truncated = blake2b(input, undefined, 64).slice(0, 32);
    // These MUST differ — BLAKE2b folds outlen into its init parameter block.
    expect(hex(correct)).not.toBe(hex(truncated));
  });
});

describe("crypto-provider-native — KDF oracle (via __setCryptoProviderFactory)", () => {
  const { __setCryptoProviderFactory: setFactory } = protocolClient;

  test("deriveRelayToken matches libsodium provider", async () => {
    const secret = sodiumProvider.randomBytes(32);

    setFactory(createNativeCryptoProvider);
    const nativeToken = await protocolClient.deriveRelayToken(secret);

    setFactory(() => Promise.resolve(sodiumProvider));
    const libsodiumToken = await protocolClient.deriveRelayToken(secret);

    expect(nativeToken).toBe(libsodiumToken);
  });

  test("deriveKxKey matches libsodium provider", async () => {
    const secret = sodiumProvider.randomBytes(32);

    setFactory(createNativeCryptoProvider);
    const nativeKey = await protocolClient.deriveKxKey(secret);

    setFactory(() => Promise.resolve(sodiumProvider));
    const libsodiumKey = await protocolClient.deriveKxKey(secret);

    expect(hex(nativeKey)).toBe(hex(libsodiumKey));
  });

  test("deriveRegistrationProof matches libsodium provider", async () => {
    const secret = sodiumProvider.randomBytes(32);
    const daemonId = "daemon-test-id";

    setFactory(createNativeCryptoProvider);
    const nativeProof = await protocolClient.deriveRegistrationProof(
      secret,
      daemonId,
    );

    setFactory(() => Promise.resolve(sodiumProvider));
    const libsodiumProof = await protocolClient.deriveRegistrationProof(
      secret,
      daemonId,
    );

    expect(nativeProof).toBe(libsodiumProof);
  });

  test("ratchetSessionKeys matches libsodium provider (daemon role)", async () => {
    const baseKeys = {
      tx: sodiumProvider.randomBytes(32),
      rx: sodiumProvider.randomBytes(32),
    };
    const sessionId = "test-session-42";

    setFactory(createNativeCryptoProvider);
    const nativeRatchet = await protocolClient.ratchetSessionKeys(
      baseKeys,
      sessionId,
      "daemon",
    );

    setFactory(() => Promise.resolve(sodiumProvider));
    const libsodiumRatchet = await protocolClient.ratchetSessionKeys(
      baseKeys,
      sessionId,
      "daemon",
    );

    expect(hex(nativeRatchet.tx)).toBe(hex(libsodiumRatchet.tx));
    expect(hex(nativeRatchet.rx)).toBe(hex(libsodiumRatchet.rx));
  });

  test("ratchetSessionKeys matches libsodium provider (frontend role)", async () => {
    const baseKeys = {
      tx: sodiumProvider.randomBytes(32),
      rx: sodiumProvider.randomBytes(32),
    };
    const sessionId = "test-session-frontend";

    setFactory(createNativeCryptoProvider);
    const nativeRatchet = await protocolClient.ratchetSessionKeys(
      baseKeys,
      sessionId,
      "frontend",
    );

    setFactory(() => Promise.resolve(sodiumProvider));
    const libsodiumRatchet = await protocolClient.ratchetSessionKeys(
      baseKeys,
      sessionId,
      "frontend",
    );

    expect(hex(nativeRatchet.tx)).toBe(hex(libsodiumRatchet.tx));
    expect(hex(nativeRatchet.rx)).toBe(hex(libsodiumRatchet.rx));
  });
});

describe("crypto-provider-native — encoding helpers", () => {
  test("toBase64 (ORIGINAL) byte-matches libsodium incl. + and /", async () => {
    const native = await createNativeCryptoProvider();
    // 0xFB 0xFF produces + and / in standard base64
    const payload = new Uint8Array([0xfb, 0xff, 0x00, 0x01, 0xfe, 0xfd]);
    expect(native.toBase64(payload)).toBe(sodiumProvider.toBase64(payload));
  });

  test("toBase64 padding edges (len % 3 = 0, 1, 2) byte-match libsodium", async () => {
    const native = await createNativeCryptoProvider();
    for (let len = 0; len <= 8; len++) {
      const payload = sodiumProvider.randomBytes(len);
      expect(native.toBase64(payload)).toBe(sodiumProvider.toBase64(payload));
      expect(hex(native.fromBase64(native.toBase64(payload)))).toBe(
        hex(payload),
      );
    }
  });

  test("toBase64/fromBase64 handle large payloads (no stack overflow)", async () => {
    const native = await createNativeCryptoProvider();
    // ~200KB — the btoa(String.fromCharCode(...data)) idiom blows the call
    // stack at this size; the chunked codec must not.
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) {
      big[i] = (i * 31 + 7) & 0xff;
    }
    const encoded = native.toBase64(big);
    expect(encoded).toBe(sodiumProvider.toBase64(big));
    expect(hex(native.fromBase64(encoded))).toBe(hex(big));
  });

  test("fromBase64 decodes libsodium output and rejects invalid input", async () => {
    const native = await createNativeCryptoProvider();
    const payload = new Uint8Array([0xfb, 0xff, 0x00, 0x01, 0xfe, 0xfd]);
    const encoded = sodiumProvider.toBase64(payload);
    expect(hex(native.fromBase64(encoded))).toBe(hex(payload));
    expect(() => native.fromBase64("@@@@")).toThrow();
  });

  test("toHex byte-matches libsodium", async () => {
    const native = await createNativeCryptoProvider();
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(native.toHex(data)).toBe(sodiumProvider.toHex(data));
  });

  test("fromString/toString round-trip (UTF-8)", async () => {
    const native = await createNativeCryptoProvider();
    const str = "hello 世界 🎉";
    const bytes = native.fromString(str);
    expect(hex(bytes)).toBe(hex(sodiumProvider.fromString(str)));
    expect(native.toString(bytes)).toBe(str);
  });
});
