// NOTE: crypto-polyfill MUST be imported first — it installs the
// `self.crypto.getRandomValues` polyfill that libsodium-wrappers requires
// on Hermes. Do not move this import below any other module that might
// transitively import libsodium-wrappers.
import "./src/lib/crypto-polyfill";

import { __setCryptoProviderFactory } from "@teleprompter/protocol/client";
// Native CryptoProvider (react-native-quick-crypto) — guarded by a
// compile-time flag (default OFF) so the RN Web path and bun:test are
// completely unaffected. When the flag is true, this runs BEFORE expo-router
// loads any route module so the factory is registered before the first
// ensureSodium() call.
import { Platform } from "react-native";
import { USE_NATIVE_CRYPTO } from "./src/lib/crypto-flag";
import { createNativeCryptoProvider } from "./src/lib/crypto-provider-native";

if (Platform.OS !== "web" && USE_NATIVE_CRYPTO) {
  __setCryptoProviderFactory(createNativeCryptoProvider);
}

import "expo-router/entry";
