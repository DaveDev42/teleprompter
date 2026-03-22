/**
 * Native crypto fallback for Hermes (iOS/Android).
 *
 * Hermes doesn't support WASM, so libsodium-wrappers won't work
 * on native platforms. This module provides a fallback strategy:
 *
 * Option 1 (current): Use Expo Crypto + WebCrypto polyfill
 * Option 2 (future): Use react-native-libsodium (Rust FFI)
 * Option 3 (future): Use react-native-quick-crypto (JSI)
 *
 * For now, the crypto module from @teleprompter/protocol works on:
 * - Web: libsodium-wrappers uses WASM ✓
 * - Bun: libsodium-wrappers uses WASM ✓
 * - Hermes: needs one of the alternatives below
 *
 * Strategy: On native platforms, we import react-native-quick-crypto
 * which provides a JSI-based crypto implementation that's compatible
 * with the Node.js crypto API. We can use it for:
 * - X25519 key exchange
 * - AES-256-GCM / ChaCha20-Poly1305 encryption
 * - BLAKE2b hashing
 *
 * Until react-native-quick-crypto or react-native-libsodium is
 * integrated, native crypto operations will throw an error directing
 * the user to use the web version.
 */

import { Platform } from "react-native";

export function isNativeCryptoAvailable(): boolean {
  // TODO: Check for react-native-quick-crypto or react-native-libsodium
  return Platform.OS === "web";
}

export function assertCryptoAvailable(): void {
  if (!isNativeCryptoAvailable()) {
    throw new Error(
      "E2EE is not yet available on native platforms. " +
        "Please use the web version for encrypted relay connections. " +
        "Native crypto support (via react-native-quick-crypto) is planned.",
    );
  }
}
