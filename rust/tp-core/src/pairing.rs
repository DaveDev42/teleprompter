//! QR pairing encode/decode — byte-exact port of
//! `packages/protocol/src/pairing.ts`.
//!
//! Wire format: `tp://p?d=<base64url(binary)>`
//!
//! Binary layout (v3):
//! ```text
//!   magic(2)="tp" | version(1)=3 |
//!   did_len(1) | did_bytes  (canonical "daemon-" prefix stripped) |
//!   relay_len(1) | relay_bytes  (relay_len=0 → default production relay) |
//!   ps(32) | pk(32)
//! ```
//! v2 additionally carried a trailing `label_len(1) | label_bytes` which the
//! decoder validates and discards (label now arrives via relay.kx).

use zeroize::Zeroizing;

use crate::error::{Result, TpError};

const PAIRING_URL_SCHEME: &str = "tp://p";
/// Upper bound on the base64url payload of a `tp://p?d=…` link, checked before
/// any allocation. A legitimate v2/v3 payload is ~772 chars; 2048 is far above
/// that yet rejects oversized input before the O(N) decode allocates.
const MAX_PAIRING_B64_LEN: usize = 2048;
const PAIRING_BINARY_MAGIC: &[u8] = b"tp";
const PAIRING_BINARY_VERSION: u8 = 3;
const DAEMON_ID_PREFIX: &str = "daemon-";
pub const DEFAULT_PAIRING_RELAY_URL: &str = "wss://relay.tpmt.dev";

/// Decoded pairing data (mirrors the TS `PairingData`).
#[derive(Debug, Clone, PartialEq)]
pub struct PairingData {
    /// Pairing secret, base64 (standard variant), 32 bytes.
    pub ps: String,
    /// Daemon public key, base64 (standard variant), 32 bytes.
    pub pk: String,
    /// Relay endpoint URL.
    pub relay: String,
    /// Daemon ID (with the canonical `daemon-` prefix).
    pub did: String,
    /// Protocol version that was decoded (2 or 3).
    pub v: u8,
}

fn normalize_relay_for_default_match(url: &str) -> String {
    url.trim().trim_end_matches('/').to_lowercase()
}

// ── base64 (standard) + base64url helpers — match pairing.ts exactly ────────

fn b64_std_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_std_decode(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|_| TpError::Pairing("Invalid pairing data format".into()))
}

fn b64url_encode(bytes: &[u8]) -> String {
    // pairing.ts: standard base64 then +→- /→_ and strip '='.
    b64_std_encode(bytes)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

fn b64url_decode(b64url: &str) -> Result<Vec<u8>> {
    let pad_len = (4 - (b64url.len() % 4)) % 4;
    let mut b64 = b64url.replace('-', "+").replace('_', "/");
    b64.push_str(&"=".repeat(pad_len));
    b64_std_decode(&b64)
}

/// Serialize pairing data to the `tp://p?d=<base64url>` deep-link (always v3).
pub fn encode_pairing_data(data: &PairingData) -> Result<String> {
    if !data.did.starts_with(DAEMON_ID_PREFIX) {
        return Err(TpError::Pairing(format!(
            "daemon id must start with \"{DAEMON_ID_PREFIX}\""
        )));
    }
    let wire_did = &data.did[DAEMON_ID_PREFIX.len()..];
    let did = wire_did.as_bytes();
    let use_default = normalize_relay_for_default_match(&data.relay)
        == normalize_relay_for_default_match(DEFAULT_PAIRING_RELAY_URL);
    let relay: Vec<u8> = if use_default {
        Vec::new()
    } else {
        data.relay.as_bytes().to_vec()
    };
    // Raw 32-byte secret / pubkey — wipe on drop (Zeroizing) so they don't
    // linger in freed heap after the encoded link is built.
    let ps = Zeroizing::new(b64_std_decode(&data.ps)?);
    let pk = Zeroizing::new(b64_std_decode(&data.pk)?);

    if did.is_empty() {
        return Err(TpError::Pairing(
            "daemon id suffix must not be empty".into(),
        ));
    }
    if did.len() > 255 {
        return Err(TpError::Pairing("daemon id exceeds 255 bytes".into()));
    }
    if relay.len() > 255 {
        return Err(TpError::Pairing("relay url exceeds 255 bytes".into()));
    }
    if ps.len() != 32 {
        return Err(TpError::Pairing("pairing secret must be 32 bytes".into()));
    }
    if pk.len() != 32 {
        return Err(TpError::Pairing(
            "daemon public key must be 32 bytes".into(),
        ));
    }

    let mut buf = Vec::with_capacity(2 + 1 + 1 + did.len() + 1 + relay.len() + 32 + 32);
    buf.extend_from_slice(PAIRING_BINARY_MAGIC);
    buf.push(PAIRING_BINARY_VERSION);
    buf.push(did.len() as u8);
    buf.extend_from_slice(did);
    buf.push(relay.len() as u8);
    buf.extend_from_slice(&relay);
    buf.extend_from_slice(&ps);
    buf.extend_from_slice(&pk);

    Ok(format!("{PAIRING_URL_SCHEME}?d={}", b64url_encode(&buf)))
}

/// Parse pairing data from a `tp://p?d=<base64url>` deep link.
pub fn decode_pairing_data(raw: &str) -> Result<PairingData> {
    let trimmed = raw.trim().trim_start_matches('\u{feff}');
    if !trimmed.starts_with(PAIRING_URL_SCHEME) {
        return Err(TpError::Pairing("Invalid pairing data format".into()));
    }
    let query_idx = trimmed
        .find('?')
        .ok_or_else(|| TpError::Pairing("Invalid pairing data format".into()))?;
    let query = &trimmed[query_idx + 1..];
    let d = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == "d")
        .map(|(_, v)| v)
        .ok_or_else(|| TpError::Pairing("Invalid pairing data format".into()))?;
    decode_binary_pairing(d)
}

