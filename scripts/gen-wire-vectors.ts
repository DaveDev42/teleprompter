#!/usr/bin/env bun
/**
 * Generate the tp-core wire/crypto golden-vector fixture
 * (`rust/tp-core/tests/fixtures/wire-vectors.json`).
 *
 * This script derives the kdf / aead / aead_aad / kx / ratchet / codec
 * families from the LIVE `@teleprompter/protocol` reference implementation,
 * so the committed fixture is provably what the TS impl produces.
 * `rust/tp-core/tests/wire_vectors.rs` `include_str!`s the fixture (and
 * `packages/protocol/src/pairing-vectors.test.ts` reads the same file from
 * the TS side), so either implementation diverging fails loudly.
 *
 * Provenance caveats (each is deliberate, not an accident):
 *   - kx keypairs: the CryptoProvider seam has no seeded-keypair API (the
 *     runtime only ever generates random keypairs), so the seed→keypair step
 *     calls `libsodium-wrappers` `crypto_kx_seed_keypair` directly. The
 *     session keys and ratchet outputs still go through the live
 *     `deriveSessionKeys` / `ratchetSessionKeys` path; the in-script asserts
 *     bind the bypass back to the seam (sk == genericHash32(seed)) and the
 *     crossover invariant transitively verifies pk == basemult(sk).
 *   - AEAD: the public `encrypt()` / `sealWithAad()` generate a random nonce
 *     internally, so sealing uses the provider primitive (`aeadEncrypt`) with
 *     the fixture's fixed nonce. The sealed outputs are then round-tripped
 *     through the LIVE public `decrypt()` / `openWithAad()`.
 *   - `pairing` section: those KATs are an INDEPENDENT oracle (computed via
 *     Python `hashlib.blake2b(digest_size=32)` == libsodium
 *     `crypto_generichash`) frozen below as literals. This script VERIFIES
 *     the live TS path reproduces every output and hard-fails on drift — it
 *     never overwrites them (a silent regen would turn the independent
 *     oracle into a self-referential one).
 *   - `pairing.v3Decode.url` is a hand-assembled frozen INPUT (the TS
 *     encoder is v4-only); it is decoder-validated, never re-encoded.
 *
 * Run:  bun scripts/gen-wire-vectors.ts
 * The output must be byte-identical to the committed fixture:
 * `git diff --exit-code rust/tp-core/tests/fixtures/wire-vectors.json`.
 * All verification runs BEFORE the write — on any assert failure the
 * committed fixture is left untouched.
 *
 * NOTE: once the Bun/TS backend is deleted (#5 cascade), this script is
 * intentionally dead code and the fixture becomes a frozen regression pin —
 * this generator run is the last point the TS reference vouches for it.
 */

import {
  decodePairingData,
  decrypt,
  deriveKxKey,
  deriveLegacyPairingId,
  derivePairingConfirmationTag,
  derivePushSealKey,
  deriveRegistrationProof,
  deriveRelayToken,
  deriveSessionKeys,
  encodeFrame,
  encodePairingData,
  ensureSodium,
  openWithAad,
  type PairingData,
  ratchetSessionKeys,
} from "@teleprompter/protocol";
import sodium from "libsodium-wrappers";

function bytesFrom(length: number, fn: (i: number) => number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => fn(i));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hexToBytes: odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Hard-fail on any drift between the live TS path and a frozen KAT. */
function katAssert(field: string, computed: string, frozen: string): void {
  if (computed !== frozen) {
    throw new Error(
      `pairing KAT drift on ${field}: live TS computed ${computed} but the ` +
        `frozen oracle says ${frozen} — DO NOT overwrite the fixture; ` +
        "investigate the implementation change first",
    );
  }
}

const p = await ensureSodium();
await sodium.ready;

// ── kdf: BLAKE2b domain-separated derivations from the pairing secret ────────

const pairingSecret = bytesFrom(32, (i) => i);
const relayToken = await deriveRelayToken(pairingSecret);
const registrationProof = await deriveRegistrationProof(pairingSecret);
// These two return lowercase-hex STRINGS (stored verbatim, no re-hex);
// deriveKxKey/derivePushSealKey return bytes (hexed here). Guard the mixup.
const HEX64 = /^[0-9a-f]{64}$/;
if (!HEX64.test(relayToken) || !HEX64.test(registrationProof)) {
  throw new Error("kdf: relayToken/registrationProof are not 64-char hex");
}
const kdf = {
  pairingSecret_hex: p.toHex(pairingSecret),
  relayToken,
  kxKey_hex: p.toHex(await deriveKxKey(pairingSecret)),
  registrationProof,
  pushSealKey_hex: p.toHex(await derivePushSealKey(pairingSecret)),
};

