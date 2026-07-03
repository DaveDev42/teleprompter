//! E2EE crypto — byte-exact port of `packages/protocol/src/crypto.ts`
//! (which delegates to libsodium-wrappers via the CryptoProvider seam).
//!
//! Primitives, matched to libsodium exactly:
//!   - Key exchange: X25519 `crypto_kx` (BLAKE2b-512 KDF over the shared point)
//!   - AEAD: XChaCha20-Poly1305-IETF, 24-byte nonce PREPENDED to ct+tag
//!   - KDF / ratchet: BLAKE2b with 32-byte output (`crypto_generichash(32, ..)`)
//!   - base64: STANDARD (ORIGINAL) variant
//!
//! Equivalence is pinned by golden vectors generated from the live TS impl
//! (tests/fixtures/wire-vectors.json) — see tests/wire_vectors.rs.

use blake2::digest::generic_array::typenum::{U32, U64};
use blake2::digest::FixedOutput;
use blake2::Blake2b;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::ZeroizeOnDrop;

use crate::error::{Result, TpError};

/// XChaCha20-Poly1305-IETF nonce length (libsodium `NPUBBYTES`).
pub const NPUB_BYTES: usize = 24;
/// X25519 / crypto_kx key length.
pub const KEY_BYTES: usize = 32;
/// Poly1305 authentication-tag length (libsodium `ABYTES`). Every sealed blob is
/// `nonce(24) || ciphertext || tag(16)`, so the minimum valid length is 40.
pub const POLY1305_TAG_BYTES: usize = 16;

type Blake2b256 = Blake2b<U32>;
type Blake2b512 = Blake2b<U64>;

// ── BLAKE2b generic hash (crypto_generichash, outlen=32) ────────────────────

/// `crypto_generichash(32, input)` — keyless BLAKE2b with 32-byte output.
pub fn generic_hash_32(input: &[u8]) -> [u8; 32] {
    use blake2::Digest;
    let mut h = Blake2b256::new();
    h.update(input);
    h.finalize_fixed().into()
}

// ── KDF: H(secret || domain) → 32 bytes ─────────────────────────────────────

/// Shared BLAKE2b KDF: `H(secret || utf8(domain))`. Matches `deriveBlake2b`.
fn derive_blake2b(secret: &[u8], domain: &str) -> [u8; 32] {
    let mut input = Vec::with_capacity(secret.len() + domain.len());
    input.extend_from_slice(secret);
    input.extend_from_slice(domain.as_bytes());
    generic_hash_32(&input)
}

/// `H(pairing_secret || "relay-auth")`, hex-encoded.
pub fn derive_relay_token(pairing_secret: &[u8]) -> String {
    hex::encode(derive_blake2b(pairing_secret, "relay-auth"))
}

/// `H(pairing_secret || "kx-envelope")` — symmetric key for kx envelopes.
pub fn derive_kx_key(pairing_secret: &[u8]) -> [u8; 32] {
    derive_blake2b(pairing_secret, "kx-envelope")
}

/// `H(secret || "relay-push-seal")`.
pub fn derive_push_seal_key(secret: &[u8]) -> [u8; 32] {
    derive_blake2b(secret, "relay-push-seal")
}

/// `H(pairing_secret || "relay-register")`, hex-encoded.
pub fn derive_registration_proof(pairing_secret: &[u8]) -> String {
    hex::encode(derive_blake2b(pairing_secret, "relay-register"))
}

// ── Pairing Confirmation Tag (PCT) + legacy pairing-id ──────────────────────

/// Domain-separation tag for the PCT (`"tp-pairing-confirm"` + version byte).
const PCT_DOMAIN: &[u8] = b"tp-pairing-confirm\x01";
/// Domain-separation tag for the legacy pairing-id derivation.
const LEGACY_PAIRING_ID_DOMAIN: &[u8] = b"tp-pairing-id-legacy\x01";

/// Append a `u8`-length-prefixed byte string. Mirrors the QR wire convention
/// used for `did`/`hostname` (single-byte length; caller guarantees ≤255).
fn push_len_prefixed(buf: &mut Vec<u8>, bytes: &[u8]) {
    debug_assert!(bytes.len() <= u8::MAX as usize);
    buf.push(bytes.len() as u8);
    buf.extend_from_slice(bytes);
}

