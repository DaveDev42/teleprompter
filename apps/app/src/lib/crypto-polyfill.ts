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
 * libsodium init noise (Hermes / React Native):
 * On Hermes there is no usable WebAssembly, so libsodium initialises via its
 * bundled wasm2js fallback. The fallback works perfectly (ECDH, XChaCha20,
 * BLAKE2b all function), but emscripten's error path still fires during init
 * and emits two lines to the native console on every launch:
 *
 *   failed to asynchronously prepare wasm: ReferenceError: ... / TypeError: ...
 *   Aborted(...). Build with -sASSERTIONS for more info.
 *
 * These come from emscripten's internal `err` helper, which libsodium captures
 * as `console.error.bind(console)` at module-eval time:
 *
 *   var err = console.error.bind(console);   // bound ONCE, at module load
 *
 * That binding is why an earlier attempt to silence the noise by reassigning
 * `console.error` *after* requiring libsodium had no effect — libsodium had
 * already captured the original reference. It also uses a module-LOCAL
 * `WebAssembly` (wasm2js shim), so polyfilling `globalThis.WebAssembly` never
 * reaches the code that logs.
 *
 * The robust fix is to install a narrow filter ON `console.error` /
 * `console.warn` BEFORE libsodium is ever required (this module is the first
 * import at the app entry point, and libsodium is required lazily on the first
 * `ensureSodium()` call, which is necessarily later). When libsodium does
 * `console.error.bind(console)` it binds our filter, so every emscripten emit —
 * regardless of which internal path produces it — passes through the predicate.
 * The filter drops ONLY the known init-noise lines and forwards everything else
 * untouched, so real errors are never hidden. It is installed only on runtimes
 * without a native WebAssembly (Hermes); RN Web / Bun / Node keep console as-is.
 */

import { getRandomValues } from "expo-crypto";

interface GlobalWithCrypto {
  self?: {
    crypto?: {
      getRandomValues?: typeof getRandomValues;
    };
  };
}

// ── libsodium init-noise filter (Hermes) ─────────────────────────────────────
// Installed BEFORE libsodium is ever required so that when libsodium's compiled
// output runs `var err = console.error.bind(console)` at module-eval time, it
// binds our filter rather than the raw console.error. The filter drops only the
// two known emscripten init lines and forwards everything else verbatim. Only
// runtimes without a native WebAssembly (Hermes) take this path; RN Web / Bun /
// Node have real WebAssembly, init succeeds quietly, and console is untouched.
const gAny = globalThis as Record<string, unknown>;

/**
 * True if a console line is libsodium/emscripten's expected wasm-init noise on
 * a runtime that falls back to wasm2js. Deliberately specific — it matches the
 * two emscripten emit strings (and nothing else) so genuine errors still log.
 *
 * Exported for unit testing the predicate directly; the module's side effect is
 * what actually installs the filter.
 */
export function isLibsodiumInitNoise(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== "string") return false;
  return (
    first.includes("failed to asynchronously prepare wasm") ||
    // emscripten abort(): "Aborted(<reason>). Build with -sASSERTIONS ..."
    first.startsWith("Aborted(") ||
    first.includes("Build with -sASSERTIONS")
  );
}

if (typeof gAny["WebAssembly"] === "undefined") {
  // Filter console.error / console.warn (emscripten uses console.error for err;
  // we also guard warn defensively in case a build routes there).
  const wrap = (orig: (...a: unknown[]) => void) =>
    function filtered(this: unknown, ...args: unknown[]): void {
      if (isLibsodiumInitNoise(args)) return;
      orig.apply(this, args);
    };
  console.error = wrap(console.error.bind(console));
  console.warn = wrap(console.warn.bind(console));

  // Defense-in-depth: also provide a minimal global WebAssembly so any code path
  // that does reach for `globalThis.WebAssembly` (rather than libsodium's local
  // shim) resolves to an object instead of throwing a bare ReferenceError. The
  // console filter above is the primary mechanism; this is a belt-and-braces
  // fallback that costs nothing.
  gAny["WebAssembly"] = {
    instantiate: (_bytes: unknown, _imports?: unknown) =>
      Promise.reject(new Error("WebAssembly is not available on this runtime")),
    Module: class {},
    Instance: class {},
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
