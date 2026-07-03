// Cross-implementation equivalence for the pairing primitives (PR-2 twin of the
// Rust `tests/wire_vectors.rs` pairing cases). This TS side and the Rust side
// both assert against the SAME frozen fixture
// (`rust/tp-core/tests/fixtures/wire-vectors.json`, `pairing` section), so a
// divergence in either implementation fails loudly here or there.
//
// The KATs (`tag_hex`, `uuid`, v4 `url`) were computed independently — Python
// `hashlib.blake2b(digest_size=32)` == libsodium `crypto_generichash` — and are
// the byte-exact contract both cores must reproduce.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodePairingData,
  deriveLegacyPairingId,
  derivePairingConfirmationTag,
  encodePairingData,
  type PairingData,
} from "./index";

interface PairingFixture {
  pairing: {
    pct: {
      pairingId_hex: string;
      daemonId: string;
      hostname: string;
      daemonPk_hex: string;
      frontendPk_hex: string;
      tx_hex: string;
      rx_hex: string;
      tag_hex: string;
    };
    pct_equal_keys: {
      pairingId_hex: string;
      daemonId: string;
      hostname: string;
      daemonPk_hex: string;
      frontendPk_hex: string;
      key_hex: string;
      tag_hex: string;
    };
    legacyPairingId: { daemonId: string; uuid: string };
    v4Encode: {
      ps_hex: string;
      pk_hex: string;
      relay: string;
      did: string;
      pairingId: string;
      hostname: string;
      url: string;
    };
    v3Decode: {
      url: string;
      did: string;
      ps_hex: string;
      pk_hex: string;
      v: number;
    };
  };
}

// The fixture lives in the Rust crate. From packages/protocol/src that is three
// directories up to the repo root, then into rust/tp-core/tests/fixtures.
const FIXTURE_PATH = join(
  import.meta.dir,
  "../../../rust/tp-core/tests/fixtures/wire-vectors.json",
);
const fixture = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf8"),
) as PairingFixture;
const f = fixture.pairing;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("pairing cross-vectors (Rust ↔ TS byte-exact)", () => {
  test("PCT matches the frozen KAT (tx>rx → min/max swap)", async () => {
    const tag = await derivePairingConfirmationTag({
      pairingId: hexToBytes(f.pct.pairingId_hex),
      daemonId: f.pct.daemonId,
      hostname: f.pct.hostname,
      daemonPubKey: hexToBytes(f.pct.daemonPk_hex),
      frontendPubKey: hexToBytes(f.pct.frontendPk_hex),
      tx: hexToBytes(f.pct.tx_hex),
      rx: hexToBytes(f.pct.rx_hex),
    });
    expect(bytesToHex(tag)).toBe(f.pct.tag_hex);
  });

  test("PCT is order-independent (swapping tx/rx yields the same tag)", async () => {
    const base = {
      pairingId: hexToBytes(f.pct.pairingId_hex),
      daemonId: f.pct.daemonId,
      hostname: f.pct.hostname,
      daemonPubKey: hexToBytes(f.pct.daemonPk_hex),
      frontendPubKey: hexToBytes(f.pct.frontendPk_hex),
    };
    const tx = hexToBytes(f.pct.tx_hex);
    const rx = hexToBytes(f.pct.rx_hex);
    const a = await derivePairingConfirmationTag({ ...base, tx, rx });
    const b = await derivePairingConfirmationTag({ ...base, tx: rx, rx: tx });
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(bytesToHex(a)).toBe(f.pct.tag_hex);
  });

  test("PCT with equal tx==rx matches the frozen KAT", async () => {
    const k = hexToBytes(f.pct_equal_keys.key_hex);
    const tag = await derivePairingConfirmationTag({
      pairingId: hexToBytes(f.pct_equal_keys.pairingId_hex),
      daemonId: f.pct_equal_keys.daemonId,
      hostname: f.pct_equal_keys.hostname,
      daemonPubKey: hexToBytes(f.pct_equal_keys.daemonPk_hex),
      frontendPubKey: hexToBytes(f.pct_equal_keys.frontendPk_hex),
      tx: k,
      rx: k,
    });
    expect(bytesToHex(tag)).toBe(f.pct_equal_keys.tag_hex);
  });

  test("legacy pairing-id matches the frozen UUID", async () => {
    const id = await deriveLegacyPairingId(f.legacyPairingId.daemonId);
    expect(id).toBe(f.legacyPairingId.uuid);
  });

  test("v4 QR encode reproduces the frozen golden URL + round-trips", () => {
    const data: PairingData = {
      ps: bytesToBase64(hexToBytes(f.v4Encode.ps_hex)),
      pk: bytesToBase64(hexToBytes(f.v4Encode.pk_hex)),
      relay: f.v4Encode.relay,
      did: f.v4Encode.did,
      v: 4,
      pairingId: f.v4Encode.pairingId,
      hostname: f.v4Encode.hostname,
    };
    const url = encodePairingData(data);
    expect(url).toBe(f.v4Encode.url);

    const back = decodePairingData(url);
    expect(back.did).toBe(data.did);
    expect(back.pairingId).toBe(data.pairingId);
    expect(back.hostname).toBe(data.hostname);
    expect(back.v).toBe(4);
    expect(back.ps).toBe(data.ps);
    expect(back.pk).toBe(data.pk);
  });

  test("v3 QR decodes with empty pairingId/hostname (legacy compat)", () => {
    const back = decodePairingData(f.v3Decode.url);
    expect(back.v).toBe(f.v3Decode.v);
    expect(back.did).toBe(f.v3Decode.did);
    expect(back.ps).toBe(bytesToBase64(hexToBytes(f.v3Decode.ps_hex)));
    expect(back.pk).toBe(bytesToBase64(hexToBytes(f.v3Decode.pk_hex)));
    expect(back.pairingId).toBe("");
    expect(back.hostname).toBe("");
  });
});