/// Derive the **Pairing Confirmation Tag** — a device-local BLAKE2b-256 commit
/// over the ECDH session keys and pairing identity, proving both peers reached
/// the same key agreement. Byte-exact twin of the TS `derivePairingConfirmationTag`.
///
/// ```text
/// PCT_INPUT := "tp-pairing-confirm\x01" (19 bytes)
///   || pairing_id (16 raw UUID bytes)
///   || u8_len(daemon_id) || daemon_id (utf-8)
///   || u8_len(hostname)  || hostname  (utf-8)
///   || daemon_pub_key (32) || frontend_pub_key (32)
///   || k_sort0 (32) = min(tx, rx)  // lexicographic
///   || k_sort1 (32) = max(tx, rx)
/// PCT := generic_hash_32(PCT_INPUT)  // BLAKE2b-256, 32 bytes
/// ```
///
/// `daemon_id`/`hostname` are truncated to 255 bytes defensively; callers pass
/// values already bounded by the QR encoder's 255-byte guard.
#[allow(clippy::too_many_arguments)]
pub fn derive_pairing_confirmation_tag(
    pairing_id: &[u8; 16],
    daemon_id: &str,
    hostname: &str,
    daemon_pub_key: &[u8; 32],
    frontend_pub_key: &[u8; 32],
    tx: &[u8; 32],
    rx: &[u8; 32],
) -> [u8; 32] {
    let did = daemon_id.as_bytes();
    let host = hostname.as_bytes();
    let (k_sort0, k_sort1) = if compare_bytes(tx, rx) != std::cmp::Ordering::Greater {
        (tx, rx)
    } else {
        (rx, tx)
    };

    let mut input = Vec::with_capacity(
        PCT_DOMAIN.len() + 16 + 1 + did.len() + 1 + host.len() + 32 + 32 + 32 + 32,
    );
    input.extend_from_slice(PCT_DOMAIN);
    input.extend_from_slice(pairing_id);
    push_len_prefixed(&mut input, &did[..did.len().min(u8::MAX as usize)]);
    push_len_prefixed(&mut input, &host[..host.len().min(u8::MAX as usize)]);
    input.extend_from_slice(daemon_pub_key);
    input.extend_from_slice(frontend_pub_key);
    input.extend_from_slice(k_sort0);
    input.extend_from_slice(k_sort1);
    generic_hash_32(&input)
}

/// Derive a stable legacy pairing-id from a daemon id, for records paired before
/// the QR carried an explicit `pairingId`. Byte-exact twin of the TS
/// `deriveLegacyPairingId`. Uses BLAKE2b (no UUIDv5/SHA-1 dependency), then
/// stamps the UUIDv8 version/variant nibbles so the result is a valid RFC-4122
/// UUID string.
///
/// ```text
/// digest = generic_hash_32("tp-pairing-id-legacy\x01" || utf8(daemon_id))
/// raw16  = digest[0..16]
/// raw16[6] = (raw16[6] & 0x0F) | 0x80   // version 8
/// raw16[8] = (raw16[8] & 0x3F) | 0x80   // RFC-4122 variant
/// → canonical 8-4-4-4-12 hex string
/// ```
pub fn derive_legacy_pairing_id(daemon_id: &str) -> String {
    let mut input = Vec::with_capacity(LEGACY_PAIRING_ID_DOMAIN.len() + daemon_id.len());
    input.extend_from_slice(LEGACY_PAIRING_ID_DOMAIN);
    input.extend_from_slice(daemon_id.as_bytes());
    let digest = generic_hash_32(&input);
    let mut raw = [0u8; 16];
    raw.copy_from_slice(&digest[0..16]);
    raw[6] = (raw[6] & 0x0F) | 0x80; // UUIDv8 version nibble
    raw[8] = (raw[8] & 0x3F) | 0x80; // RFC-4122 variant bits
    format_uuid(&raw)
}

