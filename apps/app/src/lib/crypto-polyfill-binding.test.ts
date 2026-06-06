/**
 * Regression guard for the libsodium init-noise fix.
 *
 * The bug: libsodium's emscripten output binds its error sink ONCE, at
 * module-eval time, as `console.error.bind(console)`. An earlier fix tried to
 * silence the noise by reassigning `console.error` *after* requiring libsodium,
 * which had no effect — the bound reference still pointed at the original
 * console.error.
 *
 * The fix: crypto-polyfill.ts wraps `console.error` BEFORE libsodium is ever
 * required (it is the first import at the app entry point). This test proves the
 * end-to-end property: the polyfill's filter drops the two emscripten init lines
 * but forwards every genuine error to the downstream console it captured at
 * install time.
 *
 * We arrange the downstream to be a SPY by replacing console.error /
 * console.warn with capturing functions BEFORE importing the polyfill — so the
 * polyfill's `wrap(console.error.bind(console))` binds our spies as its
 * forwarding target. Then noise must be dropped (spy not called) and real
 * errors must be forwarded (spy called).
 *
 * This file mutates global console + WebAssembly, so it is isolated in its own
 * test file per the repo's global-mutation isolation rule.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView | null>(buf: T): T => buf,
}));

const g = globalThis as unknown as {
  self?: unknown;
  crypto?: unknown;
  WebAssembly?: unknown;
};
const originalSelf = g.self;
const originalCrypto = g.crypto;
const originalWebAssembly = g.WebAssembly;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

// Downstream spies — the polyfill's filter will forward through these because
// they are the current console.error / console.warn at the moment the polyfill
// captures them via `.bind(console)`.
const errorForwarded: unknown[][] = [];
const warnForwarded: unknown[][] = [];

describe("crypto-polyfill init-noise filter (end-to-end forwarding)", () => {
  beforeAll(async () => {
    // Simulate Hermes so the filter installs.
    delete (g as { self?: unknown }).self;
    delete (g as { crypto?: unknown }).crypto;
    delete (g as { WebAssembly?: unknown }).WebAssembly;
    // Install capturing downstream BEFORE the polyfill wraps console — the
    // polyfill will bind these as the filter's forwarding target.
    console.error = (...args: unknown[]) => {
      errorForwarded.push(args);
    };
    console.warn = (...args: unknown[]) => {
      warnForwarded.push(args);
    };
    await import("./crypto-polyfill?binding-fresh=1");
  });

  afterAll(() => {
    g.self = originalSelf;
    g.crypto = originalCrypto;
    g.WebAssembly = originalWebAssembly;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  test("filter is installed (console.error replaced by the wrapper)", () => {
    // The live console.error is the wrapper, not our raw capturing function.
    expect(typeof console.error).toBe("function");
    expect(console.error.name).toBe("filtered");
  });

  test("drops the two emscripten init-noise lines (downstream not called)", () => {
    errorForwarded.length = 0;
    console.error(
      "failed to asynchronously prepare wasm: ReferenceError: Property 'WebAssembly' doesn't exist",
    );
    console.error(
      "Aborted(ReferenceError: Property 'WebAssembly' doesn't exist). Build with -sASSERTIONS for more info.",
    );
    expect(errorForwarded).toHaveLength(0);
  });

  test("forwards genuine errors to the downstream verbatim", () => {
    errorForwarded.length = 0;
    console.error("Network request failed", { code: 500 });
    console.error("RangeError: out of bounds");
    expect(errorForwarded).toEqual([
      ["Network request failed", { code: 500 }],
      ["RangeError: out of bounds"],
    ]);
  });

  test("forwards non-string first args (cannot be noise)", () => {
    errorForwarded.length = 0;
    const errObj = new Error("boom");
    console.error(errObj);
    expect(errorForwarded).toEqual([[errObj]]);
  });

  test("console.warn is also filtered and forwards real warnings", () => {
    warnForwarded.length = 0;
    console.warn("Build with -sASSERTIONS for more info."); // noise → dropped
    console.warn("a real deprecation warning"); // forwarded
    expect(warnForwarded).toEqual([["a real deprecation warning"]]);
  });
});
