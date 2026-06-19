import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PushSealer } from "./push-seal";

// Helper: a secret that passes the ≥32 char minimum
const SECRET = "a".repeat(32);
const SECRET_PREV = "b".repeat(32);

describe("PushSealer", () => {
  // Save and restore env vars
  let origSecret: string | undefined;
  let origSecretPrev: string | undefined;
  let origVersion: string | undefined;

  beforeEach(() => {
    origSecret = process.env.TP_RELAY_PUSH_SEAL_SECRET;
    origSecretPrev = process.env.TP_RELAY_PUSH_SEAL_SECRET_PREV;
    origVersion = process.env.TP_RELAY_PUSH_SEAL_VERSION;
    delete process.env.TP_RELAY_PUSH_SEAL_SECRET;
    delete process.env.TP_RELAY_PUSH_SEAL_SECRET_PREV;
    delete process.env.TP_RELAY_PUSH_SEAL_VERSION;
  });

  afterEach(() => {
    if (origSecret !== undefined)
      process.env.TP_RELAY_PUSH_SEAL_SECRET = origSecret;
    else delete process.env.TP_RELAY_PUSH_SEAL_SECRET;
    if (origSecretPrev !== undefined)
      process.env.TP_RELAY_PUSH_SEAL_SECRET_PREV = origSecretPrev;
    else delete process.env.TP_RELAY_PUSH_SEAL_SECRET_PREV;
    if (origVersion !== undefined)
      process.env.TP_RELAY_PUSH_SEAL_VERSION = origVersion;
    else delete process.env.TP_RELAY_PUSH_SEAL_VERSION;
  });

  test("seal → unseal round-trip", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxxxx]";
    const blob = await sealer.seal(token);
    const result = await sealer.unseal(blob);
    expect(result).toEqual({ ok: true, token });
  });

  test("sealed blob starts with correct version prefix", async () => {
    const sealer = new PushSealer({ secret: SECRET, version: 3 });
    const blob = await sealer.seal("mytoken");
    expect(blob.startsWith("tpps1.3.")).toBe(true);
  });

  test("default version is 1", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    expect(sealer.version).toBe(1);
    const blob = await sealer.seal("tok");
    expect(blob.startsWith("tpps1.1.")).toBe(true);
  });

  test("each seal produces a different blob (random nonce)", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const token = "mytoken";
    const b1 = await sealer.seal(token);
    const b2 = await sealer.seal(token);
    expect(b1).not.toBe(b2);
    // Both unseal correctly
    const r1 = await sealer.unseal(b1);
    const r2 = await sealer.unseal(b2);
    expect(r1).toEqual({ ok: true, token });
    expect(r2).toEqual({ ok: true, token });
  });

  describe("key rotation (current + prev)", () => {
    test("v1 blob unseals via prevSecret when current is v2", async () => {
      // First seal at v1 with SECRET
      const sealerV1 = new PushSealer({ secret: SECRET, version: 1 });
      const token = "my-old-token";
      const blob = await sealerV1.seal(token);
      expect(blob.startsWith("tpps1.1.")).toBe(true);

      // Upgrade: new secret at v2, old secret at prev
      const sealerV2 = new PushSealer({
        secret: SECRET_PREV, // "new" current
        secretPrev: SECRET, // "old" secret is now prev
        version: 2,
      });
      // blob is v1, key = SECRET (now prev)
      const result = await sealerV2.unseal(blob);
      expect(result).toEqual({ ok: true, token });
    });

    test("rotated-out version (not current or prev) → unseal_failed", async () => {
      const sealerV1 = new PushSealer({ secret: SECRET, version: 1 });
      const blob = await sealerV1.seal("tok");

      // Current is v3, prev covers v2 only; v1 is gone
      const sealerV3 = new PushSealer({
        secret: "c".repeat(32),
        secretPrev: SECRET_PREV,
        version: 3,
      });
      const result = await sealerV3.unseal(blob);
      expect(result).toEqual({ ok: false, reason: "unseal_failed" });
    });
  });

  test("legacy string (not starting with tpps1.) → { ok: false, reason: 'legacy' }", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const result = await sealer.unseal("ExponentPushToken[abc123]");
    expect(result).toEqual({ ok: false, reason: "legacy" });
  });

  describe("ephemeral mode", () => {
    test("ephemeral=true when no secret or secret too short", () => {
      const s1 = new PushSealer({ secret: "short" });
      expect(s1.ephemeral).toBe(true);
      const s2 = new PushSealer();
      expect(s2.ephemeral).toBe(true);
    });

    test("ephemeral=false when secret is ≥32 chars", () => {
      const sealer = new PushSealer({ secret: SECRET });
      expect(sealer.ephemeral).toBe(false);
    });

    test("ephemeral sealer is self-consistent (seal→unseal works within process)", async () => {
      const sealer = new PushSealer();
      expect(sealer.ephemeral).toBe(true);
      const token = "tok-ephemeral";
      const blob = await sealer.seal(token);
      const result = await sealer.unseal(blob);
      expect(result).toEqual({ ok: true, token });
    });
  });

  test("tampered body → unseal_failed", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const blob = await sealer.seal("tok");
    // Corrupt a character in the base64 body
    const parts = blob.split(".");
    // parts = ["tpps1", "1", "<b64>"]
    const b64 = parts[2] ?? "";
    const tampered =
      b64.slice(0, 5) + (b64[5] === "A" ? "B" : "A") + b64.slice(6);
    const tamperedBlob = `${parts[0]}.${parts[1]}.${tampered}`;
    const result = await sealer.unseal(tamperedBlob);
    expect(result).toEqual({ ok: false, reason: "unseal_failed" });
  });

  test("wrong key → unseal_failed", async () => {
    const sealer1 = new PushSealer({ secret: SECRET });
    const sealer2 = new PushSealer({ secret: "z".repeat(32) });
    const blob = await sealer1.seal("tok");
    const result = await sealer2.unseal(blob);
    expect(result).toEqual({ ok: false, reason: "unseal_failed" });
  });

  test("truncated blob body → unseal_failed", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const blob = await sealer.seal("tok");
    const truncated = blob.slice(0, blob.length - 4);
    const result = await sealer.unseal(truncated);
    // Either parse_error (if the dot structure breaks) or unseal_failed
    expect(result.ok).toBe(false);
  });

  test("non-integer version string → parse_error", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const result = await sealer.unseal("tpps1.abc.somebase64data");
    expect(result).toEqual({ ok: false, reason: "parse_error" });
  });

  test("missing dot after version → parse_error", async () => {
    const sealer = new PushSealer({ secret: SECRET });
    const result = await sealer.unseal("tpps1.1nodot");
    expect(result).toEqual({ ok: false, reason: "parse_error" });
  });

  test("reads TP_RELAY_PUSH_SEAL_VERSION from env", () => {
    process.env.TP_RELAY_PUSH_SEAL_SECRET = SECRET;
    process.env.TP_RELAY_PUSH_SEAL_VERSION = "5";
    const sealer = new PushSealer();
    expect(sealer.version).toBe(5);
    expect(sealer.ephemeral).toBe(false);
  });
});
