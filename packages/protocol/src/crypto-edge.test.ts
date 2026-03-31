import { describe, expect, test } from "bun:test";
import {
  decrypt,
  deriveSessionKeys,
  encrypt,
  fromBase64,
  generateKeyPair,
  ratchetSessionKeys,
  toBase64,
} from "./crypto";

describe("crypto edge cases", () => {
  test("encrypt/decrypt empty payload", async () => {
    const kp = await generateKeyPair();
    const keys = await deriveSessionKeys(
      kp,
      (await generateKeyPair()).publicKey,
      "daemon",
    );
    const ct = await encrypt(new Uint8Array(0), keys.tx);
    const pt = await decrypt(ct, keys.tx);
    expect(pt.length).toBe(0);
  });

  test("encrypt/decrypt large payload (1MB)", async () => {
    const kp = await generateKeyPair();
    const keys = await deriveSessionKeys(
      kp,
      (await generateKeyPair()).publicKey,
      "daemon",
    );
    const data = new Uint8Array(1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const ct = await encrypt(data, keys.tx);
    const pt = await decrypt(ct, keys.tx);
    expect(pt.length).toBe(data.length);
    expect(pt[0]).toBe(0);
    expect(pt[255]).toBe(255);
    expect(pt[1024]).toBe(0);
  });

  test("decrypt with tampered ciphertext fails", async () => {
    const kp = await generateKeyPair();
    const keys = await deriveSessionKeys(
      kp,
      (await generateKeyPair()).publicKey,
      "daemon",
    );
    const ct = await encrypt(new TextEncoder().encode("secret"), keys.tx);

    // Tamper with the base64 ciphertext
    const bytes = await fromBase64(ct);
    bytes[bytes.length - 1] ^= 0xff; // flip last byte
    const tampered = await toBase64(bytes);

    await expect(decrypt(tampered, keys.tx)).rejects.toThrow();
  });

  test("ratchet with empty session ID", async () => {
    const kp = await generateKeyPair();
    const keys = await deriveSessionKeys(
      kp,
      (await generateKeyPair()).publicKey,
      "daemon",
    );
    // Should not throw
    const ratcheted = await ratchetSessionKeys(keys, "", "daemon");
    expect(ratcheted.tx.length).toBe(32);
    expect(ratcheted.rx.length).toBe(32);
  });

  test("ratchet with very long session ID", async () => {
    const kp = await generateKeyPair();
    const keys = await deriveSessionKeys(
      kp,
      (await generateKeyPair()).publicKey,
      "daemon",
    );
    const longId = "a".repeat(10000);
    const ratcheted = await ratchetSessionKeys(keys, longId, "daemon");
    expect(ratcheted.tx.length).toBe(32);
  });

  test("base64 round-trip with binary data containing nulls", async () => {
    const data = new Uint8Array([0, 0, 0, 255, 0, 128, 0, 0]);
    const encoded = await toBase64(data);
    const decoded = await fromBase64(encoded);
    expect(decoded).toEqual(data);
  });
});
