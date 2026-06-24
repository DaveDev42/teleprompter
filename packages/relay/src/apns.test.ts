/**
 * ApnsClient unit tests — FIX 6 regression + basic delivery result shape.
 *
 * Uses stub fetch implementations; no real APNs credentials or network needed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setLogLevel } from "@teleprompter/protocol";
import { generateKeyPairSync } from "crypto";
import { ApnsClient } from "./apns";
import { ApnsJwtSigner } from "./apns-jwt";

beforeAll(() => setLogLevel("silent"));
afterAll(() => setLogLevel("info"));

function makeTestSigner(): ApnsJwtSigner {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return new ApnsJwtSigner({
    keyPemOrPath: privateKey,
    keyId: "TESTKEYID1",
    teamId: "TESTTEAMID",
  });
}

const VALID_TOKEN = "a".repeat(64); // 64 lowercase hex chars
const okFetch = (async () =>
  new Response(null, { status: 200 })) as unknown as typeof fetch;

describe("ApnsClient.send", () => {
  describe("FIX 6 — device token pre-flight validation", () => {
    test("rejects token shorter than 64 chars with deadToken:false", async () => {
      const client = new ApnsClient({
        host: "api.sandbox.push.apple.com",
        bundleId: "dev.test.app",
        signer: makeTestSigner(),
        fetchFn: okFetch,
      });
      const result = await client.send({
        deviceToken: "abc",
        title: "T",
        body: "B",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.deadToken).toBe(false);
        expect(result.reason).toBe("invalid-device-token");
      }
    });

    test("rejects token longer than 64 chars with deadToken:false", async () => {
      const client = new ApnsClient({
        host: "api.sandbox.push.apple.com",
        bundleId: "dev.test.app",
        signer: makeTestSigner(),
        fetchFn: okFetch,
      });
      const result = await client.send({
        deviceToken: "a".repeat(65),
        title: "T",
        body: "B",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.deadToken).toBe(false);
        expect(result.reason).toBe("invalid-device-token");
      }
    });

    test("rejects token with uppercase hex chars with deadToken:false", async () => {
      const client = new ApnsClient({
        host: "api.sandbox.push.apple.com",
        bundleId: "dev.test.app",
        signer: makeTestSigner(),
        fetchFn: okFetch,
      });
      const result = await client.send({
        deviceToken: "A".repeat(64), // uppercase, invalid
        title: "T",
        body: "B",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.deadToken).toBe(false);
        expect(result.reason).toBe("invalid-device-token");
      }
    });

    test("accepts a valid 64-char lowercase hex token and sends the request", async () => {
      let called = false;
      const capturingFetch = (async (url: string) => {
        called = true;
        expect(url).toContain(VALID_TOKEN);
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      const client = new ApnsClient({
        host: "api.sandbox.push.apple.com",
        bundleId: "dev.test.app",
        signer: makeTestSigner(),
        fetchFn: capturingFetch,
      });
      const result = await client.send({
        deviceToken: VALID_TOKEN,
        title: "T",
        body: "B",
      });
      expect(result.ok).toBe(true);
      expect(called).toBe(true);
    });

    test("structurally-invalid token does NOT trigger deadToken:true (no PUSH_TOKEN_DEAD eviction)", async () => {
      // Ensure that a garbled token (e.g. coming from a buggy registration)
      // never causes dead-token eviction — only APNs-confirmed dead tokens
      // (BadDeviceToken/Unregistered responses) should do that.
      const client = new ApnsClient({
        host: "api.sandbox.push.apple.com",
        bundleId: "dev.test.app",
        signer: makeTestSigner(),
        fetchFn: okFetch,
      });
      const result = await client.send({
        deviceToken: "not-a-token",
        title: "T",
        body: "B",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // CRITICAL: must be false — invalid-device-token must NOT evict the token
        expect(result.deadToken).toBe(false);
      }
    });
  });
});
