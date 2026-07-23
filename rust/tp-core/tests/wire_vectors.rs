//! Cross-implementation equivalence: the Rust core must produce byte-identical
//! output to the reference TypeScript implementation (libsodium-wrappers).
//!
//! The fixture `tests/fixtures/wire-vectors.json` was generated from the live TS
//! path (`scripts/gen-wire-vectors.ts`) before that generator was deleted in the
//! "#5 zero-Bun cascade" PR6 (#933); the Bun/Node toolchain itself was removed in
//! PR7 (#935). The checked-in vectors are now the frozen byte-exact source of
//! truth — these tests fail loudly if Rust diverges from them. To regenerate
//! (only if the wire format or KDF changes), check out the pre-deletion commit
//! from git history (last verified regeneration: PR5 #929) and rerun the script
//! there.

use serde_json::Value;
use tp_core::{codec, crypto, error, pairing};

fn fixture() -> Value {
    let raw = include_str!("fixtures/wire-vectors.json");
    serde_json::from_str(raw).expect("fixture parses")
}

fn hex_bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("valid hex")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

#[test]
fn kdf_domains_match_ts() {
    let f = fixture();
    let ps = hex_bytes(&f["kdf"]["pairingSecret_hex"]);
    assert_eq!(crypto::derive_relay_token(&ps), s(&f["kdf"]["relayToken"]));
    assert_eq!(
        crypto::derive_registration_proof(&ps),
        s(&f["kdf"]["registrationProof"])
    );
    assert_eq!(
        hex::encode(crypto::derive_kx_key(&ps)),
        s(&f["kdf"]["kxKey_hex"])
    );
    assert_eq!(
        hex::encode(crypto::derive_push_seal_key(&ps)),
        s(&f["kdf"]["pushSealKey_hex"])
    );
}

#[test]
fn aead_seal_matches_ts() {
    let f = fixture();
    let key = hex_bytes(&f["aead"]["key_hex"]);
    let nonce = hex_bytes(&f["aead"]["nonce_hex"]);
    let pt = s(&f["aead"]["plaintext_utf8"]).as_bytes();
    let encoded = crypto::seal(pt, &key, &nonce).unwrap();
    assert_eq!(encoded, s(&f["aead"]["encoded_b64"]));
    // round-trip decrypt
    let dec = crypto::open(&encoded, &key).unwrap();
    assert_eq!(dec, pt);
}

#[test]
fn aead_aad_seal_matches_ts() {
    let f = fixture();
    let key = hex_bytes(&f["aead"]["key_hex"]);
    let nonce = hex_bytes(&f["aead"]["nonce_hex"]);
    let pt = s(&f["aead"]["plaintext_utf8"]).as_bytes();
    let aad = s(&f["aead_aad"]["aad_utf8"]).as_bytes();
    let encoded = crypto::seal_with_aad(pt, &key, aad, &nonce).unwrap();
    assert_eq!(encoded, s(&f["aead_aad"]["encoded_b64"]));
    assert_eq!(crypto::open_with_aad(&encoded, &key, aad).unwrap(), pt);
}

#[test]
fn kx_session_keys_match_ts() {
    let f = fixture();
    // Reproduce the keypairs from the same seeds the TS side used.
    let d_seed = hex_bytes(&f["kx"]["daemonSeed_hex"]);
    let f_seed = hex_bytes(&f["kx"]["frontendSeed_hex"]);
    let d = crypto::kx_seed_keypair(&d_seed).unwrap();
    let fe = crypto::kx_seed_keypair(&f_seed).unwrap();

    // Keypairs themselves must match libsodium byte-for-byte.
    assert_eq!(hex::encode(d.public_key), s(&f["kx"]["daemonPk_hex"]));
    assert_eq!(hex::encode(d.secret_key), s(&f["kx"]["daemonSk_hex"]));
    assert_eq!(hex::encode(fe.public_key), s(&f["kx"]["frontendPk_hex"]));
    assert_eq!(hex::encode(fe.secret_key), s(&f["kx"]["frontendSk_hex"]));

    let ds = crypto::kx_server_session_keys(&d.public_key, &d.secret_key, &fe.public_key);
    let fc = crypto::kx_client_session_keys(&fe.public_key, &fe.secret_key, &d.public_key);
    assert_eq!(hex::encode(ds.rx), s(&f["kx"]["daemon_rx_hex"]));
    assert_eq!(hex::encode(ds.tx), s(&f["kx"]["daemon_tx_hex"]));
    assert_eq!(hex::encode(fc.rx), s(&f["kx"]["frontend_rx_hex"]));
    assert_eq!(hex::encode(fc.tx), s(&f["kx"]["frontend_tx_hex"]));
    // crossover invariant
    assert_eq!(ds.rx, fc.tx);
    assert_eq!(ds.tx, fc.rx);
}