/// Format 16 raw bytes as a canonical lowercase UUID (`8-4-4-4-12`).
pub(crate) fn format_uuid(raw: &[u8; 16]) -> String {
    let h = hex::encode(raw);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

// ── AEAD: XChaCha20-Poly1305-IETF ───────────────────────────────────────────

fn aead_cipher(key: &[u8]) -> Result<XChaCha20Poly1305> {
    if key.len() != KEY_BYTES {
        return Err(TpError::InvalidInput(format!(
            "AEAD key must be {KEY_BYTES} bytes, got {}",
            key.len()
        )));
    }
    // chacha20poly1305 0.11 switched generic-array → hybrid-array: a `&[u8]` no
    // longer implements `Into<&Key>`, so build the fixed-size `Key` explicitly.
    // The length is already validated above, so `try_from` cannot fail here.
    let key = Key::try_from(key).map_err(|_| TpError::Crypto("AEAD key length mismatch".into()))?;
    Ok(XChaCha20Poly1305::new(&key))
}

/// Encrypt with an explicit nonce and optional AAD, returning the combined
/// `ct || tag` blob (nonce NOT included — callers prepend it). Mirrors the
/// CryptoProvider `aeadEncrypt` contract.
fn aead_encrypt(plaintext: &[u8], aad: Option<&[u8]>, nonce: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != NPUB_BYTES {
        return Err(TpError::InvalidInput(format!(
            "nonce must be {NPUB_BYTES} bytes, got {}",
            nonce.len()
        )));
    }
    let cipher = aead_cipher(key)?;
    // 0.11: `from_slice` is deprecated in favor of fallible `try_from`. Length is
    // validated above, so this conversion is infallible in practice.
    let xn =
        XNonce::try_from(nonce).map_err(|_| TpError::Crypto("nonce length mismatch".into()))?;
    let payload = Payload {
        msg: plaintext,
        aad: aad.unwrap_or(&[]),
    };
    cipher
        .encrypt(&xn, payload)
        .map_err(|e| TpError::Crypto(format!("aead encrypt failed: {e}")))
}

fn aead_decrypt(
    ciphertext: &[u8],
    aad: Option<&[u8]>,
    nonce: &[u8],
    key: &[u8],
) -> Result<Vec<u8>> {
    if nonce.len() != NPUB_BYTES {
        return Err(TpError::InvalidInput(format!(
            "nonce must be {NPUB_BYTES} bytes, got {}",
            nonce.len()
        )));
    }
    let cipher = aead_cipher(key)?;
    // 0.11: `from_slice` is deprecated in favor of fallible `try_from`. Length is
    // validated above, so this conversion is infallible in practice.
    let xn =
        XNonce::try_from(nonce).map_err(|_| TpError::Crypto("nonce length mismatch".into()))?;
    let payload = Payload {
        msg: ciphertext,
        aad: aad.unwrap_or(&[]),
    };
    cipher
        .decrypt(&xn, payload)
        .map_err(|_| TpError::Crypto("aead authentication failed".into()))
}

fn b64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn b64_decode(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|e| TpError::Crypto(format!("base64 decode failed: {e}")))
}

/// `encrypt(plaintext, key)` → base64(nonce24 || ct || tag). Random nonce.
pub fn seal(plaintext: &[u8], key: &[u8], nonce: &[u8]) -> Result<String> {
    let ct = aead_encrypt(plaintext, None, nonce, key)?;
    let mut combined = Vec::with_capacity(nonce.len() + ct.len());
    combined.extend_from_slice(nonce);
    combined.extend_from_slice(&ct);
    Ok(b64_encode(&combined))
}

/// `decrypt(encoded, key)` — inverse of [`seal`].
pub fn open(encoded: &str, key: &[u8]) -> Result<Vec<u8>> {
    let combined = b64_decode(encoded)?;
    // Need at least nonce(24) + Poly1305 tag(16); a shorter blob can never carry
    // a valid AEAD ciphertext. (The AEAD also rejects it, but reject early with a
    // precise message.)
    if combined.len() < NPUB_BYTES + POLY1305_TAG_BYTES {
        return Err(TpError::Crypto(
            "sealed blob shorter than nonce + tag".into(),
        ));
    }
    let (nonce, ct) = combined.split_at(NPUB_BYTES);
    aead_decrypt(ct, None, nonce, key)
}

