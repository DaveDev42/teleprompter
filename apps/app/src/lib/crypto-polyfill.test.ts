/**
 * Unit tests for crypto-polyfill.ts.
 *
 * crypto-polyfill installs `self.crypto.getRandomValues` for Hermes, which
 * has neither `window` nor `self`. We stub `expo-crypto.getRandomValues` so
 * the side-effectful module can be imported under Bun, then assert the
 * polyfill wires the stub onto `self.crypto` and still produces entropy.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Track calls into the stubbed getRandomValues so we can assert the polyfill
// actually delegates to expo-crypto when installed on a bare host.
let expoCalls = 0;

function stubGetRandomValues<T extends ArrayBufferView | null>(buf: T): T {
  expoCalls += 1;
  if (buf && ArrayBuffer.isView(buf)) {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    // Fill with non-zero bytes so the entropy sanity check passes.
    for (let i = 0; i < bytes.length; i++) {
      // deterministic-but-nonzero pseudo-random pattern
      bytes[i] = (i * 131 + 7) & 0xff;
    }
  }
  return buf;
}

mock.module("expo-crypto", () => ({ getRandomValues: stubGetRandomValues }));

// Snapshot globals so the polyfill's side effects can be undone after the
// test file runs. Bun provides `self` and `crypto` on globalThis already, so
// to actually exercise the "bare Hermes" branches we have to hide them.
const g = globalThis as unknown as {
  self?: unknown;
  crypto?: unknown;
};
const originalSelf = g.self;
const originalCrypto = g.crypto;

describe("crypto-polyfill", () => {
  beforeAll(async () => {
    // Simulate Hermes: no `self`, no `crypto`.
    delete (g as { self?: unknown }).self;
    delete (g as { crypto?: unknown }).crypto;
    expoCalls = 0;
    // Side-effectful import — installs `self.crypto.getRandomValues`.
    await import("./crypto-polyfill?fresh=1");
  });

  afterAll(() => {
    g.self = originalSelf;
    g.crypto = originalCrypto;
  });

  test("installs self global", () => {
    expect(typeof g.self).toBe("object");
  });

  test("installs self.crypto with a getRandomValues function", () => {
    const self = g.self as { crypto?: { getRandomValues?: unknown } };
    expect(typeof self.crypto).toBe("object");
    expect(typeof self.crypto?.getRandomValues).toBe("function");
  });

  test("self.crypto.getRandomValues fills a Uint8Array via expo-crypto", () => {
    const self = g.self as {
      crypto: {
        getRandomValues: <T extends ArrayBufferView>(buf: T) => T;
      };
    };
    const buf = new Uint8Array(32);
    const before = expoCalls;
    const result = self.crypto.getRandomValues(buf);
    expect(result).toBe(buf); // in-place fill, returns the same view
    expect(buf.length).toBe(32);
    // Entropy sanity: at least one non-zero byte (stub guarantees this).
    expect(buf.some((b) => b !== 0)).toBe(true);
    // Delegated to the stubbed expo-crypto.
    expect(expoCalls).toBe(before + 1);
  });

  test("fills larger buffers without truncating", () => {
    const self = g.self as {
      crypto: {
        getRandomValues: <T extends ArrayBufferView>(buf: T) => T;
      };
    };
    const buf = new Uint8Array(4096);
    self.crypto.getRandomValues(buf);
    expect(buf.length).toBe(4096);
    // Count non-zero bytes — stub fills every byte with (i*131+7) & 0xff which
    // is zero only when i*131+7 ≡ 0 (mod 256). Should be >99% non-zero.
    const nonZero = buf.reduce((acc, b) => acc + (b !== 0 ? 1 : 0), 0);
    expect(nonZero).toBeGreaterThan(buf.length * 0.9);
  });

  test("re-import is idempotent — does not clobber an existing getRandomValues", async () => {
    const self = g.self as {
      crypto: { getRandomValues: unknown };
    };
    const installed = self.crypto.getRandomValues;
    await import("./crypto-polyfill?fresh=2");
    // The polyfill only installs when the function is missing, so the
    // previously-installed reference must be preserved.
    expect(self.crypto.getRandomValues).toBe(installed);
  });
});
