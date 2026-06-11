/**
 * Compile-time flag for the react-native-quick-crypto native CryptoProvider.
 *
 * When ON (true), apps/app/index.ts installs the RNQC-backed provider factory
 * at module-eval on native (Hermes) — before any route module loads, so the
 * factory is registered ahead of the first `ensureSodium()` call and
 * libsodium-wrappers (lazy-required inside its own factory) never evaluates
 * there. Web and bun:test keep libsodium-wrappers (WASM): the install is
 * gated on `Platform.OS !== "web"`.
 *
 * Cross-provider unit oracle: apps/app/src/lib/crypto-provider-native.test.ts.
 * On-device E2EE interop gate: docs/local-verification-queue.md Q11.
 *
 * The `as const` annotation lets the bundler (Metro + terser) dead-code-
 * eliminate the alternative path.
 */
export const USE_NATIVE_CRYPTO = true as const;