// ── aead / aead_aad: fixed-nonce XChaCha20-Poly1305 seals ────────────────────

const aeadKey = bytesFrom(32, (i) => 0x40 + i);
const aeadNonce = bytesFrom(24, (i) => 0x80 + i);
const plaintextUtf8 = "hello teleprompter wire";
const plaintext = p.fromString(plaintextUtf8);

const ctTag = p.aeadEncrypt(plaintext, null, aeadNonce, aeadKey);
const aeadEncoded = p.toBase64(concatBytes(aeadNonce, ctTag));
if (p.toHex(await decrypt(aeadEncoded, aeadKey)) !== p.toHex(plaintext)) {
  throw new Error("aead: live decrypt() round-trip failed");
}
const aead = {
  key_hex: p.toHex(aeadKey),
  nonce_hex: p.toHex(aeadNonce),
  plaintext_utf8: plaintextUtf8,
  encoded_b64: aeadEncoded,
  ct_tag_hex: p.toHex(ctTag),
};

const aadUtf8 = "frontend-A.sid-123";
const aad = p.fromString(aadUtf8);
const ctTagAad = p.aeadEncrypt(plaintext, aad, aeadNonce, aeadKey);
const aeadAadEncoded = p.toBase64(concatBytes(aeadNonce, ctTagAad));
if (
  p.toHex(await openWithAad(aeadAadEncoded, aeadKey, aad)) !==
  p.toHex(plaintext)
) {
  throw new Error("aead_aad: live openWithAad() round-trip failed");
}
const aeadAad = {
  aad_utf8: aadUtf8,
  encoded_b64: aeadAadEncoded,
};

// ── kx: seeded keypairs → live session-key derivation ────────────────────────

const daemonSeed = bytesFrom(32, (i) => i);
const frontendSeed = bytesFrom(32, (i) => 0xff - i);
const daemonKp = sodium.crypto_kx_seed_keypair(daemonSeed);
const frontendKp = sodium.crypto_kx_seed_keypair(frontendSeed);
// Bind the direct-libsodium step back to the provider seam:
// crypto_kx_seed_keypair's secret key is exactly BLAKE2b-32(seed).
if (
  p.toHex(p.genericHash32(daemonSeed)) !== p.toHex(daemonKp.privateKey) ||
  p.toHex(p.genericHash32(frontendSeed)) !== p.toHex(frontendKp.privateKey)
) {
  throw new Error("kx: seed keypair sk != genericHash32(seed)");
}

const daemonKeys = await deriveSessionKeys(
  { publicKey: daemonKp.publicKey, secretKey: daemonKp.privateKey },
  frontendKp.publicKey,
  "daemon",
);
const frontendKeys = await deriveSessionKeys(
  { publicKey: frontendKp.publicKey, secretKey: frontendKp.privateKey },
  daemonKp.publicKey,
  "frontend",
);
// Crossover invariant — also transitively proves pk == basemult(sk) for both
// keypairs (the two ECDH shared points only agree when the pks are genuine).
if (
  p.toHex(daemonKeys.tx) !== p.toHex(frontendKeys.rx) ||
  p.toHex(daemonKeys.rx) !== p.toHex(frontendKeys.tx)
) {
  throw new Error("kx: session-key crossover invariant failed");
}
const kx = {
  daemonSeed_hex: p.toHex(daemonSeed),
  frontendSeed_hex: p.toHex(frontendSeed),
  daemonPk_hex: p.toHex(daemonKp.publicKey),
  daemonSk_hex: p.toHex(daemonKp.privateKey),
  frontendPk_hex: p.toHex(frontendKp.publicKey),
  frontendSk_hex: p.toHex(frontendKp.privateKey),
  daemon_rx_hex: p.toHex(daemonKeys.rx),
  daemon_tx_hex: p.toHex(daemonKeys.tx),
  frontend_rx_hex: p.toHex(frontendKeys.rx),
  frontend_tx_hex: p.toHex(frontendKeys.tx),
};

// ── ratchet: per-session key derivation from the kx base keys ────────────────

