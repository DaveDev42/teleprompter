import { describe, expect, test } from "bun:test";
import { ensureSodium } from "./crypto";

// Regression: prior implementation assigned the module reference *before*
// `await s.ready` resolved, so a second concurrent caller could observe
// `_sodium` set but find APIs like `crypto_generichash` undefined. We
// memoize the promise instead — every concurrent caller awaits the same
// ready resolution.
//
// After the CryptoProvider seam (PR1), `ensureSodium()` resolves a
// CryptoProvider rather than the raw libsodium module. We probe the provider
// surface (genericHash32) and perform a real round-trip to confirm the
// underlying implementation is fully ready.
describe("ensureSodium concurrency", () => {
  test("50 concurrent callers each get a provider with genericHash32", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => ensureSodium()),
    );
    for (const p of results) {
      expect(typeof p.genericHash32).toBe("function");
      // Smoke: actually call it to prove the underlying implementation is ready.
      const out = p.genericHash32(p.fromString("probe"));
      expect(out.length).toBe(32);
    }
  });

  test("returned references all share the same provider instance", async () => {
    const [a, b, c] = await Promise.all([
      ensureSodium(),
      ensureSodium(),
      ensureSodium(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
