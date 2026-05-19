import { describe, expect, test } from "bun:test";
import { ensureSodium } from "./crypto";

// Regression: prior implementation assigned the module reference *before*
// `await s.ready` resolved, so a second concurrent caller could observe
// `_sodium` set but find APIs like `crypto_generichash` undefined. We
// memoize the promise instead — every concurrent caller awaits the same
// ready resolution.
describe("ensureSodium concurrency", () => {
  test("50 concurrent callers each get a sodium with crypto_generichash", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => ensureSodium()),
    );
    for (const sodium of results) {
      expect(typeof sodium.crypto_generichash).toBe("function");
      // Smoke: actually call it to prove the underlying WASM is ready.
      const out = sodium.crypto_generichash(32, sodium.from_string("probe"));
      expect(out.length).toBe(32);
    }
  });

  test("returned references all share the same module instance", async () => {
    const [a, b, c] = await Promise.all([
      ensureSodium(),
      ensureSodium(),
      ensureSodium(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
