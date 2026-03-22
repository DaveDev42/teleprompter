import { describe, test, expect } from "bun:test";
import {
  generateKeyPair,
  deriveSessionKeys,
  encrypt,
  decrypt,
  generatePairingSecret,
  deriveRelayToken,
  toBase64,
  fromBase64,
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
});
