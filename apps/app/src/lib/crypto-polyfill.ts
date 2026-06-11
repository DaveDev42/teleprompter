/**
 * App boot shims — boot marker + crypto.getRandomValues polyfill.
 *
 * This module is the FIRST import in apps/app/index.ts, so it runs before any
 * other app code on every runtime (Hermes / RN Web / Bun / Node).
 *
 * History: this file used to carry the libsodium wasm2js Hermes workarounds
 * (console init-noise filter, WebAssembly stub, Hermes promise-rejection-
 * tracker re-registration — PRs #577 / #591). They became dead the moment the
 * native CryptoProvider (react-native-quick-crypto) was enabled: index.ts
 * installs the provider factory at module-eval, before the first
 * `ensureSodium()` call, and libsodium-wrappers is lazy-required inside its
 * own factory — so it never evaluates on Hermes and its init noise can no
 * longer fire. libsodium remains the provider on web/Bun, where native
 * WebAssembly initializes it quietly.
 */

import { getRandomValues } from "expo-crypto";

interface GlobalWithCrypto {
  self?: {
    crypto?: {
      getRandomValues?: typeof getRandomValues;
    };
  };
}

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

// ── self.crypto.getRandomValues polyfill ─────────────────────────────────────
// Hermes has neither `window` nor `self`; install `self.crypto.getRandomValues`
// backed by expo-crypto's native RNG (SecRandomCopyBytes on iOS, SecureRandom
// on Android) so any code that reaches for the WebCrypto RNG keeps working.
// The E2EE provider itself uses react-native-quick-crypto's randomBytes on
// native; this shim covers runtimes where libsodium still runs (web has a real
// `self.crypto` already) and any third-party code expecting the global.
const g = globalThis as unknown as GlobalWithCrypto;

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
