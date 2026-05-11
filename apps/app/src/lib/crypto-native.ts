/**
 * Native crypto availability check.
 *
 * libsodium-wrappers ships a Wasm2js polyfill, but in practice it can still
 * fail on some Hermes runtimes (iOS simulator on certain SDK versions) where
 * the embedded `new WebAssembly.Module(...)` shim aborts. We treat crypto as
 * a probe — call `checkCryptoAvailability()` early, surface the boolean to
 * the UI, and short-circuit features that require E2EE on failure rather
 * than letting the abort propagate as an unhandled rejection.
 *
 * Platform behavior:
 * - Web: libsodium uses native WASM (fast)
 * - Bun: libsodium uses native WASM (fast)
 * - Hermes (iOS/Android): libsodium uses bundled Wasm2js polyfill when
 *   available; if the runtime rejects it, this probe returns false.
 */

let _cryptoChecked = false;
let _cryptoAvailable = false;

/**
 * Check whether libsodium can initialize on the current platform.
 * Caches the result after first call. Must be called with `await` before
 * using E2EE functions.
 */
export async function checkCryptoAvailability(): Promise<boolean> {
  if (_cryptoChecked) return _cryptoAvailable;
  _cryptoChecked = true;

  try {
    const { ensureSodium } = await import("@teleprompter/protocol/client");
    await ensureSodium();
    _cryptoAvailable = true;
  } catch {
    _cryptoAvailable = false;
  }
  return _cryptoAvailable;
}

export function isNativeCryptoAvailable(): boolean {
  return _cryptoAvailable;
}

export async function assertCryptoAvailable(): Promise<void> {
  const available = await checkCryptoAvailability();
  if (!available) {
    throw new Error(
      "E2EE crypto failed to initialize on this platform. " +
        "libsodium asm.js fallback may not be supported on this runtime. " +
        "Please use the web version for encrypted relay connections.",
    );
  }
}
