// NOTE: crypto-polyfill MUST be imported first — it emits the `[tp-app boot]`
// marker (asserted by on-device console verification, expo-mcp
// verify_on_device) and installs the `self.crypto.getRandomValues` polyfill
// before anything else runs.
import "./src/lib/crypto-polyfill";

import { __setCryptoProviderFactory } from "@teleprompter/protocol/client";
// Native CryptoProvider (react-native-quick-crypto). This runs at module-eval,
// BEFORE expo-router loads any route module, so the factory is registered
// ahead of the first ensureSodium() call — libsodium-wrappers (lazy-required
// inside its own factory) therefore never evaluates on Hermes. RN Web and
// bun:test keep libsodium (WASM) via the Platform.OS gate.
import { Platform } from "react-native";
import { USE_NATIVE_CRYPTO } from "./src/lib/crypto-flag";
import { createNativeCryptoProvider } from "./src/lib/crypto-provider-native";

if (Platform.OS !== "web" && USE_NATIVE_CRYPTO) {
  __setCryptoProviderFactory(createNativeCryptoProvider);
}

import "expo-router/entry";
