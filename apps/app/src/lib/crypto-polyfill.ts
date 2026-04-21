/**
 * Polyfill crypto.getRandomValues for Hermes (React Native).
 *
 * libsodium-wrappers checks `window.crypto` or `self.crypto` for
 * getRandomValues(). Hermes has neither `window` nor `self`, so we
 * install `self` as a global with a crypto object backed by expo-crypto's
 * native getRandomValues (SecRandomCopyBytes on iOS, SecureRandom on Android).
 *
 * Must be imported before any libsodium usage (i.e. at app entry point).
 */

import { getRandomValues } from "expo-crypto";

interface GlobalWithCrypto {
  self?: {
    crypto?: {
      getRandomValues?: typeof getRandomValues;
    };
  };
}

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