/// `sealWithAad(plaintext, key, aad)` → base64(nonce24 || ct || tag).
pub fn seal_with_aad(plaintext: &[u8], key: &[u8], aad: &[u8], nonce: &[u8]) -> Result<String> {
    let ct = aead_encrypt(plaintext, Some(aad), nonce, key)?;
    let mut combined = Vec::with_capacity(nonce.len() + ct.len());
    combined.extend_from_slice(nonce);
    combined.extend_from_slice(&ct);
    Ok(b64_encode(&combined))
}

/// `openWithAad(encoded, key, aad)` — inverse of [`seal_with_aad`].
pub fn open_with_aad(encoded: &str, key: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let combined = b64_decode(encoded)?;
    if combined.len() < NPUB_BYTES + POLY1305_TAG_BYTES {
        return Err(TpError::Crypto(
            "sealed blob shorter than nonce + tag".into(),
        ));
    }
    let (nonce, ct) = combined.split_at(NPUB_BYTES);
    aead_decrypt(ct, Some(aad), nonce, key)
}

// ── X25519 crypto_kx ────────────────────────────────────────────────────────

/// A key-exchange keypair.
///
/// `ZeroizeOnDrop` wipes `secret_key` (and `public_key`) when the value is
/// dropped — the bytes copied OUT of `x25519_dalek::StaticSecret` are not
/// covered by dalek's own zeroization. Drop-only; no wire/crypto change.
#[derive(Clone, ZeroizeOnDrop)]
pub struct KxKeyPair {
    pub public_key: [u8; 32],
    pub secret_key: [u8; 32],
}

/// Session keys derived from a completed key exchange.
///
/// `ZeroizeOnDrop` wipes `rx`/`tx` on drop. Debug is implemented manually to
/// redact the key bytes (a derived Debug would print them in any `{:?}` site).
#[derive(Clone, PartialEq, ZeroizeOnDrop)]
pub struct SessionKeys {
    /// Key for decrypting data received FROM the peer.
    pub rx: [u8; 32],
    /// Key for encrypting data sent TO the peer.
    pub tx: [u8; 32],
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionKeys")
            .field("rx", &"[redacted]")
            .field("tx", &"[redacted]")
            .finish()
    }
}

/// libsodium `crypto_kx_seed_keypair(seed)`:
///   sk = crypto_generichash(32, seed)   (BLAKE2b-256, keyless — NOT SHA-512)
///   pk = crypto_scalarmult_base(sk)     (X25519 base mult; clamps sk internally)
///
/// The exposed `secret_key` is the raw BLAKE2b-256 digest (unclamped), exactly
/// as libsodium returns it; the X25519 base-mult clamps a working copy.
/// Deterministic — used for reproducible test vectors and any seeded pairing.
pub fn kx_seed_keypair(seed: &[u8]) -> Result<KxKeyPair> {
    if seed.len() != 32 {
        return Err(TpError::InvalidInput(format!(
            "kx seed must be 32 bytes, got {}",
            seed.len()
        )));
    }
    let sk = generic_hash_32(seed);
    let secret = StaticSecret::from(sk);
    let public = PublicKey::from(&secret);
    Ok(KxKeyPair {
        public_key: *public.as_bytes(),
        secret_key: sk,
    })
}

/// The crypto_kx session-key KDF, shared by client and server. libsodium:
///   shared = X25519(sk, peer_pk)
///   keys   = BLAKE2b-512( shared || client_pk || server_pk )   (no key, no salt)
///   first 32 bytes → one direction, last 32 → the other.
///
/// For the CLIENT: rx = keys[0..32], tx = keys[32..64].
/// For the SERVER: rx = keys[32..64], tx = keys[0..32]   (mirrored).
fn kx_kdf(shared: &[u8; 32], client_pk: &[u8; 32], server_pk: &[u8; 32]) -> [u8; 64] {
    use blake2::Digest;
    let mut h = Blake2b512::new();
    h.update(shared);
    h.update(client_pk);
    h.update(server_pk);
    let out = h.finalize();
    let mut keys = [0u8; 64];
    keys.copy_from_slice(&out);
    keys
}

