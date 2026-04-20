/**
 * Unit tests for crypto-native.ts.
 *
 * crypto-native.ts is a thin wrapper around `ensureSodium()` from
 * `@teleprompter/protocol/client` that caches the availability result. Under
 * Bun, libsodium-wrappers-sumo initializes successfully (WASM path), so the
 * real happy-path is exercised. A separate describe block loads a stub
 * protocol module to verify the failure/caching path.
 */

import { describe, expect, mock, test } from "bun:test";

describe("crypto-native (libsodium available)", () => {
  test("checkCryptoAvailability resolves true on Bun", async () => {
    const { checkCryptoAvailability } = await import("./crypto-native");
    expect(await checkCryptoAvailability()).toBe(true);
  });

  test("isNativeCryptoAvailable reflects cached success", async () => {
    const { checkCryptoAvailability, isNativeCryptoAvailable } = await import(
      "./crypto-native"
    );
    await checkCryptoAvailability();
    expect(isNativeCryptoAvailable()).toBe(true);
  });

  test("assertCryptoAvailable does not throw when available", async () => {
    const { assertCryptoAvailable } = await import("./crypto-native");
    await expect(assertCryptoAvailable()).resolves.toBeUndefined();
  });

  test("checkCryptoAvailability is memoized (ensureSodium called once)", async () => {
    // Re-import via cache-buster so the module-level `_cryptoChecked` starts
    // false inside this isolated copy, then call check twice and assert the
    // stubbed ensureSodium ran exactly once.
    let calls = 0;
    mock.module("@teleprompter/protocol/client", () => ({
      ensureSodium: async () => {
        calls += 1;
      },
    }));
    const { checkCryptoAvailability } = await import("./crypto-native?memo=1");
    await checkCryptoAvailability();
    await checkCryptoAvailability();
    expect(calls).toBe(1);
  });
});

describe("crypto-native (libsodium unavailable)", () => {
  test("checkCryptoAvailability returns false when ensureSodium throws", async () => {
    mock.module("@teleprompter/protocol/client", () => ({
      ensureSodium: async () => {
        throw new Error("no wasm, no asm.js");
      },
    }));
    const { checkCryptoAvailability, isNativeCryptoAvailable } = await import(
      "./crypto-native?unavail=1"
    );
    expect(await checkCryptoAvailability()).toBe(false);
    expect(isNativeCryptoAvailable()).toBe(false);
  });

  test("assertCryptoAvailable throws a descriptive error when unavailable", async () => {
    mock.module("@teleprompter/protocol/client", () => ({
      ensureSodium: async () => {
        throw new Error("boom");
      },
    }));
    const { assertCryptoAvailable } = await import("./crypto-native?unavail=2");
    await expect(assertCryptoAvailable()).rejects.toThrow(
      /E2EE crypto failed to initialize/,
    );
  });
});
