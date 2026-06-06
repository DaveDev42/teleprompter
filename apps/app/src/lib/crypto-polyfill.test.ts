/**
 * Unit tests for crypto-polyfill.ts.
 *
 * crypto-polyfill installs (only on Hermes — runtimes with no native
 * WebAssembly):
 *   1. `self.crypto.getRandomValues` — for Hermes, which has neither `window`
 *      nor `self`.
 *   2. A narrow `console.error` / `console.warn` filter that drops libsodium's
 *      expected wasm2js init noise and forwards everything else verbatim. This
 *      is the primary fix for the recurring "failed to asynchronously prepare
 *      wasm" / "Aborted(...)" lines, and it must wrap console BEFORE libsodium
 *      is required (libsodium binds `console.error.bind(console)` at eval time).
 *   3. A minimal `globalThis.WebAssembly` stub (defense-in-depth) so any code
 *      reaching for the global resolves to an object instead of throwing.
 *
 * We stub `expo-crypto.getRandomValues` so the side-effectful module can be
 * imported under Bun, then assert all polyfills behave correctly.
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
// test file runs. Bun provides `self`, `crypto`, and `WebAssembly` on
// globalThis already.  To exercise the "bare Hermes" branches we hide them
// before importing the polyfill, then restore them afterwards.
const g = globalThis as unknown as {
  self?: unknown;
  crypto?: unknown;
  WebAssembly?: unknown;
};
const originalSelf = g.self;
const originalCrypto = g.crypto;
const originalWebAssembly = g.WebAssembly;
// The polyfill wraps console.error / console.warn on the Hermes path; snapshot
// so the side effect can be undone for other test files sharing this vm.
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

describe("crypto-polyfill", () => {
  beforeAll(async () => {
    // Simulate Hermes: no `self`, no `crypto`, no `WebAssembly`.
    delete (g as { self?: unknown }).self;
    delete (g as { crypto?: unknown }).crypto;
    delete (g as { WebAssembly?: unknown }).WebAssembly;
    expoCalls = 0;
    // Side-effectful import — installs `self.crypto.getRandomValues`, the
    // console init-noise filter, and the WebAssembly stub.
    await import("./crypto-polyfill?fresh=1");
  });

  afterAll(() => {
    g.self = originalSelf;
    g.crypto = originalCrypto;
    g.WebAssembly = originalWebAssembly;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
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

  // ── console init-noise filter (the primary fix) ────────────────────────────
  // The Hermes branch in beforeAll deleted globalThis.WebAssembly before import,
  // so the polyfill installed its console.error / console.warn filter. We test
  // the real exported predicate (the same function the live filter uses) for
  // exactly which lines it classifies as noise.

  test("predicate flags the two emscripten init-noise lines", async () => {
    const { isLibsodiumInitNoise } = await import("./crypto-polyfill?fresh=1");
    expect(
      isLibsodiumInitNoise([
        "failed to asynchronously prepare wasm: ReferenceError: x",
      ]),
    ).toBe(true);
    expect(
      isLibsodiumInitNoise([
        "Aborted(TypeError). Build with -sASSERTIONS for more info.",
      ]),
    ).toBe(true);
    expect(
      isLibsodiumInitNoise(["Build with -sASSERTIONS for more info."]),
    ).toBe(true);
  });

  test("predicate does NOT flag genuine errors or non-string args", async () => {
    const { isLibsodiumInitNoise } = await import("./crypto-polyfill?fresh=1");
    expect(isLibsodiumInitNoise(["a genuine application error"])).toBe(false);
    expect(isLibsodiumInitNoise(["TypeError: cannot read property x"])).toBe(
      false,
    );
    expect(isLibsodiumInitNoise([{ not: "a string" }])).toBe(false);
    expect(isLibsodiumInitNoise([])).toBe(false);
  });

  test("installed console.error tolerates a noise line without throwing", () => {
    // The live filter is installed (Hermes branch ran). Feeding it a noise line
    // must be a no-op (dropped), not an exception.
    expect(typeof console.error).toBe("function");
    expect(() =>
      console.error("failed to asynchronously prepare wasm: ReferenceError: x"),
    ).not.toThrow();
  });
});

// ── WebAssembly stub (Hermes simulation) ──────────────────────────────────────
//
// The stub is only installed when globalThis.WebAssembly is absent (Hermes).
// In Bun/Node/Web the native WebAssembly object is already present, so the
// polyfill skips the installation and we verify the stub's shape directly
// (without relying on it being wired into globalThis on this platform).

// Build the stub directly (same code as the polyfill) for white-box testing.
const stubForTest = {
  instantiate: (_bytes: unknown, _imports?: unknown) =>
    Promise.reject(new Error("WebAssembly is not available on this runtime")),
  Module: class {} as new (bytes: unknown) => unknown,
  Instance: class {} as new (mod: unknown, imports?: unknown) => unknown,
  Memory: class {
    buffer: ArrayBuffer;
    constructor(descriptor: { initial: number }) {
      this.buffer = new ArrayBuffer(descriptor.initial * 65536);
    }
  },
  RuntimeError: class extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "WebAssembly.RuntimeError";
    }
  },
};

describe("crypto-polyfill WebAssembly stub shape", () => {
  test("stub.instantiate returns a rejected Promise (no synchronous throw)", async () => {
    let caught: unknown = null;
    await stubForTest.instantiate(new Uint8Array([0]), {}).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("WebAssembly is not available");
  });

  test("stub.RuntimeError is newable and extends Error", () => {
    const err = new stubForTest.RuntimeError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test message");
    expect(err.name).toBe("WebAssembly.RuntimeError");
  });

  test("stub.Memory allocates a buffer of the requested page count", () => {
    const mem = new stubForTest.Memory({ initial: 2 }); // 2 pages = 128 KiB
    expect(mem.buffer).toBeInstanceOf(ArrayBuffer);
    expect(mem.buffer.byteLength).toBe(2 * 65536);
  });

  test("globalThis.WebAssembly is defined after polyfill import (stub or native)", () => {
    // Either the native WebAssembly (Bun/Node/Web) or our stub must be present
    // after the polyfill side-effects have run.
    expect(typeof globalThis.WebAssembly).toBe("object");
    expect(globalThis.WebAssembly).not.toBeNull();
  });
});
