/**
 * Native crypto availability for all platforms.
 *
 * libsodium-wrappers includes a JS-based WebAssembly polyfill
 * (asm.js fallback) that works on Hermes without native WASM support.
 * This means E2EE crypto is available on all platforms including
 * iOS/Android via Expo Go — no custom native modules required.
 *
 * Platform behavior:
 * - Web: libsodium uses WASM (fast)
 * - Bun: libsodium uses WASM (fast)
 * - Hermes (iOS/Android): libsodium uses asm.js polyfill (slower but functional)
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
