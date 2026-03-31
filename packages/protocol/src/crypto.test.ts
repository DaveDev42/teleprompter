import { describe, expect, test } from "bun:test";
import {
  decrypt,
  deriveKxKey,
  deriveRegistrationProof,
  deriveRelayToken,
  deriveSessionKeys,
  encrypt,
  fromBase64,
  generateKeyPair,
  generatePairingSecret,
  ratchetSessionKeys,
  toBase64,
  toHex,
} from "./crypto";

describe("crypto", () => {
  test("generates key pair with 32-byte keys", async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  test("two different key pairs are unique", async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.secretKey).not.toEqual(kp2.secretKey);
  });

  test("derives matching session keys for daemon/frontend", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();

    const daemonKeys = await deriveSessionKeys(
      daemonKp,
      frontendKp.publicKey,
      "daemon",
    );
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    // daemon's tx key should equal frontend's rx key (and vice versa)
    expect(daemonKeys.tx).toEqual(frontendKeys.rx);
    expect(daemonKeys.rx).toEqual(frontendKeys.tx);
  });

  test("encrypt then decrypt round-trip", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();

    const daemonKeys = await deriveSessionKeys(
      daemonKp,
      frontendKp.publicKey,
      "daemon",
    );
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    const plaintext = new TextEncoder().encode(
      '{"t":"rec","sid":"s1","seq":1,"k":"io","d":"SGVsbG8="}',
    );

    // Daemon encrypts with tx key
    const ciphertext = await encrypt(plaintext, daemonKeys.tx);
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext.length).toBeGreaterThan(0);

    // Frontend decrypts with rx key (which equals daemon's tx)
    const decrypted = await decrypt(ciphertext, frontendKeys.rx);
    expect(new TextDecoder().decode(decrypted)).toBe(
      new TextDecoder().decode(plaintext),
    );
  });

  test("decrypt fails with wrong key", async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const wrongKp = await generateKeyPair();

    const keys = await deriveSessionKeys(kp1, kp2.publicKey, "daemon");
    const wrongKeys = await deriveSessionKeys(
      wrongKp,
      kp2.publicKey,
      "frontend",
    );

    const plaintext = new TextEncoder().encode("secret data");
    const ciphertext = await encrypt(plaintext, keys.tx);

    // Decrypting with wrong key should throw
    await expect(decrypt(ciphertext, wrongKeys.rx)).rejects.toThrow();
  });

  test("each encryption produces different ciphertext (random nonce)", async () => {
    const kp = await generateKeyPair();
    const keys = await deriveSessionKeys(
      kp,
      (await generateKeyPair()).publicKey,
      "daemon",
    );

    const plaintext = new TextEncoder().encode("same plaintext");
    const ct1 = await encrypt(plaintext, keys.tx);
    const ct2 = await encrypt(plaintext, keys.tx);
    expect(ct1).not.toBe(ct2);
  });

  test("generates 32-byte pairing secret", async () => {
    const secret = await generatePairingSecret();
    expect(secret.length).toBe(32);
  });

  test("derives deterministic relay token from pairing secret", async () => {
    const secret = await generatePairingSecret();
    const token1 = await deriveRelayToken(secret);
    const token2 = await deriveRelayToken(secret);
    expect(token1).toBe(token2);
    expect(token1.length).toBe(64); // 32 bytes hex
  });

  test("different pairing secrets produce different tokens", async () => {
    const s1 = await generatePairingSecret();
    const s2 = await generatePairingSecret();
    const t1 = await deriveRelayToken(s1);
    const t2 = await deriveRelayToken(s2);
    expect(t1).not.toBe(t2);
  });

  test("base64 round-trip", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const encoded = await toBase64(data);
    const decoded = await fromBase64(encoded);
    expect(decoded).toEqual(data);
  });

  test("toHex produces hex string", async () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const hex = await toHex(data);
    expect(hex).toBe("deadbeef");
  });

  test("ratchetSessionKeys produces different keys per session", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const baseKeys = await deriveSessionKeys(
      daemonKp,
      frontendKp.publicKey,
      "daemon",
    );

    const keys1 = await ratchetSessionKeys(baseKeys, "session-1", "daemon");
    const keys2 = await ratchetSessionKeys(baseKeys, "session-2", "daemon");

    // Different sessions produce different keys
    expect(keys1.tx).not.toEqual(keys2.tx);
    expect(keys1.rx).not.toEqual(keys2.rx);

    // Same session produces same keys (deterministic)
    const keys1b = await ratchetSessionKeys(baseKeys, "session-1", "daemon");
    expect(keys1.tx).toEqual(keys1b.tx);
    expect(keys1.rx).toEqual(keys1b.rx);
  });

  test("ratcheted keys work for encrypt/decrypt across roles", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();

    const daemonBase = await deriveSessionKeys(
      daemonKp,
      frontendKp.publicKey,
      "daemon",
    );
    const frontendBase = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    const daemonKeys = await ratchetSessionKeys(daemonBase, "s1", "daemon");
    const frontendKeys = await ratchetSessionKeys(
      frontendBase,
      "s1",
      "frontend",
    );

    // daemon tx → frontend rx
    const plaintext = new TextEncoder().encode("ratcheted message");
    const ct = await encrypt(plaintext, daemonKeys.tx);
    const pt = await decrypt(ct, frontendKeys.rx);
    expect(new TextDecoder().decode(pt)).toBe("ratcheted message");

    // frontend tx → daemon rx
    const reply = new TextEncoder().encode("reply");
    const ct2 = await encrypt(reply, frontendKeys.tx);
    const pt2 = await decrypt(ct2, daemonKeys.rx);
    expect(new TextDecoder().decode(pt2)).toBe("reply");
  });

  test("deriveKxKey produces deterministic 32-byte key", async () => {
    const secret = await generatePairingSecret();
    const key1 = await deriveKxKey(secret);
    const key2 = await deriveKxKey(secret);

    expect(key1.length).toBe(32);
    expect(key1).toEqual(key2); // deterministic
  });

  test("deriveKxKey differs from deriveRelayToken for same secret", async () => {
    const secret = await generatePairingSecret();
    const kxKey = await deriveKxKey(secret);
    const token = await deriveRelayToken(secret);

    // kxKey is Uint8Array(32), token is hex string — compare as hex
    const kxHex = await toHex(kxKey);
    expect(kxHex).not.toBe(token);
  });

  test("deriveKxKey differs for different secrets", async () => {
    const secretA = await generatePairingSecret();
    const secretB = await generatePairingSecret();
    const keyA = await deriveKxKey(secretA);
    const keyB = await deriveKxKey(secretB);

    expect(keyA).not.toEqual(keyB);
  });

  test("deriveKxKey can encrypt/decrypt key exchange envelopes", async () => {
    const secret = await generatePairingSecret();
    const kxKey = await deriveKxKey(secret);

    const payload = new TextEncoder().encode(
      JSON.stringify({
        pk: "test-public-key-base64",
        frontendId: "frontend-123",
        role: "frontend",
      }),
    );

    const ct = await encrypt(payload, kxKey);
    const pt = await decrypt(ct, kxKey);
    const parsed = JSON.parse(new TextDecoder().decode(pt));
    expect(parsed.frontendId).toBe("frontend-123");
  });

  test("deriveRegistrationProof produces deterministic hex string", async () => {
    const secret = await generatePairingSecret();
    const proof1 = await deriveRegistrationProof(secret);
    const proof2 = await deriveRegistrationProof(secret);

    expect(proof1).toBe(proof2); // deterministic
    expect(proof1.length).toBe(64); // 32 bytes as hex
    expect(/^[0-9a-f]+$/.test(proof1)).toBe(true); // valid hex
  });

  test("deriveRegistrationProof differs for different secrets", async () => {
    const secretA = await generatePairingSecret();
    const secretB = await generatePairingSecret();

    expect(await deriveRegistrationProof(secretA)).not.toBe(
      await deriveRegistrationProof(secretB),
    );
  });

  test("deriveRegistrationProof differs from relay token and kx key", async () => {
    const secret = await generatePairingSecret();
    const proof = await deriveRegistrationProof(secret);
    const token = await deriveRelayToken(secret);
    const kxHex = await toHex(await deriveKxKey(secret));

    expect(proof).not.toBe(token);
    expect(proof).not.toBe(kxHex);
  });
});