#[test]
fn ratchet_matches_ts() {
    let f = fixture();
    let d_seed = hex_bytes(&f["kx"]["daemonSeed_hex"]);
    let f_seed = hex_bytes(&f["kx"]["frontendSeed_hex"]);
    let d = crypto::kx_seed_keypair(&d_seed).unwrap();
    let fe = crypto::kx_seed_keypair(&f_seed).unwrap();
    let ds = crypto::kx_server_session_keys(&d.public_key, &d.secret_key, &fe.public_key);
    let fc = crypto::kx_client_session_keys(&fe.public_key, &fe.secret_key, &d.public_key);

    let sid = s(&f["ratchet"]["sid"]);
    let dr = crypto::ratchet_session_keys(&ds, sid, true);
    let fr = crypto::ratchet_session_keys(&fc, sid, false);
    assert_eq!(hex::encode(dr.tx), s(&f["ratchet"]["daemon_tx_hex"]));
    assert_eq!(hex::encode(dr.rx), s(&f["ratchet"]["daemon_rx_hex"]));
    assert_eq!(hex::encode(fr.tx), s(&f["ratchet"]["frontend_tx_hex"]));
    assert_eq!(hex::encode(fr.rx), s(&f["ratchet"]["frontend_rx_hex"]));
    // ratcheted keys still cross over
    assert_eq!(dr.tx, fr.rx);
    assert_eq!(dr.rx, fr.tx);
}

#[test]
fn codec_encode_matches_ts() {
    let f = fixture();
    // The TS fixture stringified this exact envelope. Reproduce the same JSON
    // bytes (serde_json with the same key order via a manual string) and encode.
    let env = &f["codec"]["json_only_envelope"];
    // serde_json preserves insertion order for Value::Object only if the
    // `preserve_order` feature is on; to be safe, build the canonical JSON the
    // way JSON.stringify would for THIS object.
    let json = canonical_json(env);
    let frame = codec::encode_frame(json.as_bytes(), None);
    assert_eq!(hex::encode(&frame), s(&f["codec"]["json_only_hex"]));

    // Binary sidecar case.
    let json_b = r#"{"t":"frame","sid":"s","k":"io"}"#;
    let frame_b = codec::encode_frame(json_b.as_bytes(), Some(&[1, 2, 3, 4, 5]));
    assert_eq!(hex::encode(&frame_b), s(&f["codec"]["with_binary_hex"]));
}

/// Reproduce JS `JSON.stringify` output for the small fixed envelope. JS emits
/// keys in insertion order with no spaces. The fixture's object key order is
/// the literal-declaration order: t, sid, seq, k, ns, d.
fn canonical_json(_v: &Value) -> String {
    // Hard-code the exact envelope from the generator (keeps this test
    // independent of serde's map ordering).
    r#"{"t":"frame","sid":"sess-xyz","seq":7,"k":"io","ns":"claude","d":{"hi":1}}"#.to_string()
}

#[test]
fn decode_round_trips_encoded_frame() {
    // Decode the TS-produced json-only frame and confirm the JSON bytes match.
    let f = fixture();
    let frame_hex = s(&f["codec"]["json_only_hex"]);
    let frame = hex::decode(frame_hex).unwrap();
    let mut dec = codec::FrameDecoder::new();
    let frames = dec.decode(&frame).unwrap();
    assert_eq!(frames.len(), 1);
    let parsed: Value = serde_json::from_slice(&frames[0].json).unwrap();
    assert_eq!(parsed["sid"], "sess-xyz");
    assert_eq!(parsed["seq"], 7);
    assert!(frames[0].binary.is_none());
}

