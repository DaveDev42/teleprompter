//! tp-core — byte-exact wire primitives for the Teleprompter native app.
//!
//! ADR-0001 Phase 2. This crate ports the transport-agnostic core of
//! `packages/protocol` to Rust and exposes it to the Swift app through a
//! UniFFI-generated FFI. Everything here is a PURE FUNCTION: the same inputs
//! produce the same bytes as the reference TypeScript implementation. The
//! networking/relay/daemon layers stay in TypeScript for now (ADR-0001 Phase 4).
//!
//! Equivalence with the TS impl is pinned by golden vectors generated from the
//! live `libsodium-wrappers` path — see `tests/wire_vectors.rs`.

pub mod codec;
pub mod crypto;
pub mod error;
pub mod pairing;

use error::{Result, TpError};

uniffi::setup_scaffolding!();

// ── FFI-facing record/enum mirrors ──────────────────────────────────────────
// UniFFI records must own their fields. We mirror the internal types into
// FFI-friendly shapes (Vec<u8> instead of [u8; 32], etc.) at the boundary.

/// A decoded wire frame: JSON bytes plus an optional binary sidecar.
#[derive(uniffi::Record)]
pub struct FfiFrame {
    pub json: Vec<u8>,
    pub binary: Option<Vec<u8>>,
}

impl From<codec::DecodedFrame> for FfiFrame {
    fn from(f: codec::DecodedFrame) -> Self {
        FfiFrame {
            json: f.json,
            binary: f.binary,
        }
    }
}

/// A key-exchange keypair (32-byte public + secret keys).
#[derive(uniffi::Record)]
pub struct FfiKeyPair {
    pub public_key: Vec<u8>,
    pub secret_key: Vec<u8>,
}

/// Derived session keys (rx = decrypt-from-peer, tx = encrypt-to-peer).
#[derive(uniffi::Record)]
pub struct FfiSessionKeys {
    pub rx: Vec<u8>,
    pub tx: Vec<u8>,
}

impl From<crypto::SessionKeys> for FfiSessionKeys {
    fn from(k: crypto::SessionKeys) -> Self {
        FfiSessionKeys {
            rx: k.rx.to_vec(),
            tx: k.tx.to_vec(),
        }
    }
}

/// Decoded QR pairing data.
#[derive(uniffi::Record)]
pub struct FfiPairingData {
    pub ps: String,
    pub pk: String,
    pub relay: String,
    pub did: String,
    pub v: u8,
    /// Pairing id (canonical UUID string). Present from v4; empty for v2/v3.
    pub pairing_id: String,
    /// Daemon hostname (display label). Present from v4; empty for v2/v3.
    pub hostname: String,
}

impl From<pairing::PairingData> for FfiPairingData {
    fn from(d: pairing::PairingData) -> Self {
        FfiPairingData {
            ps: d.ps,
            pk: d.pk,
            relay: d.relay,
            did: d.did,
            v: d.v,
            pairing_id: d.pairing_id,
            hostname: d.hostname,
        }
    }
}

fn to_key32(v: &[u8], what: &str) -> Result<[u8; 32]> {
    v.try_into()
        .map_err(|_| TpError::InvalidInput(format!("{what} must be 32 bytes, got {}", v.len())))
}

// ── Codec ───────────────────────────────────────────────────────────────────

/// Encode a single frame from raw JSON bytes plus an optional binary sidecar.
#[uniffi::export]
pub fn encode_frame(json: Vec<u8>, binary: Option<Vec<u8>>) -> Vec<u8> {
    codec::encode_frame(&json, binary.as_deref())
}

/// Decode all complete frames contained in `chunk`. Stateless single-shot
/// helper (the Swift side keeps a [`FrameStream`] for streaming).
#[uniffi::export]
pub fn decode_frames(chunk: Vec<u8>) -> Result<Vec<FfiFrame>> {
    let mut dec = codec::FrameDecoder::new();
    Ok(dec.decode(&chunk)?.into_iter().map(Into::into).collect())
}

/// A stateful, streaming frame decoder usable across multiple chunk arrivals.
#[derive(uniffi::Object, Default)]
pub struct FrameStream {
    inner: std::sync::Mutex<codec::FrameDecoder>,
}

#[uniffi::export]
impl FrameStream {
    #[uniffi::constructor]
    pub fn new() -> Self {
        FrameStream {
            inner: std::sync::Mutex::new(codec::FrameDecoder::new()),
        }
    }

    /// Feed a chunk; return every complete frame now available.
    pub fn push(&self, chunk: Vec<u8>) -> Result<Vec<FfiFrame>> {
        let mut dec = self.inner.lock().unwrap();
        Ok(dec.decode(&chunk)?.into_iter().map(Into::into).collect())
    }

    pub fn reset(&self) {
        self.inner.lock().unwrap().reset();
    }
}

// ── Crypto: KDF ───────────────────────────────────────────────────────────────

#[uniffi::export]
pub fn derive_relay_token(pairing_secret: Vec<u8>) -> String {
    crypto::derive_relay_token(&pairing_secret)
}

#[uniffi::export]
pub fn derive_kx_key(pairing_secret: Vec<u8>) -> Vec<u8> {
    crypto::derive_kx_key(&pairing_secret).to_vec()
}

#[uniffi::export]
pub fn derive_registration_proof(pairing_secret: Vec<u8>) -> String {
    crypto::derive_registration_proof(&pairing_secret)
}

#[uniffi::export]
pub fn derive_push_seal_key(secret: Vec<u8>) -> Vec<u8> {
    crypto::derive_push_seal_key(&secret).to_vec()
}

#[uniffi::export]
pub fn generic_hash_32(input: Vec<u8>) -> Vec<u8> {
    crypto::generic_hash_32(&input).to_vec()
}

