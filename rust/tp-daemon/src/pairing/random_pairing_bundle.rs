//! Random pairing-bundle assembly — port of `createPairingBundle`
//! (`packages/protocol/src/pairing.ts:123-152`), lib-internal to `tp-daemon`.
//!
//! # Why this isn't reused from `tp-core`
//!
//! `tp-core::crypto::kx_seed_keypair` is a **deterministic**, seed-derived
//! keypair generator (`sk = BLAKE2b-256(seed)` then `pk = X25519_base(sk)`) —
//! it exists for reproducible golden-vector tests. It is NOT equivalent to
//! the real libsodium `crypto_kx_keypair()` the TS daemon actually calls via
//! `generateKeyPair()` (`packages/protocol/src/crypto.ts:62-65` →
//! `crypto-provider-libsodium.ts:26` → `s.crypto_kx_keypair()`): real
//! libsodium generates the secret key from **raw random bytes** with no
//! hashing step. `tp-core` has no true-random keypair generator exposed
//! (it deliberately leaves nonce/randomness sourcing to the caller — see the
//! `rand_core` dependency comment in `tp-daemon`'s `Cargo.toml`), so this
//! module provides one directly via `x25519_dalek::StaticSecret`, mirroring
//! the pattern `tp-core::crypto` itself uses internally.
//!
//! This stays lib-internal to `tp-daemon` — no FFI/UniFFI surface change.

use rand_core::{OsRng, RngCore as _};
use tp_core::crypto::{derive_relay_token, KxKeyPair};
use tp_core::pairing::{encode_pairing_data, PairingData};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/// Genuinely-random X25519 keypair — the daemon-side analogue of libsodium's
/// `crypto_kx_keypair()` (raw random secret bytes, X25519 base-mult for the
/// public key; NO hashing step, unlike `tp_core::crypto::kx_seed_keypair`).
fn kx_random_keypair() -> KxKeyPair {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    KxKeyPair {
        public_key: *public.as_bytes(),
        secret_key: secret.to_bytes(),
    }
}

/// 32 genuinely-random bytes for the pairing secret (mirrors
/// `generatePairingSecret()`, `packages/protocol/src/pairing.ts`, which is
/// `p.randomBytes(32)` via libsodium). `Zeroizing` wipes on drop.
fn random_pairing_secret() -> Zeroizing<Vec<u8>> {
    let mut bytes = vec![0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    Zeroizing::new(bytes)
}

/// A fresh random UUID v4, formatted canonically (mirrors `formatUuid` over
/// `p.randomBytes(16)` in `createPairingBundle`). We don't need RFC 4122
/// version/variant bits set — the wire format only requires 16 raw bytes
/// round-tripped as a UUID string (`tp-core::pairing::PairingData.pairing_id`
/// is read back as a bag of hex digits, not validated against the RFC bit
/// pattern), so plain random bytes formatted as 8-4-4-4-12 hex suffice and
/// match what the TS bundle already does not enforce either.
fn random_uuid_string() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The assembled bundle a fresh `PendingPairing::begin()` needs. Mirrors the
/// TS `PairingBundle` return shape of `createPairingBundle`.
pub struct PairingBundle {
    pub qr_string: String,
    pub key_pair: KxKeyPair,
    pub pairing_secret: Vec<u8>,
    pub relay_token: String,
    /// Wire pairing UUID minted into the QR (mirrors `bundle.qrData.pairingId`).
    pub pairing_id: String,
    /// Hostname exactly as emitted into the QR (mirrors `bundle.qrData.hostname`).
    pub hostname: String,
}

/// Build a fresh pairing bundle: random keypair + random pairing secret +
/// derived relay token + a freshly-minted pairing UUID, encoded into the
/// `tp://p?d=…` QR deep-link.
///
/// # Errors
/// Propagates any `tp_core::pairing::encode_pairing_data` error (e.g. an
/// oversized hostname is the caller's responsibility to pre-truncate, same
/// as the TS `safeHostname()` guard in `pairing-orchestrator.ts`).
pub fn random_pairing_bundle(
    relay_url: &str,
    daemon_id: &str,
    hostname: String,
) -> tp_core::error::Result<PairingBundle> {
    let key_pair = kx_random_keypair();
    let pairing_secret = random_pairing_secret();
    let relay_token = derive_relay_token(&pairing_secret);
    let pairing_id = random_uuid_string();

    let qr_data = PairingData {
        ps: base64_std_encode(&pairing_secret),
        pk: base64_std_encode(&key_pair.public_key),
        relay: relay_url.to_string(),
        did: daemon_id.to_string(),
        v: 4,
        pairing_id: pairing_id.clone(),
        hostname: hostname.clone(),
    };
    let qr_string = encode_pairing_data(&qr_data)?;

    Ok(PairingBundle {
        qr_string,
        key_pair,
        pairing_secret: pairing_secret.to_vec(),
        relay_token,
        pairing_id,
        hostname,
    })
}

fn base64_std_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_has_daemon_prefixed_id_and_nonempty_material() {
        let bundle =
            random_pairing_bundle("wss://relay.example", "daemon-abc123", "host".to_string())
                .expect("bundle should build");
        assert!(bundle.qr_string.starts_with("tp://p?d="));
        assert_eq!(bundle.key_pair.public_key.len(), 32);
        assert_eq!(bundle.key_pair.secret_key.len(), 32);
        assert_eq!(bundle.pairing_secret.len(), 32);
        assert!(!bundle.relay_token.is_empty());
        assert_eq!(bundle.pairing_id.len(), 36); // 8-4-4-4-12 with hyphens
        assert_eq!(bundle.hostname, "host");
    }

    #[test]
    fn two_bundles_are_never_identical() {
        // Genuinely-random generation: two calls must not collide (keypair,
        // secret, and pairing id are all independently random).
        let a = random_pairing_bundle("wss://relay.example", "daemon-a", String::new()).unwrap();
        let b = random_pairing_bundle("wss://relay.example", "daemon-a", String::new()).unwrap();
        assert_ne!(a.key_pair.public_key, b.key_pair.public_key);
        assert_ne!(a.pairing_secret, b.pairing_secret);
        assert_ne!(a.pairing_id, b.pairing_id);
    }
}