#[test]
fn error_variants_are_constructible() {
    // Compile-time check that the error surface is wired (used by Swift catch).
    let e = error::TpError::Crypto("x".into());
    assert!(format!("{e}").contains("crypto error"));
}

fn arr16(v: &Value) -> [u8; 16] {
    hex_bytes(v).try_into().expect("16 bytes")
}

fn arr32(v: &Value) -> [u8; 32] {
    hex_bytes(v).try_into().expect("32 bytes")
}

#[test]
fn pct_matches_ts() {
    let f = fixture();
    let p = &f["pairing"]["pct"];
    let tag = crypto::derive_pairing_confirmation_tag(
        &arr16(&p["pairingId_hex"]),
        s(&p["daemonId"]),
        s(&p["hostname"]),
        &arr32(&p["daemonPk_hex"]),
        &arr32(&p["frontendPk_hex"]),
        &arr32(&p["tx_hex"]),
        &arr32(&p["rx_hex"]),
    );
    assert_eq!(hex::encode(tag), s(&p["tag_hex"]));
}

#[test]
fn pct_equal_keys_matches_ts() {
    let f = fixture();
    let p = &f["pairing"]["pct_equal_keys"];
    let k = arr32(&p["key_hex"]);
    let tag = crypto::derive_pairing_confirmation_tag(
        &arr16(&p["pairingId_hex"]),
        s(&p["daemonId"]),
        s(&p["hostname"]),
        &arr32(&p["daemonPk_hex"]),
        &arr32(&p["frontendPk_hex"]),
        &k,
        &k,
    );
    assert_eq!(hex::encode(tag), s(&p["tag_hex"]));
}

#[test]
fn legacy_pairing_id_matches_ts() {
    let f = fixture();
    let p = &f["pairing"]["legacyPairingId"];
    assert_eq!(
        crypto::derive_legacy_pairing_id(s(&p["daemonId"])),
        s(&p["uuid"])
    );
}

#[test]
fn v4_encode_matches_ts() {
    let f = fixture();
    let p = &f["pairing"]["v4Encode"];
    let data = pairing::PairingData {
        ps: base64_std(&hex_bytes(&p["ps_hex"])),
        pk: base64_std(&hex_bytes(&p["pk_hex"])),
        relay: s(&p["relay"]).to_string(),
        did: s(&p["did"]).to_string(),
        v: 4,
        pairing_id: s(&p["pairingId"]).to_string(),
        hostname: s(&p["hostname"]).to_string(),
    };
    let url = pairing::encode_pairing_data(&data).unwrap();
    assert_eq!(url, s(&p["url"]));
    // Round-trip: decoding the frozen URL restores every field.
    let back = pairing::decode_pairing_data(&url).unwrap();
    assert_eq!(back.did, data.did);
    assert_eq!(back.pairing_id, data.pairing_id);
    assert_eq!(back.hostname, data.hostname);
    assert_eq!(back.v, 4);
}

#[test]
fn v3_decode_matches_ts() {
    let f = fixture();
    let p = &f["pairing"]["v3Decode"];
    let back = pairing::decode_pairing_data(s(&p["url"])).unwrap();
    assert_eq!(back.v, 3);
    assert_eq!(back.did, s(&p["did"]));
    assert_eq!(back.ps, base64_std(&hex_bytes(&p["ps_hex"])));
    assert_eq!(back.pk, base64_std(&hex_bytes(&p["pk_hex"])));
    // v3 has no pairingId/hostname on the wire → empty.
    assert_eq!(back.pairing_id, "");
    assert_eq!(back.hostname, "");
}

/// Standard-alphabet base64 (matches the TS `toBase64`/Rust `b64_std_encode`
/// used for `ps`/`pk` fields in `PairingData`).
fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
