//! Boundary type guard for pairing rows read back out of SQLite.
//!
//! Byte-exact port of `packages/daemon/src/store/pairing-row-guard.ts`.
//! `Store::load_pairings` must not cast `SELECT * FROM pairings` rows straight
//! to a typed shape and hand the three BLOB columns (`public_key`,
//! `secret_key`, `pairing_secret`) to libsodium/crypto_kx with no validation —
//! a truncated, NULL, or wrong-length BLOB (crash mid-write, DB corruption, a
//! tampered store file) must not flow into key construction. This guard
//! narrows one raw row to a typed `StoredPairing` (or rejects it), enforcing
//! that every key column is exactly `PAIRING_KEY_BYTES` (32) bytes and that
//! the string columns are non-empty. A corrupt row is filtered out (logged +
//! skipped by the caller) rather than causing the whole load to fail.

use tp_proto::label::decode_wire_label;
use tp_proto::label::Label;

/// Byte length every pairing key column must have. X25519 public and secret
/// keys are 32 bytes (`crypto_kx_PUBLICKEYBYTES` / `crypto_kx_SECRETKEYBYTES`),
/// and the pairing secret is a 32-byte random value.
pub const PAIRING_KEY_BYTES: usize = 32;

/// A validated row from the `pairings` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPairing {
    pub daemon_id: String,
    pub relay_url: String,
    pub relay_token: String,
    pub registration_proof: String,
    pub public_key: Vec<u8>,
    pub secret_key: Vec<u8>,
    pub pairing_secret: Vec<u8>,
    pub label: Label,
    /// Stable pairing UUID (QR v4). `""` = unknown — a legacy row whose async
    /// `migrate_pairing_ids` backfill hasn't run yet.
    pub pairing_id: String,
    /// Daemon display hostname (QR v4). `""` for legacy rows.
    pub hostname: String,
}

/// The raw row shape read out of `SELECT * FROM pairings` before validation.
/// Callers construct this from whatever row-access API they use (rusqlite
/// `Row`, etc.) and pass it to [`parse_stored_pairing`].
#[derive(Debug, Clone, Default)]
pub struct RawPairingRow {
    pub daemon_id: Option<String>,
    pub relay_url: Option<String>,
    pub relay_token: Option<String>,
    pub registration_proof: Option<String>,
    pub created_at: Option<i64>,
    pub public_key: Option<Vec<u8>>,
    pub secret_key: Option<Vec<u8>>,
    pub pairing_secret: Option<Vec<u8>>,
    pub label: Option<String>,
    pub pairing_id: Option<String>,
    pub hostname: Option<String>,
}

fn is_non_empty(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|v| !v.is_empty())
}

fn to_key_bytes(value: &Option<Vec<u8>>, len: usize) -> Option<Vec<u8>> {
    let bytes = value.as_ref()?;
    if bytes.len() == len {
        Some(bytes.clone())
    } else {
        None
    }
}

/// Validate one raw row from the `pairings` table. Returns `None` if any
/// required field is missing, the wrong type, or a key column is not exactly
/// `PAIRING_KEY_BYTES` bytes.
#[must_use]
pub fn parse_stored_pairing(raw: &RawPairingRow) -> Option<StoredPairing> {
    if !is_non_empty(&raw.daemon_id) {
        return None;
    }
    if !is_non_empty(&raw.relay_url) {
        return None;
    }
    if !is_non_empty(&raw.relay_token) {
        return None;
    }
    if !is_non_empty(&raw.registration_proof) {
        return None;
    }
    raw.created_at?;

    let public_key = to_key_bytes(&raw.public_key, PAIRING_KEY_BYTES)?;
    let secret_key = to_key_bytes(&raw.secret_key, PAIRING_KEY_BYTES)?;
    let pairing_secret = to_key_bytes(&raw.pairing_secret, PAIRING_KEY_BYTES)?;

    // `label` is nullable; decode_wire_label normalizes NULL and a legacy ""
    // both to Unset, and accepts any string otherwise.
    let label_value = match &raw.label {
        Some(s) => serde_json::Value::String(s.clone()),
        None => serde_json::Value::Null,
    };
    let label = decode_wire_label(&label_value);

    // pairing_id/hostname are nullable (pre-v4 rows). NULL or absent
    // normalizes to "" — must never cause the row to be dropped.
    let pairing_id = raw.pairing_id.clone().unwrap_or_default();
    let hostname = raw.hostname.clone().unwrap_or_default();

    Some(StoredPairing {
        daemon_id: raw.daemon_id.clone().unwrap(),
        relay_url: raw.relay_url.clone().unwrap(),
        relay_token: raw.relay_token.clone().unwrap(),
        registration_proof: raw.registration_proof.clone().unwrap(),
        public_key,
        secret_key,
        pairing_secret,
        label,
        pairing_id,
        hostname,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_row() -> RawPairingRow {
        RawPairingRow {
            daemon_id: Some("d1".into()),
            relay_url: Some("wss://relay".into()),
            relay_token: Some("tok".into()),
            registration_proof: Some("proof".into()),
            created_at: Some(1000),
            public_key: Some(vec![1u8; PAIRING_KEY_BYTES]),
            secret_key: Some(vec![2u8; PAIRING_KEY_BYTES]),
            pairing_secret: Some(vec![3u8; PAIRING_KEY_BYTES]),
            label: None,
            pairing_id: None,
            hostname: None,
        }
    }

    #[test]
    fn accepts_valid_row() {
        let row = valid_row();
        let parsed = parse_stored_pairing(&row).expect("should parse");
        assert_eq!(parsed.daemon_id, "d1");
        assert_eq!(parsed.public_key.len(), PAIRING_KEY_BYTES);
        assert_eq!(parsed.label, Label::Unset);
        assert_eq!(parsed.pairing_id, "");
        assert_eq!(parsed.hostname, "");
    }

    #[test]
    fn rejects_short_key() {
        let mut row = valid_row();
        row.public_key = Some(vec![1u8; 31]);
        assert!(parse_stored_pairing(&row).is_none());
    }

    #[test]
    fn rejects_long_key() {
        let mut row = valid_row();
        row.secret_key = Some(vec![1u8; 33]);
        assert!(parse_stored_pairing(&row).is_none());
    }

    #[test]
    fn rejects_missing_key() {
        let mut row = valid_row();
        row.pairing_secret = None;
        assert!(parse_stored_pairing(&row).is_none());
    }

    #[test]
    fn rejects_empty_daemon_id() {
        let mut row = valid_row();
        row.daemon_id = Some(String::new());
        assert!(parse_stored_pairing(&row).is_none());
    }

    #[test]
    fn rejects_missing_created_at() {
        let mut row = valid_row();
        row.created_at = None;
        assert!(parse_stored_pairing(&row).is_none());
    }

    #[test]
    fn lenient_on_legacy_empty_pairing_id_and_hostname() {
        let mut row = valid_row();
        row.pairing_id = Some(String::new());
        row.hostname = None;
        let parsed = parse_stored_pairing(&row).expect("should parse");
        assert_eq!(parsed.pairing_id, "");
        assert_eq!(parsed.hostname, "");
    }

    #[test]
    fn decodes_label_string() {
        let mut row = valid_row();
        row.label = Some("Office Mac".into());
        let parsed = parse_stored_pairing(&row).expect("should parse");
        assert_eq!(
            parsed.label,
            Label::Set {
                value: "Office Mac".into()
            }
        );
    }
}
