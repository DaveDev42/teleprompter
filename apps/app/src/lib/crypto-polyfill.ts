/**
 * Polyfill crypto.getRandomValues for Hermes (React Native).
 *
 * libsodium-wrappers checks `window.crypto` or `self.crypto` for
 * getRandomValues(). Hermes has neither `window` nor `self`, so we
 * install `self` as a global with a crypto object backed by expo-crypto's
 * native getRandomValues (SecRandomCopyBytes on iOS, SecureRandom on Android).
 *
 * Must be imported before any libsodium usage (i.e. at app entry point).
 *
 * WebAssembly stub (Hermes):
 * Hermes does not expose a global `WebAssembly` object.  libsodium's compiled
 * output (libsodium/dist/modules/libsodium.js) tries `WebAssembly.instantiate`
 * first — without a `typeof` guard — which throws a bare ReferenceError on
 * Hermes, causing two console.error lines before the wasm2js fallback kicks in.
 * We define a minimal stub so the reference resolves to an object rather than
 * throwing, which lets the try/catch inside libsodium's `instantiateArrayBuffer`
 * handle the rejection cleanly and silently.
 */

import { getRandomValues } from "expo-crypto";

interface GlobalWithCrypto {
  self?: {
    crypto?: {
      getRandomValues?: typeof getRandomValues;
    };
  };
}

// ── WebAssembly stub for Hermes ──────────────────────────────────────────────
// Must run before any libsodium require so the global is set when the module
// initialises.  Only installed when the runtime has no native WebAssembly
// (i.e. Hermes).  On RN Web / Bun / Node the real WebAssembly is present and
// this block is skipped entirely.
interface MinimalWebAssembly {
  instantiate: (
    bytes: unknown,
    imports?: unknown,
  ) => Promise<{ instance: unknown }>;
  Module: new (bytes: unknown) => unknown;
  Instance: new (mod: unknown, imports?: unknown) => unknown;
  Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
  RuntimeError: new (message?: string) => Error;
}

const gAny = globalThis as Record<string, unknown>;
if (typeof gAny["WebAssembly"] === "undefined") {
  const stub: MinimalWebAssembly = {
    // Returning a rejected Promise lets libsodium's try/catch in
    // `instantiateArrayBuffer` catch the failure without a synchronous throw.
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
    // Subclass Error so `new WebAssembly.RuntimeError(...)` inside libsodium's
    // `abort()` produces a real Error instance rather than throwing a second
    // ReferenceError when WebAssembly itself is undefined.
    RuntimeError: class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = "WebAssembly.RuntimeError";
      }
    },
  };
  gAny["WebAssembly"] = stub;
}

// ── self.crypto.getRandomValues polyfill ─────────────────────────────────────
const g = globalThis as unknown as GlobalWithCrypto;

// libsodium checks: `typeof window === 'object' ? window : self`, then `.crypto.getRandomValues`
// On Hermes, `window` is not defined, so it falls through to `self`.
// We ensure `self.crypto.getRandomValues` exists.
if (typeof g.self === "undefined") {
  g.self = g as NonNullable<GlobalWithCrypto["self"]>;
}

const self = g.self as NonNullable<GlobalWithCrypto["self"]>;

if (typeof self.crypto === "undefined") {
  self.crypto = {};
}

const crypto = self.crypto as NonNullable<(typeof self)["crypto"]>;

if (typeof crypto.getRandomValues !== "function") {
  crypto.getRandomValues = getRandomValues;
}
