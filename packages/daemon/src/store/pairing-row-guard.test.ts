import { describe, expect, test } from "bun:test";
import {
  PAIRING_KEY_BYTES,
  parseStoredPairing,
  type StoredPairing,
} from "./pairing-row-guard";

/** A well-formed raw `pairings` row (snake_case columns, as SQLite returns). */
function validRow(): Record<string, unknown> {
  return {
    daemon_id: "daemon-1",
    relay_url: "wss://relay.example",
    relay_token: "tok",
    registration_proof: "proof",
    public_key: new Uint8Array(PAIRING_KEY_BYTES).fill(1),
    secret_key: new Uint8Array(PAIRING_KEY_BYTES).fill(2),
    pairing_secret: new Uint8Array(PAIRING_KEY_BYTES).fill(3),
    created_at: 1700000000000,
    label: "My MacBook",
  };
}

/**
 * Zero-trust boundary tests for the SQLite pairings table. `loadPairings` used
 * to cast `SELECT *` rows straight to a typed shape and feed the BLOB columns
 * to libsodium (`crypto_kx_*` needs exactly 32 bytes). A truncated, NULL, or
 * wrong-length key column would crash key construction or silently produce a
 * bogus key. These tests pin the validation contract: 32-byte keys + non-empty
 * string columns, corrupt rows rejected to `null`.
 */
describe("parseStoredPairing", () => {
  test("accepts a well-formed row and reconstructs typed fields", () => {
    const parsed = parseStoredPairing(validRow());
    expect(parsed).not.toBeNull();
    const p = parsed as StoredPairing;
    expect(p.daemonId).toBe("daemon-1");
    expect(p.relayUrl).toBe("wss://relay.example");
    expect(p.relayToken).toBe("tok");
    expect(p.registrationProof).toBe("proof");
    expect(p.publicKey).toBeInstanceOf(Uint8Array);
    expect(p.publicKey.byteLength).toBe(PAIRING_KEY_BYTES);
    expect(p.secretKey.byteLength).toBe(PAIRING_KEY_BYTES);
    expect(p.pairingSecret.byteLength).toBe(PAIRING_KEY_BYTES);
    expect(p.label).toEqual({ set: true, value: "My MacBook" });
  });

  test("normalizes a NULL label to { set: false }", () => {
    const parsed = parseStoredPairing({ ...validRow(), label: null });
    expect(parsed?.label).toEqual({ set: false });
  });

  test("normalizes a legacy empty-string label to { set: false }", () => {
    const parsed = parseStoredPairing({ ...validRow(), label: "" });
    expect(parsed?.label).toEqual({ set: false });
  });

  test("defaults an absent pairing_id/hostname (pre-v4 row) to empty strings", () => {
    // validRow() has neither column — a legacy row read back before the async
    // backfill runs. The guard must NOT drop it (it still works; PCT emission
    // is simply skipped) and must surface "" for both.
    const parsed = parseStoredPairing(validRow());
    expect(parsed).not.toBeNull();
    expect(parsed?.pairingId).toBe("");
    expect(parsed?.hostname).toBe("");
  });

  test("normalizes a NULL pairing_id/hostname to empty strings (does not drop)", () => {
    const parsed = parseStoredPairing({
      ...validRow(),
      pairing_id: null,
      hostname: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.pairingId).toBe("");
    expect(parsed?.hostname).toBe("");
  });

  test("round-trips a present pairing_id/hostname", () => {
    const parsed = parseStoredPairing({
      ...validRow(),
      pairing_id: "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
      hostname: "Dave-MBP16",
    });
    expect(parsed?.pairingId).toBe("0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b");
    expect(parsed?.hostname).toBe("Dave-MBP16");
  });

  test("re-wraps key columns into a plain Uint8Array (not a Buffer)", () => {
    // Bun hands back a Buffer for BLOB columns; the guard must hand callers a
    // plain Uint8Array so no Buffer-pool slack leaks via .buffer.
    const row = { ...validRow(), public_key: Buffer.alloc(PAIRING_KEY_BYTES) };
    const parsed = parseStoredPairing(row);
    expect(parsed?.publicKey).toBeInstanceOf(Uint8Array);
    expect(parsed?.publicKey.constructor).toBe(Uint8Array);
    expect(parsed?.publicKey.byteLength).toBe(PAIRING_KEY_BYTES);
  });

  describe("rejects non-objects", () => {
    test.each<[unknown]>([
      [null],
      [undefined],
      [42],
      ["row"],
      [true],
      [[]],
      [[validRow()]],
    ])("rejects %p", (v) => {
      expect(parseStoredPairing(v)).toBeNull();
    });
  });

  describe("rejects missing or non-string text columns", () => {
    test.each<[string]>([
      ["daemon_id"],
      ["relay_url"],
      ["relay_token"],
      ["registration_proof"],
    ])("rejects a missing %s", (col) => {
      const row = validRow();
      delete row[col];
      expect(parseStoredPairing(row)).toBeNull();
    });

    test.each<[string]>([
      ["daemon_id"],
      ["relay_url"],
      ["relay_token"],
      ["registration_proof"],
    ])("rejects an empty %s", (col) => {
      expect(parseStoredPairing({ ...validRow(), [col]: "" })).toBeNull();
    });

    test("rejects a non-string daemon_id", () => {
      expect(parseStoredPairing({ ...validRow(), daemon_id: 7 })).toBeNull();
    });
  });

  test("rejects a non-finite created_at", () => {
    expect(parseStoredPairing({ ...validRow(), created_at: "x" })).toBeNull();
    expect(parseStoredPairing({ ...validRow(), created_at: NaN })).toBeNull();
  });

  describe("rejects malformed key columns", () => {
    test.each<[string]>([
      ["public_key"],
      ["secret_key"],
      ["pairing_secret"],
    ])("rejects a NULL %s", (col) => {
      expect(parseStoredPairing({ ...validRow(), [col]: null })).toBeNull();
    });

    test.each<[string]>([
      ["public_key"],
      ["secret_key"],
      ["pairing_secret"],
    ])("rejects a truncated (short) %s", (col) => {
      const row = {
        ...validRow(),
        [col]: new Uint8Array(PAIRING_KEY_BYTES - 1),
      };
      expect(parseStoredPairing(row)).toBeNull();
    });

    test.each<[string]>([
      ["public_key"],
      ["secret_key"],
      ["pairing_secret"],
    ])("rejects an over-long %s", (col) => {
      const row = {
        ...validRow(),
        [col]: new Uint8Array(PAIRING_KEY_BYTES + 1),
      };
      expect(parseStoredPairing(row)).toBeNull();
    });

    test.each<[string]>([
      ["public_key"],
      ["secret_key"],
      ["pairing_secret"],
    ])("rejects a non-bytes %s (e.g. a string)", (col) => {
      expect(
        parseStoredPairing({ ...validRow(), [col]: "deadbeef" }),
      ).toBeNull();
    });
  });
});
