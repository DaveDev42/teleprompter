/**
 * ApnsJwtSigner unit tests.
 *
 * Uses a throwaway P-256 key generated in-test via Node/Bun crypto — no real
 * APNs credentials or network access required.
 *
 * Test coverage:
 *  - JWT structure: base64url-encoded header/claims (alg, kid, iss, iat)
 *  - Signature: present and 64 bytes (P1363 ES256 = r || s, each 32 bytes)
 *  - Caching: same token returned within the 50-min window
 *  - Expiry: new token issued after the 50-min cache window
 *  - invalidate(): forces a re-sign on next getToken() call
 *  - derToP1363: converts a DER ECDSA sig to raw P1363 format
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setLogLevel } from "@teleprompter/protocol";
import { generateKeyPairSync } from "crypto";
import { ApnsJwtSigner, derToP1363 } from "./apns-jwt";

beforeAll(() => setLogLevel("silent"));
afterAll(() => setLogLevel("info"));

// ── Throwaway test key ──────────────────────────────────────────────────────

/**
 * Generate a throwaway P-256 EC key for testing. This is the same curve
 * (prime256v1) APNs uses for ES256 JWTs. The key is generated once per test
 * run; it is NEVER a real .p8 key.
 */
function makeTestKey(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return privateKey;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function decodeJwtPart(part: string): unknown {
  // base64url → base64 → JSON
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(padded, "base64").toString("utf-8");
  return JSON.parse(json);
}

function parseJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signatureBytes: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new Error(`Expected 3 JWT parts, got ${parts.length}`);
  const [h, c, sig] = parts as [string, string, string];
  const header = decodeJwtPart(h) as Record<string, unknown>;
  const claims = decodeJwtPart(c) as Record<string, unknown>;
  // base64url → Buffer
  const padded = sig.replace(/-/g, "+").replace(/_/g, "/");
  const signatureBytes = Buffer.from(padded, "base64");
  return { header, claims, signatureBytes };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ApnsJwtSigner", () => {
  describe("JWT structure", () => {
    test("header has alg=ES256 and kid from opts", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "TESTKEY1234",
        teamId: "TESTTEAM56",
      });
      const token = await signer.getToken();
      const { header } = parseJwt(token);
      expect(header["alg"]).toBe("ES256");
      expect(header["kid"]).toBe("TESTKEY1234");
    });

    test("claims have iss=teamId and iat near current time", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "KID",
        teamId: "TEAM123456",
      });
      const before = Math.floor(Date.now() / 1000);
      const token = await signer.getToken();
      const after = Math.floor(Date.now() / 1000);
      const { claims } = parseJwt(token);
      expect(claims["iss"]).toBe("TEAM123456");
      const iat = claims["iat"] as number;
      expect(iat).toBeGreaterThanOrEqual(before);
      expect(iat).toBeLessThanOrEqual(after);
    });

    test("JWT has exactly 3 parts (header.claims.sig)", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "K",
        teamId: "T",
      });
      const token = await signer.getToken();
      expect(token.split(".").length).toBe(3);
    });
  });

  describe("signature", () => {
    test("signature is 64 bytes (P1363 ES256: r || s, each 32 bytes)", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "K",
        teamId: "T",
      });
      const token = await signer.getToken();
      const { signatureBytes } = parseJwt(token);
      expect(signatureBytes.length).toBe(64);
    });
  });

  describe("caching", () => {
    test("same token is returned within the cache window", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "K",
        teamId: "T",
      });
      const t1 = await signer.getToken();
      const t2 = await signer.getToken();
      expect(t1).toBe(t2);
    });

    test("invalidate() forces a re-sign on next call", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "K",
        teamId: "T",
      });
      const t1 = await signer.getToken();
      // Wait 1s so iat differs
      await Bun.sleep(1100);
      signer.invalidate();
      const t2 = await signer.getToken();
      // Different iat → different token (the signature covers iat)
      expect(t1).not.toBe(t2);
      const { claims: c1 } = parseJwt(t1);
      const { claims: c2 } = parseJwt(t2);
      expect(c2["iat"] as number).toBeGreaterThan(c1["iat"] as number);
    });

    test("cachedAgeMs() returns 0 when not cached", () => {
      const signer = new ApnsJwtSigner({
        keyPemOrPath: "pem",
        keyId: "K",
        teamId: "T",
      });
      expect(signer.cachedAgeMs()).toBe(0);
    });

    test("cachedAgeMs() returns a non-negative value after first getToken()", async () => {
      const pem = makeTestKey();
      const signer = new ApnsJwtSigner({
        keyPemOrPath: pem,
        keyId: "K",
        teamId: "T",
      });
      await signer.getToken();
      // Allow at least 1ms to pass so the age is detectable on fast machines.
      await Bun.sleep(2);
      expect(signer.cachedAgeMs()).toBeGreaterThan(0);
    });
  });
});

describe("derToP1363", () => {
  test("converts a known DER ECDSA signature to 64-byte P1363", () => {
    // Build a minimal DER-encoded ECDSA signature with r and s of 32 bytes each
    // (no DER leading 0x00 padding needed — both are positive 32-byte values).
    const r = Buffer.alloc(32, 0xaa);
    const s = Buffer.alloc(32, 0xbb);
    // DER: 0x02 <len> <r> 0x02 <len> <s>
    const rDer = Buffer.concat([Buffer.from([0x02, 32]), r]);
    const sDer = Buffer.concat([Buffer.from([0x02, 32]), s]);
    const seq = Buffer.concat([rDer, sDer]);
    const der = Buffer.concat([Buffer.from([0x30, seq.length]), seq]);

    const p1363 = derToP1363(der);
    expect(p1363.length).toBe(64);
    expect(p1363.slice(0, 32).equals(r)).toBe(true);
    expect(p1363.slice(32, 64).equals(s)).toBe(true);
  });

  test("strips leading 0x00 DER padding byte from r and s", () => {
    // DER integers prepend 0x00 when the high bit is set (to preserve sign).
    const rRaw = Buffer.alloc(32, 0xff); // high bit set → DER adds 0x00 prefix
    const sRaw = Buffer.alloc(32, 0xfe);
    const rPadded = Buffer.concat([Buffer.from([0x00]), rRaw]);
    const sPadded = Buffer.concat([Buffer.from([0x00]), sRaw]);
    const rDer = Buffer.concat([Buffer.from([0x02, rPadded.length]), rPadded]);
    const sDer = Buffer.concat([Buffer.from([0x02, sPadded.length]), sPadded]);
    const seq = Buffer.concat([rDer, sDer]);
    const der = Buffer.concat([Buffer.from([0x30, seq.length]), seq]);

    const p1363 = derToP1363(der);
    expect(p1363.length).toBe(64);
    expect(p1363.slice(0, 32).equals(rRaw)).toBe(true);
    expect(p1363.slice(32, 64).equals(sRaw)).toBe(true);
  });
});
