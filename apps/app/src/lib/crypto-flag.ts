/**
 * Compile-time flag for the react-native-quick-crypto native CryptoProvider.
 *
 * When OFF (false), the app continues using libsodium-wrappers on all
 * platforms (Hermes asm.js fallback on native, WASM on web/Bun).
 *
 * Flip to `true` only after on-device E2EE interop is verified PASS via the
 * cross-provider test (apps/app/src/lib/crypto-provider-native.test.ts).
 * Tracked in docs/local-verification-queue.md.
 *
 * The `as const` annotation lets the bundler (Metro + terser) dead-code-
 * eliminate the native path entirely while this flag is `false`.
 */
export const USE_NATIVE_CRYPTO = false as const;