fn x25519_shared(sk: &[u8; 32], peer_pk: &[u8; 32]) -> [u8; 32] {
    let secret = StaticSecret::from(*sk);
    let peer = PublicKey::from(*peer_pk);
    *secret.diffie_hellman(&peer).as_bytes()
}

/// `crypto_kx_server_session_keys(pk, sk, peer_pk)` → { rx, tx }.
pub fn kx_server_session_keys(pk: &[u8; 32], sk: &[u8; 32], peer_pk: &[u8; 32]) -> SessionKeys {
    // Server: client_pk = peer_pk, server_pk = own pk.
    let shared = x25519_shared(sk, peer_pk);
    let keys = kx_kdf(&shared, peer_pk, pk);
    let mut tx = [0u8; 32];
    let mut rx = [0u8; 32];
    tx.copy_from_slice(&keys[0..32]); // server tx = keys[0..32]
    rx.copy_from_slice(&keys[32..64]); // server rx = keys[32..64]
    SessionKeys { rx, tx }
}

/// `crypto_kx_client_session_keys(pk, sk, peer_pk)` → { rx, tx }.
pub fn kx_client_session_keys(pk: &[u8; 32], sk: &[u8; 32], peer_pk: &[u8; 32]) -> SessionKeys {
    // Client: client_pk = own pk, server_pk = peer_pk.
    let shared = x25519_shared(sk, peer_pk);
    let keys = kx_kdf(&shared, pk, peer_pk);
    let mut rx = [0u8; 32];
    let mut tx = [0u8; 32];
    rx.copy_from_slice(&keys[0..32]); // client rx = keys[0..32]
    tx.copy_from_slice(&keys[32..64]); // client tx = keys[32..64]
    SessionKeys { rx, tx }
}

// ── Ephemeral session-key ratchet (role-independent) ────────────────────────

fn compare_bytes(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    a.cmp(b)
}