const ratchetSid = "sess-xyz";
const daemonRatchet = await ratchetSessionKeys(
  daemonKeys,
  ratchetSid,
  "daemon",
);
const frontendRatchet = await ratchetSessionKeys(
  frontendKeys,
  ratchetSid,
  "frontend",
);
if (
  p.toHex(daemonRatchet.tx) !== p.toHex(frontendRatchet.rx) ||
  p.toHex(daemonRatchet.rx) !== p.toHex(frontendRatchet.tx)
) {
  throw new Error("ratchet: session-key crossover invariant failed");
}
const ratchet = {
  sid: ratchetSid,
  daemon_tx_hex: p.toHex(daemonRatchet.tx),
  daemon_rx_hex: p.toHex(daemonRatchet.rx),
  frontend_tx_hex: p.toHex(frontendRatchet.tx),
  frontend_rx_hex: p.toHex(frontendRatchet.rx),
};

// ── codec: framed-JSON encode (json-only + binary sidecar) ───────────────────

const envelope = {
  t: "frame",
  sid: "sess-xyz",
  seq: 7,
  k: "io",
  ns: "claude",
  d: { hi: 1 },
};
// Guard the three-way literal duplication (this envelope / the fixture's
// embedded copy / `canonical_json` in wire_vectors.rs): its JSON.stringify
// output IS the byte contract the Rust test hard-codes.
const CANONICAL_ENVELOPE =
  '{"t":"frame","sid":"sess-xyz","seq":7,"k":"io","ns":"claude","d":{"hi":1}}';
if (JSON.stringify(envelope) !== CANONICAL_ENVELOPE) {
  throw new Error("codec: envelope key order drifted from the canonical JSON");
}
const binEnvelope = { t: "frame", sid: "s", k: "io" };
// Duplicated as a raw string in wire_vectors.rs codec_encode_matches_ts.
const CANONICAL_BIN_ENVELOPE = '{"t":"frame","sid":"s","k":"io"}';
if (JSON.stringify(binEnvelope) !== CANONICAL_BIN_ENVELOPE) {
  throw new Error("codec: binary-sidecar envelope key order drifted");
}
const codec = {
  json_only_hex: p.toHex(encodeFrame(envelope)),
  json_only_envelope: envelope,
  with_binary_hex: p.toHex(
    encodeFrame(binEnvelope, Uint8Array.from([1, 2, 3, 4, 5])),
  ),
};

// ── pairing: FROZEN independent KATs — verify-then-emit, never overwrite ─────

const PCT = {
  pairingId_hex: "000102030405060708090a0b0c0d0e0f",
  daemonId: "daemon-abc123",
  hostname: "my-macbook",
  daemonPk_hex:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  frontendPk_hex:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tx_hex: "2222222222222222222222222222222222222222222222222222222222222222",
  rx_hex: "1111111111111111111111111111111111111111111111111111111111111111",
  tag_hex: "b79d189afaab37980bf1ac62c4d3949f76a12e18badea52854aadb5f5661561c",
};
katAssert(
  "pct.tag_hex",
  p.toHex(
    await derivePairingConfirmationTag({
      pairingId: hexToBytes(PCT.pairingId_hex),
      daemonId: PCT.daemonId,
      hostname: PCT.hostname,
      daemonPubKey: hexToBytes(PCT.daemonPk_hex),
      frontendPubKey: hexToBytes(PCT.frontendPk_hex),
      tx: hexToBytes(PCT.tx_hex),
      rx: hexToBytes(PCT.rx_hex),
    }),
  ),
  PCT.tag_hex,
);

const PCT_EQUAL_KEYS = {
  pairingId_hex: "000102030405060708090a0b0c0d0e0f",
  daemonId: "daemon-abc123",
  hostname: "my-macbook",
  daemonPk_hex:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  frontendPk_hex:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  key_hex: "3333333333333333333333333333333333333333333333333333333333333333",
  tag_hex: "456cd9638cab506ff41e359a63cba24382ca00d312902ac17fa64494ec7892a1",
};
katAssert(
  "pct_equal_keys.tag_hex",
  p.toHex(
    await derivePairingConfirmationTag({
      pairingId: hexToBytes(PCT_EQUAL_KEYS.pairingId_hex),
      daemonId: PCT_EQUAL_KEYS.daemonId,
      hostname: PCT_EQUAL_KEYS.hostname,
      daemonPubKey: hexToBytes(PCT_EQUAL_KEYS.daemonPk_hex),
      frontendPubKey: hexToBytes(PCT_EQUAL_KEYS.frontendPk_hex),
      tx: hexToBytes(PCT_EQUAL_KEYS.key_hex),
      rx: hexToBytes(PCT_EQUAL_KEYS.key_hex),
    }),
  ),
  PCT_EQUAL_KEYS.tag_hex,
);

