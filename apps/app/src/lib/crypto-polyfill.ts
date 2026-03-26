/**
 * Polyfill crypto.getRandomValues for Hermes (React Native).
 *
 * libsodium-wrappers-sumo checks `window.crypto` or `self.crypto` for
 * getRandomValues(). Hermes has neither `window` nor `self`, so we
 * install `self` as a global with a crypto object backed by expo-crypto's
 * native getRandomValues (SecRandomCopyBytes on iOS, SecureRandom on Android).
 *
 * Must be imported before any libsodium usage (i.e. at app entry point).
 */

import { getRandomValues } from "expo-crypto";

const g = globalThis as any;

// libsodium checks: `typeof window ? window : self`, then `.crypto.getRandomValues`
// On Hermes, `window` is undefined (typeof === 'string'), so it falls to `self`.
// We ensure `self.crypto.getRandomValues` exists.
if (typeof g.self === "undefined") {
  g.self = g;
}

if (typeof g.self.crypto === "undefined") {
  g.self.crypto = {};
}

if (typeof g.self.crypto.getRandomValues !== "function") {
  g.self.crypto.getRandomValues = getRandomValues;
}