/// `ratchetSessionKeys(baseKeys, sid, role)` — derive per-session keys.
///   k_a = H(min(tx,rx) || sid || "a")
///   k_b = H(max(tx,rx) || sid || "b")
///   daemon: tx=k_a, rx=k_b ; frontend: tx=k_b, rx=k_a
pub fn ratchet_session_keys(base: &SessionKeys, sid: &str, is_daemon: bool) -> SessionKeys {
    let sid_bytes = sid.as_bytes();
    let tx_le_rx = compare_bytes(&base.tx, &base.rx) != std::cmp::Ordering::Greater;
    let (key_a, key_b) = if tx_le_rx {
        (&base.tx, &base.rx)
    } else {
        (&base.rx, &base.tx)
    };

    let mut input_a = Vec::with_capacity(32 + sid_bytes.len() + 1);
    input_a.extend_from_slice(key_a);
    input_a.extend_from_slice(sid_bytes);
    input_a.push(b'a');
    let k_a = generic_hash_32(&input_a);

    let mut input_b = Vec::with_capacity(32 + sid_bytes.len() + 1);
    input_b.extend_from_slice(key_b);
    input_b.extend_from_slice(sid_bytes);
    input_b.push(b'b');
    let k_b = generic_hash_32(&input_b);

    if is_daemon {
        SessionKeys { tx: k_a, rx: k_b }
    } else {
        SessionKeys { tx: k_b, rx: k_a }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aead_round_trip() {
        let key = [7u8; 32];
        let nonce = [9u8; 24];
        let pt = b"secret payload";
        let enc = seal(pt, &key, &nonce).unwrap();
        let dec = open(&enc, &key).unwrap();
        assert_eq!(dec, pt);
    }

    #[test]
    fn aead_aad_mismatch_fails() {
        let key = [7u8; 32];
        let nonce = [9u8; 24];
        let enc = seal_with_aad(b"x", &key, b"aad-1", &nonce).unwrap();
        assert!(open_with_aad(&enc, &key, b"aad-2").is_err());
    }

    #[test]
    fn open_rejects_blob_shorter_than_nonce_plus_tag() {
        let key = [7u8; 32];
        // A 24-byte blob (exactly the nonce, zero ciphertext+tag) must be
        // rejected by the length guard, not forwarded to the AEAD.
        let only_nonce = b64_encode(&[0u8; NPUB_BYTES]);
        let err = open(&only_nonce, &key).unwrap_err();
        assert!(matches!(err, TpError::Crypto(_)));
        // Just below the minimum (nonce + tag - 1) is still rejected.
        let nearly = b64_encode(&[0u8; NPUB_BYTES + POLY1305_TAG_BYTES - 1]);
        assert!(open(&nearly, &key).is_err());
        assert!(open_with_aad(&nearly, &key, b"aad").is_err());
    }

    #[test]
    fn kx_session_keys_cross() {
        // Two seeded keypairs; verify the daemon/frontend crossover.
        let d = kx_seed_keypair(&[1u8; 32]).unwrap();
        let f = kx_seed_keypair(&[2u8; 32]).unwrap();
        let ds = kx_server_session_keys(&d.public_key, &d.secret_key, &f.public_key);
        let fc = kx_client_session_keys(&f.public_key, &f.secret_key, &d.public_key);
        assert_eq!(ds.rx, fc.tx);
        assert_eq!(ds.tx, fc.rx);
    }

    // Known-answer vectors below are computed independently (Python
    // hashlib.blake2b(digest_size=32) = libsodium crypto_generichash) and are
    // the byte-exact contract the TS twin must reproduce (PR-2 cross vectors).

    #[test]
    fn pct_known_answer() {
        let pairing_id: [u8; 16] = std::array::from_fn(|i| i as u8); // 0x00..0x0f
        let daemon_pk = [0xAAu8; 32];
        let frontend_pk = [0xBBu8; 32];
        // tx > rx lexicographically → exercises the max/min swap.
        let tx = [0x22u8; 32];
        let rx = [0x11u8; 32];
        let pct = derive_pairing_confirmation_tag(
            &pairing_id,
            "daemon-abc123",
            "my-macbook",
            &daemon_pk,
            &frontend_pk,
            &tx,
            &rx,
        );
        assert_eq!(
            hex::encode(pct),
            "b79d189afaab37980bf1ac62c4d3949f76a12e18badea52854aadb5f5661561c"
        );
    }

    #[test]
    fn pct_sort_is_order_independent() {
        // Swapping tx/rx must yield the identical PCT (kSort0=min, kSort1=max).
        let pairing_id = [0u8; 16];
        let dpk = [1u8; 32];
        let fpk = [2u8; 32];
        let a = [0x05u8; 32];
        let b = [0x09u8; 32];
        let p1 = derive_pairing_confirmation_tag(&pairing_id, "d", "h", &dpk, &fpk, &a, &b);
        let p2 = derive_pairing_confirmation_tag(&pairing_id, "d", "h", &dpk, &fpk, &b, &a);
        assert_eq!(p1, p2);
    }

    #[test]
    fn pct_equal_keys_known_answer() {
        let pairing_id: [u8; 16] = std::array::from_fn(|i| i as u8);
        let k = [0x33u8; 32];
        let pct = derive_pairing_confirmation_tag(
            &pairing_id,
            "daemon-abc123",
            "my-macbook",
            &[0xAAu8; 32],
            &[0xBBu8; 32],
            &k,
            &k,
        );
        assert_eq!(
            hex::encode(pct),
            "456cd9638cab506ff41e359a63cba24382ca00d312902ac17fa64494ec7892a1"
        );
    }

    #[test]
    fn legacy_pairing_id_known_answer() {
        let id = derive_legacy_pairing_id("daemon-abc123");
        assert_eq!(id, "713e132d-ea6f-81eb-874e-91f282aba04b");
        // Structural: valid UUIDv8 (version nibble 8, RFC-4122 variant 8..b).
        let bytes = id.as_bytes();
        assert_eq!(bytes.len(), 36);
        assert_eq!(bytes[14], b'8'); // version nibble at position 14 (after "8-4-")
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn legacy_pairing_id_is_deterministic_and_distinct() {
        assert_eq!(
            derive_legacy_pairing_id("daemon-x"),
            derive_legacy_pairing_id("daemon-x")
        );
        assert_ne!(
            derive_legacy_pairing_id("daemon-x"),
            derive_legacy_pairing_id("daemon-y")
        );
    }
}