const LEGACY_PAIRING_ID = {
  daemonId: "daemon-abc123",
  uuid: "713e132d-ea6f-81eb-874e-91f282aba04b",
};
katAssert(
  "legacyPairingId.uuid",
  await deriveLegacyPairingId(LEGACY_PAIRING_ID.daemonId),
  LEGACY_PAIRING_ID.uuid,
);

const V4_ENCODE = {
  ps_hex: "0101010101010101010101010101010101010101010101010101010101010101",
  pk_hex: "0202020202020202020202020202020202020202020202020202020202020202",
  relay: "wss://relay.tpmt.dev",
  did: "daemon-abc123",
  pairingId: "00010203-0405-0607-0809-0a0b0c0d0e0f",
  hostname: "my-macbook",
  url: "tp://p?d=dHAEBmFiYzEyMwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAECAwQFBgcICQoLDA0ODwpteS1tYWNib29r",
};
const v4Data: PairingData = {
  ps: p.toBase64(hexToBytes(V4_ENCODE.ps_hex)),
  pk: p.toBase64(hexToBytes(V4_ENCODE.pk_hex)),
  relay: V4_ENCODE.relay,
  did: V4_ENCODE.did,
  v: 4,
  pairingId: V4_ENCODE.pairingId,
  hostname: V4_ENCODE.hostname,
};
katAssert("v4Encode.url", encodePairingData(v4Data), V4_ENCODE.url);
const v4Back = decodePairingData(V4_ENCODE.url);
if (
  v4Back.did !== v4Data.did ||
  v4Back.pairingId !== v4Data.pairingId ||
  v4Back.hostname !== v4Data.hostname ||
  v4Back.v !== 4 ||
  v4Back.ps !== v4Data.ps ||
  v4Back.pk !== v4Data.pk
) {
  throw new Error("pairing: v4 encode→decode round-trip drifted");
}

const V3_DECODE = {
  url: "tp://p?d=dHADBmFiYzEyMwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC",
  did: "daemon-abc123",
  ps_hex: "0101010101010101010101010101010101010101010101010101010101010101",
  pk_hex: "0202020202020202020202020202020202020202020202020202020202020202",
  v: 3,
};
const v3Back = decodePairingData(V3_DECODE.url);
katAssert("v3Decode.did", v3Back.did, V3_DECODE.did);
katAssert("v3Decode.ps", v3Back.ps, p.toBase64(hexToBytes(V3_DECODE.ps_hex)));
katAssert("v3Decode.pk", v3Back.pk, p.toBase64(hexToBytes(V3_DECODE.pk_hex)));
if (v3Back.v !== 3 || v3Back.pairingId !== "" || v3Back.hostname !== "") {
  throw new Error("pairing: v3 decode legacy-compat fields drifted");
}

const pairing = {
  _comment:
    "Cross vectors for PCT + legacy pairing-id + v4 QR encode. KATs computed independently (Python hashlib.blake2b digest_size=32 = libsodium crypto_generichash) and frozen in rust/tp-core/src/{crypto,pairing}.rs.",
  pct: {
    _comment:
      "tx>rx lexicographically → exercises min/max swap. pairingId = 0x00..0x0f raw.",
    ...PCT,
  },
  pct_equal_keys: {
    _comment: "tx == rx (0x33): min == max path.",
    ...PCT_EQUAL_KEYS,
  },
  legacyPairingId: LEGACY_PAIRING_ID,
  v4Encode: {
    _comment:
      "Byte-exact frozen v4 default-relay QR. ps=[1;32], pk=[2;32], relay=default (empty on wire), did=daemon-abc123, pairingId=0x00..0x0f, hostname=my-macbook.",
    ...V4_ENCODE,
  },
  v3Decode: {
    _comment:
      "A v3 bundle (…|pk, no pairingId/hostname) still decodes; new fields come back empty.",
    ...V3_DECODE,
  },
};

// ── write (only reached when every assert above passed) ──────────────────────

const fixture = { kdf, aead, aead_aad: aeadAad, kx, ratchet, codec, pairing };

const outPath = new URL(
  "../rust/tp-core/tests/fixtures/wire-vectors.json",
  import.meta.url,
);
await Bun.write(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.error(
  `wrote ${outPath.pathname} (kdf, aead, aead_aad, kx, ratchet, codec, ` +
    "pairing — every derived family from the live TS path, every frozen KAT " +
    "verified against it)",
);
