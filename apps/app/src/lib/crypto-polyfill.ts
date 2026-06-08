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
 *
 * Unhandled rejection (the second half of the fix):
 * The console filter silences the two `err(...)` lines, but libsodium's
 * emscripten output ALSO leaks an unhandled promise rejection that never travels
 * through `console.error`. Its primary (native-wasm) module runs first and calls
 * an UNAWAITED `createWasm()` (`var wasmExports; createWasm(); run();`).
 * `createWasm() → instantiateArrayBuffer() → await WebAssembly.instantiate()`
 * hits our stub, whose `instantiate` rejects. The catch calls `abort(reason)`,
 * which first invokes `Module.onAbort` — that rejects the OUTER `Module.ready`
 * promise, whose `.catch(() => useBackupModule())` runs the wasm2js fallback so
 * crypto WORKS — but `abort()` then unconditionally does
 * `var e = new WebAssembly.RuntimeError(what); throw e`. That throw rejects the
 * fire-and-forget `createWasm()` promise, which nothing awaits, so Hermes (in
 * __DEV__) surfaces it via `HermesInternal.enablePromiseRejectionTracker`'s
 * `onUnhandled` → ExceptionsManager → LogBox:
 *   Uncaught (in promise): "WebAssembly.RuntimeError: Aborted(Error: WebAssembly
 *   is not available on this runtime). Build with -sASSERTIONS for more info."
 *
 * This rejection is structurally unavoidable by reshaping `globalThis.WebAssembly`
 * (all empirically disproved against the real libsodium module): the primary
 * module's `Module` is libsodium's own exports object (not `globalThis.Module`,
 * so we cannot inject `Module.instantiateWasm`); making `instantiate` never
 * settle HANGS crypto (`Module.ready` never falls through to wasm2js); and
 * `abort()`'s `throw` is unconditional. Removing the stub merely swaps the named
 * `WebAssembly.RuntimeError` for a `ReferenceError: WebAssembly is not defined`
 * — still unhandled. So we KEEP the stub (it pins the rejection to a known
 * name + message) and swallow EXACTLY that one rejection at the rejection
 * TRACKER, which is the only writable seam on this runtime.
 *
 * Why the tracker (and not the report sink): on React Native 0.85.3 New
 * Architecture, the entire report chain below the tracker is sealed behind
 * read-only native globals. `HermesInternal.enablePromiseRejectionTracker`'s
 * `onUnhandled` (installed by RN's `polyfillPromise`, then RE-installed by
 * `@expo/metro-runtime`'s `enablePromiseRejectionTracking` — last-call-wins)
 * calls `ExceptionsManager.handleException`, which gates its whole report path
 * (`console.error` + LogBox) behind `global.RN$handleException`. But
 * `RN$handleException` is defined by native C++ via
 * `defineReadOnlyGlobal` (`ReactInstance.cpp` → `Object.defineProperty` with
 * only `value`, i.e. non-writable + non-configurable), so a JS attempt to wrap
 * it is a silent no-op (the report still fires — verified on-device). Likewise
 * `HermesInternal.enablePromiseRejectionTracker` is a read-only host property,
 * so it cannot be REASSIGNED (doing so throws "Cannot assign to read-only
 * property" — also seen on-device).
 *
 * What IS allowed — and what Expo itself relies on — is CALLING
 * `enablePromiseRejectionTracker(options)` again: Hermes keeps a SINGLE tracker
 * hook, last-call-wins. `@expo/metro-runtime` runs in
 * `getModulesRunBeforeMainModule` (after RN's `InitializeCore`, before the app
 * entry), so by the time this module runs (`apps/app/index.ts` line 1) Expo's
 * tracker is already the live one. We re-register ONE more time, last, with an
 * `onUnhandled` that drops EXACTLY the libsodium-init rejection and delegates
 * every other rejection to a faithful copy of the default report
 * (`ExceptionsManager.handleException(new Error("Uncaught (in promise…)",
 * { cause: rejection }))`) — so genuine app rejections still surface in dev. In
 * a non-DEV build neither RN nor Expo registers a tracker, so our re-register is
 * a no-op; on non-Hermes runtimes there is no `enablePromiseRejectionTracker`,
 * so the block is skipped entirely.
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

// Boot marker — the first console output the app emits, from its first-evaluated
// module (apps/app/index.ts imports this before expo-router/entry). On-device
// console verification (expo-mcp verify_on_device) asserts this line is PRESENT
// in the post-reload capture window, proving the window actually observed the
// runtime's output rather than vacuously passing every "absent" signature. Cheap,
// dependency-free, and harmless in every runtime (Hermes / RN Web / Bun / Node).
console.log(
  `[tp-app boot] engine=${typeof gAny["HermesInternal"] !== "undefined" ? "hermes" : "other"} dev=${
    typeof gAny["__DEV__"] !== "undefined" ? Boolean(gAny["__DEV__"]) : "?"
  }`,
);

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

/**
 * True if a rejected value is the expected libsodium/emscripten init rejection
 * thrown by `abort()` on the no-WebAssembly (Hermes) path. Deliberately narrow:
 * it matches only the `WebAssembly.RuntimeError` whose message carries BOTH the
 * emscripten `Aborted(...)` wrapper AND the exact string our stub's `instantiate`
 * rejects with — so a genuine `WebAssembly.RuntimeError` (or any other rejection)
 * is never swallowed. Pinning the message is why the stub is kept rather than
 * removed.
 *
 * Exported for unit testing the predicate directly.
 */
export function isLibsodiumInitRejection(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  if (reason.name !== "WebAssembly.RuntimeError") return false;
  const msg = reason.message;
  return (
    typeof msg === "string" &&
    msg.includes("Aborted(") &&
    msg.includes("WebAssembly is not available on this runtime")
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

  // Swallow the single expected libsodium-init unhandled rejection (see header).
  //
  // Re-register the Hermes promise-rejection tracker, last, with an `onUnhandled`
  // that drops EXACTLY the libsodium-init rejection and delegates every other
  // rejection to a faithful copy of RN/Expo's default report. This is the one
  // writable seam: `enablePromiseRejectionTracker` is a read-only host PROPERTY
  // (cannot be reassigned) but a callable FUNCTION, and Hermes keeps a single
  // last-call-wins tracker hook — the exact mechanism `@expo/metro-runtime`
  // itself uses. Because that runs in `getModulesRunBeforeMainModule` (before the
  // app entry), our call here lands last and wins. See the header for why the
  // downstream `RN$handleException` sink is unusable (native read-only) on RN
  // 0.85.3 New Architecture.
  type RejectionTrackerOptions = {
    allRejections?: boolean;
    onUnhandled?: (id: number, rejection?: unknown) => void;
    onHandled?: (id: number) => void;
  };
  type HermesWithTracker = {
    hasPromise?: () => boolean;
    enablePromiseRejectionTracker?: (options: RejectionTrackerOptions) => void;
  };
  const hermes = gAny["HermesInternal"] as HermesWithTracker | undefined;
  // Guard: Hermes only, and only when a tracker exists (it is registered by RN /
  // Expo in __DEV__ — in production neither registers one, so this is a no-op and
  // there is nothing to filter). Mirrors the guards in
  // `react-native/Libraries/Core/polyfillPromise.js` and
  // `@expo/metro-runtime`'s `promiseRejectionTracking.native`.
  if (
    typeof hermes?.enablePromiseRejectionTracker === "function" &&
    hermes.hasPromise?.()
  ) {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id, rejection) => {
        // Drop EXACTLY the libsodium-init rejection; surface everything else.
        if (isLibsodiumInitRejection(rejection)) return;
        // Faithfully reproduce the default report so genuine rejections still
        // reach LogBox / the dev console. This is the same module Expo's tracker
        // uses (`@expo/metro-runtime`'s ExceptionsManager re-exports it), wrapping
        // the reason the same way (`new Error("Uncaught (in promise…)", {cause})`).
        try {
          // Deep import: this is the canonical RN exception sink and exactly what
          // Expo's own onUnhandled delegates to. Required because Hermes exposes
          // no getter for the previously-registered onUnhandled.
          const ExceptionsManager =
            require("react-native/Libraries/Core/ExceptionsManager") as {
              default?: {
                handleException?: (e: unknown, isFatal?: boolean) => void;
              };
              handleException?: (e: unknown, isFatal?: boolean) => void;
            };
          const handle =
            ExceptionsManager.default?.handleException ??
            ExceptionsManager.handleException;
          const prefix = `Uncaught (in promise, id: ${id})`;
          const message =
            rejection instanceof Error
              ? Error.prototype.toString.call(rejection)
              : String(rejection ?? "");
          const wrapped = new Error(`${prefix} ${message}`, {
            cause: rejection,
          });
          handle?.(wrapped, false);
        } catch {
          // If the RN exception sink is unavailable, fall back to console so a
          // genuine rejection is never fully lost. Goes through our filter, which
          // only drops the known libsodium-init noise.
          console.error(`Uncaught (in promise, id: ${id})`, rejection);
        }
      },
      onHandled: (id) => {
        console.warn(
          `Promise rejection handled (id: ${id})\n` +
            "This means you can ignore any previous messages of the form " +
            `"Uncaught (in promise, id: ${id})"`,
        );
      },
    });
  }
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
