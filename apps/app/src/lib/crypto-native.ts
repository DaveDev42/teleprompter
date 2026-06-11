/**
 * Crypto availability probe.
 *
 * `ensureSodium()` resolves whichever CryptoProvider is installed — the
 * react-native-quick-crypto provider on native Hermes (see apps/app/index.ts
 * and crypto-flag.ts), libsodium-wrappers (WASM) on web/Bun. Init can still
 * fail (e.g. a broken native module install), so we treat crypto as a probe —
 * call `checkCryptoAvailability()` early, surface the boolean to the UI, and
 * short-circuit features that require E2EE on failure rather than letting the
 * init error propagate as an unhandled rejection.
 */

let _cryptoChecked = false;
let _cryptoAvailable = false;

/**
 * Check whether the active CryptoProvider can initialize on the current
 * platform. Caches the result after first call. Must be called with `await`
 * before using E2EE functions.
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
        "The active crypto provider (react-native-quick-crypto on native, " +
        "libsodium on web) could not be initialized.",
    );
  }
}
