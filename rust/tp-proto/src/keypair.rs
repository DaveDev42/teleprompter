//! Random key-exchange keypair generation.
//!
//! The one non-deterministic primitive `tp-core` deliberately lacks (it only
//! ships the seeded `kx_seed_keypair` for reproducible vectors). The TS
//! provider's `kxKeypair()` calls libsodium `crypto_kx_keypair()`, which is:
//!   sk = randombytes_buf(32)          // raw random, stored UNCLAMPED
//!   pk = crypto_scalarmult_base(sk)   // X25519 base mult (clamps a copy)
//!
//! We reproduce that byte-for-byte: pull 32 random bytes from the OS CSPRNG and
//! store them unclamped as the secret, then derive the public key via an X25519
//! base mult on a clamped working copy (`x25519_dalek::PublicKey::from`, which
//! clamps internally exactly like `crypto_scalarmult_base`).
//!
//! Storing the secret unclamped matters: a daemon that persists this secret and
//! later re-derives session keys must get the same X25519 result whether the key
//! came from Rust or from TS libsodium. Both clamp at scalarmult time, so an
//! unclamped-stored secret is the faithful shape. A future cutover can hand this
//! secret to `tp-core`'s `kx_*_session_keys` unchanged.

use rand_core::{OsRng, RngCore};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::ZeroizeOnDrop;

/// A freshly generated key-exchange keypair. Field byte-shapes match
/// `tp-core::crypto::KxKeyPair` and the TS `KeyPair` so a future cutover can
/// pass these straight into the existing KDF.
///
/// Debug is implemented manually to redact `secret_key` (a derived Debug would
/// print all 32 secret bytes in any `{:?}`/`dbg!` site). `ZeroizeOnDrop` wipes
/// the secret on drop — the bytes copied out of `StaticSecret` aren't covered by
/// dalek's own zeroization. Both are Drop/format-only; no wire or crypto change.
#[derive(Clone, PartialEq, Eq, ZeroizeOnDrop)]
pub struct KxKeyPair {
    pub public_key: [u8; 32],
    /// Raw random secret, stored UNCLAMPED (libsodium `crypto_kx_keypair`
    /// semantics — the clamp happens only inside the scalar mult).
    pub secret_key: [u8; 32],
}

impl std::fmt::Debug for KxKeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KxKeyPair")
            .field("public_key", &self.public_key)
            .field("secret_key", &"[redacted]")
            .finish()
    }
}

/// Generate a random X25519 key-exchange keypair from the OS CSPRNG.
///
/// Mirror of the TS provider's `kxKeypair()` (libsodium `crypto_kx_keypair`):
/// raw random secret stored unclamped, public derived via X25519 base mult.
pub fn generate_keypair() -> KxKeyPair {
    let mut sk = [0u8; 32];
    OsRng.fill_bytes(&mut sk);
    // StaticSecret::from clamps a working copy for the scalar mult but does not
    // mutate `sk`; PublicKey::from runs the base mult on the clamped copy.
    let secret = StaticSecret::from(sk);
    let public = PublicKey::from(&secret);
    KxKeyPair {
        public_key: *public.as_bytes(),
        secret_key: sk,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_distinct_nonzero_keypairs() {
        let a = generate_keypair();
        let b = generate_keypair();
        // Overwhelmingly likely distinct — a collision would mean a broken RNG.
        assert_ne!(a.secret_key, b.secret_key);
        assert_ne!(a.public_key, b.public_key);
        assert_ne!(a.secret_key, [0u8; 32]);
        assert_ne!(a.public_key, [0u8; 32]);
    }

    #[test]
    fn public_key_is_base_mult_of_secret() {
        // The public key must be reproducible from the stored secret via the
        // same base mult — proves the stored secret is the usable private key.
        let kp = generate_keypair();
        let rederived = PublicKey::from(&StaticSecret::from(kp.secret_key));
        assert_eq!(*rederived.as_bytes(), kp.public_key);
    }
}