fn err() -> TpError {
    TpError::Pairing("Invalid pairing data format".into())
}

fn decode_binary_pairing(b64: &str) -> Result<PairingData> {
    // Bound the input before allocating the decode buffers.
    if b64.len() > MAX_PAIRING_B64_LEN {
        return Err(err());
    }
    // `buf` holds the raw 32-byte pairing secret (`ps`) and pubkey (`pk`);
    // Zeroizing wipes it on drop so the secret doesn't linger in freed heap.
    let buf = Zeroizing::new(b64url_decode(b64)?);
    // minimum: magic(2) + ver(1) + did_len(1) + relay_len(1) + ps(32) + pk(32)
    if buf.len() < 2 + 1 + 1 + 1 + 32 + 32 {
        return Err(err());
    }
    let mut o = 0usize;
    if &buf[0..2] != PAIRING_BINARY_MAGIC {
        return Err(err());
    }
    o += 2;
    let version = buf[o];
    o += 1;
    if version != 2 && version != PAIRING_BINARY_VERSION {
        return Err(err());
    }

    let did_len = buf[o] as usize;
    o += 1;
    if did_len == 0 || o + did_len > buf.len() {
        return Err(err());
    }
    let wire_did = std::str::from_utf8(&buf[o..o + did_len]).map_err(|_| err())?;
    o += did_len;
    let did = if version == 2 {
        wire_did.to_string()
    } else {
        format!("{DAEMON_ID_PREFIX}{wire_did}")
    };

    let relay_len = buf[o] as usize;
    o += 1;
    if o + relay_len > buf.len() {
        return Err(err());
    }
    let relay = if relay_len == 0 {
        DEFAULT_PAIRING_RELAY_URL.to_string()
    } else {
        std::str::from_utf8(&buf[o..o + relay_len])
            .map_err(|_| err())?
            .to_string()
    };
    o += relay_len;

    if o + 32 + 32 > buf.len() {
        return Err(err());
    }
    let ps = &buf[o..o + 32];
    o += 32;
    let pk = &buf[o..o + 32];
    o += 32;

    // v2 carried a trailing label — validate its length but discard the value.
    if version == 2 {
        if o >= buf.len() {
            return Err(err());
        }
        let label_len = buf[o] as usize;
        o += 1;
        if o + label_len > buf.len() {
            return Err(err());
        }
    }

    Ok(PairingData {
        ps: b64_std_encode(ps),
        pk: b64_std_encode(pk),
        relay,
        did,
        v: version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PairingData {
        PairingData {
            ps: b64_std_encode(&[1u8; 32]),
            pk: b64_std_encode(&[2u8; 32]),
            relay: DEFAULT_PAIRING_RELAY_URL.to_string(),
            did: "daemon-abc123".to_string(),
            v: 3,
        }
    }

    #[test]
    fn round_trip_default_relay() {
        let data = sample();
        let url = encode_pairing_data(&data).unwrap();
        assert!(url.starts_with("tp://p?d="));
        let back = decode_pairing_data(&url).unwrap();
        assert_eq!(back.ps, data.ps);
        assert_eq!(back.pk, data.pk);
        assert_eq!(back.did, data.did);
        assert_eq!(back.relay, DEFAULT_PAIRING_RELAY_URL);
        assert_eq!(back.v, 3);
    }

    #[test]
    fn round_trip_custom_relay() {
        let mut data = sample();
        data.relay = "wss://my.relay.example:9000".to_string();
        let url = encode_pairing_data(&data).unwrap();
        let back = decode_pairing_data(&url).unwrap();
        assert_eq!(back.relay, "wss://my.relay.example:9000");
    }

    #[test]
    fn rejects_missing_prefix() {
        let mut data = sample();
        data.did = "abc123".to_string();
        assert!(encode_pairing_data(&data).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_pairing_data("not-a-pairing-url").is_err());
        assert!(decode_pairing_data("tp://p?d=@@@").is_err());
    }
}