// ── Crypto: AEAD ──────────────────────────────────────────────────────────────

/// Encrypt → base64(nonce24 || ct || tag). `nonce` must be 24 bytes; the Swift
/// caller supplies a fresh random nonce per frame.
#[uniffi::export]
pub fn seal(plaintext: Vec<u8>, key: Vec<u8>, nonce: Vec<u8>) -> Result<String> {
    crypto::seal(&plaintext, &key, &nonce)
}

#[uniffi::export]
pub fn open(encoded: String, key: Vec<u8>) -> Result<Vec<u8>> {
    crypto::open(&encoded, &key)
}

#[uniffi::export]
pub fn seal_with_aad(
    plaintext: Vec<u8>,
    key: Vec<u8>,
    aad: Vec<u8>,
    nonce: Vec<u8>,
) -> Result<String> {
    crypto::seal_with_aad(&plaintext, &key, &aad, &nonce)
}

#[uniffi::export]
pub fn open_with_aad(encoded: String, key: Vec<u8>, aad: Vec<u8>) -> Result<Vec<u8>> {
    crypto::open_with_aad(&encoded, &key, &aad)
}

// ── Crypto: key exchange ──────────────────────────────────────────────────────

/// Deterministic keypair from a 32-byte seed (libsodium crypto_kx_seed_keypair).
#[uniffi::export]
pub fn kx_seed_keypair(seed: Vec<u8>) -> Result<FfiKeyPair> {
    let kp = crypto::kx_seed_keypair(&seed)?;
    Ok(FfiKeyPair {
        public_key: kp.public_key.to_vec(),
        secret_key: kp.secret_key.to_vec(),
    })
}

#[uniffi::export]
pub fn kx_server_session_keys(
    pk: Vec<u8>,
    sk: Vec<u8>,
    peer_pk: Vec<u8>,
) -> Result<FfiSessionKeys> {
    let keys = crypto::kx_server_session_keys(
        &to_key32(&pk, "pk")?,
        &to_key32(&sk, "sk")?,
        &to_key32(&peer_pk, "peer_pk")?,
    );
    Ok(keys.into())
}

#[uniffi::export]
pub fn kx_client_session_keys(
    pk: Vec<u8>,
    sk: Vec<u8>,
    peer_pk: Vec<u8>,
) -> Result<FfiSessionKeys> {
    let keys = crypto::kx_client_session_keys(
        &to_key32(&pk, "pk")?,
        &to_key32(&sk, "sk")?,
        &to_key32(&peer_pk, "peer_pk")?,
    );
    Ok(keys.into())
}

/// Per-session ratchet. `is_daemon` selects the tx/rx assignment.
#[uniffi::export]
pub fn ratchet_session_keys(
    base_rx: Vec<u8>,
    base_tx: Vec<u8>,
    sid: String,
    is_daemon: bool,
) -> Result<FfiSessionKeys> {
    let base = crypto::SessionKeys {
        rx: to_key32(&base_rx, "base_rx")?,
        tx: to_key32(&base_tx, "base_tx")?,
    };
    Ok(crypto::ratchet_session_keys(&base, &sid, is_daemon).into())
}

// ── Pairing ───────────────────────────────────────────────────────────────────

#[uniffi::export]
pub fn encode_pairing_data(data: FfiPairingData) -> Result<String> {
    pairing::encode_pairing_data(&pairing::PairingData {
        ps: data.ps,
        pk: data.pk,
        relay: data.relay,
        did: data.did,
        v: data.v,
        pairing_id: data.pairing_id,
        hostname: data.hostname,
    })
}

#[uniffi::export]
pub fn decode_pairing_data(raw: String) -> Result<FfiPairingData> {
    Ok(pairing::decode_pairing_data(&raw)?.into())
}

/// Derive the device-local **Pairing Confirmation Tag** (BLAKE2b-256 commit over
/// the ECDH session keys + pairing identity). See
/// [`crypto::derive_pairing_confirmation_tag`]. All byte-slice args are validated
/// to the exact fixed lengths (16 / 32) and error otherwise.
#[uniffi::export]
pub fn derive_pairing_confirmation_tag(
    pairing_id: Vec<u8>,
    daemon_id: String,
    hostname: String,
    daemon_pub_key: Vec<u8>,
    frontend_pub_key: Vec<u8>,
    tx: Vec<u8>,
    rx: Vec<u8>,
) -> Result<Vec<u8>> {
    let pid: [u8; 16] = pairing_id
        .as_slice()
        .try_into()
        .map_err(|_| TpError::InvalidInput("pairing_id must be 16 bytes".into()))?;
    let dpk = to_key32(&daemon_pub_key, "daemon_pub_key")?;
    let fpk = to_key32(&frontend_pub_key, "frontend_pub_key")?;
    let tx = to_key32(&tx, "tx")?;
    let rx = to_key32(&rx, "rx")?;
    Ok(
        crypto::derive_pairing_confirmation_tag(&pid, &daemon_id, &hostname, &dpk, &fpk, &tx, &rx)
            .to_vec(),
    )
}

/// Derive the stable legacy pairing-id (canonical UUID string) from a daemon id,
/// for records paired before the QR carried an explicit `pairingId`.
#[uniffi::export]
pub fn derive_legacy_pairing_id(daemon_id: String) -> String {
    crypto::derive_legacy_pairing_id(&daemon_id)
}

// ── Build / version sentinel ──────────────────────────────────────────────────

/// Returns the crate version — a trivial round-trippable call the Swift app
/// uses to confirm the FFI is linked and callable (ADR-0001 Phase 2 smoke).
#[uniffi::export]
pub fn tp_core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
