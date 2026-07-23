//! QR pairing encode/decode — byte-exact port of
//! `packages/protocol/src/pairing.ts`.
//!
//! Wire format: `tp://p?d=<base64url(binary)>`
//!
//! Binary layout (v4 — additive over v3):
//! ```text
//!   magic(2)="tp" | version(1)=4 |
//!   did_len(1) | did_bytes  (canonical "daemon-" prefix stripped) |
//!   relay_len(1) | relay_bytes  (relay_len=0 → default production relay) |
//!   ps(32) | pk(32) |
//!   pairing_id(16 raw UUID bytes) |
//!   hostname_len(1) | hostname_bytes  (utf-8; may be empty)
//! ```
//! v3 stopped at `pk(32)` (no pairingId/hostname). v2 additionally carried a
//! trailing `label_len(1) | label_bytes` which the decoder validates and
//! discards (label now arrives via relay.kx). The decoder accepts v2/v3/v4;
//! the encoder always emits v4 with a freshly-supplied `pairing_id`/`hostname`.

use zeroize::Zeroizing;

use crate::error::{Result, TpError};

const PAIRING_URL_SCHEME: &str = "tp://p";
/// Upper bound on the base64url payload of a `tp://p?d=…` link, checked before
/// any allocation. A legitimate v2/v3 payload is ~772 chars; 2048 is far above
/// that yet rejects oversized input before the O(N) decode allocates.
const MAX_PAIRING_B64_LEN: usize = 2048;
const PAIRING_BINARY_MAGIC: &[u8] = b"tp";
const PAIRING_BINARY_VERSION: u8 = 4;
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
    /// Protocol version that was decoded (2, 3, or 4).
    pub v: u8,
    /// Pairing id — canonical UUID string. Present from v4; for decoded v2/v3
    /// bundles this is empty (the caller derives a legacy id from `did`).
    pub pairing_id: String,
    /// Daemon hostname (display label). Present from v4; empty for v2/v3.
    pub hostname: String,
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

/// Parse a canonical UUID string (`8-4-4-4-12`, hyphens optional) into 16 raw
/// bytes. Accepts upper/lowercase hex; rejects any other shape.
///
/// Public so callers that need the 16-byte pairing-id (e.g. the smoke loopback
/// deriving a PCT via [`crate::crypto::derive_pairing_confirmation_tag`]) can
/// convert a canonical UUID string — byte-exact twin of the TS `parseUuid16`.
pub fn parse_uuid_16(s: &str) -> Result<[u8; 16]> {
    let hex_only: String = s.chars().filter(|c| *c != '-').collect();
    if hex_only.len() != 32 {
        return Err(TpError::Pairing("pairing id must be a 16-byte UUID".into()));
    }
    let raw = hex::decode(&hex_only)
        .map_err(|_| TpError::Pairing("pairing id must be a 16-byte UUID".into()))?;
    raw.try_into()
        .map_err(|_| TpError::Pairing("pairing id must be a 16-byte UUID".into()))
}

/// Serialize pairing data to the `tp://p?d=<base64url>` deep-link (always v4).
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
    let pairing_id = parse_uuid_16(&data.pairing_id)?;
    let hostname = data.hostname.as_bytes();

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
    if hostname.len() > 255 {
        return Err(TpError::Pairing("hostname exceeds 255 bytes".into()));
    }
    if ps.len() != 32 {
        return Err(TpError::Pairing("pairing secret must be 32 bytes".into()));
    }
    if pk.len() != 32 {
        return Err(TpError::Pairing(
            "daemon public key must be 32 bytes".into(),
        ));
    }

    let mut buf = Vec::with_capacity(
        2 + 1 + 1 + did.len() + 1 + relay.len() + 32 + 32 + 16 + 1 + hostname.len(),
    );
    buf.extend_from_slice(PAIRING_BINARY_MAGIC);
    buf.push(PAIRING_BINARY_VERSION);
    buf.push(did.len() as u8);
    buf.extend_from_slice(did);
    buf.push(relay.len() as u8);
    buf.extend_from_slice(&relay);
    buf.extend_from_slice(&ps);
    buf.extend_from_slice(&pk);
    buf.extend_from_slice(&pairing_id);
    buf.push(hostname.len() as u8);
    buf.extend_from_slice(hostname);

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
    // Accept v2 (legacy, trailing label), v3 (…|pk), and v4 (…|pk|pairingId|hostname).
    if !matches!(version, 2..=4) {
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

    // Trailing fields differ by version.
    let mut pairing_id = String::new();
    let mut hostname = String::new();
    match version {
        // v2 carried a trailing label — validate its length but discard the value.
        2 => {
            if o >= buf.len() {
                return Err(err());
            }
            let label_len = buf[o] as usize;
            o += 1;
            if o + label_len > buf.len() {
                return Err(err());
            }
        }
        // v3 stops at pk — nothing more to read.
        3 => {}
        // v4 appends pairing_id(16 raw UUID) | hostname_len(1) | hostname.
        4 => {
            if o + 16 + 1 > buf.len() {
                return Err(err());
            }
            let mut raw = [0u8; 16];
            raw.copy_from_slice(&buf[o..o + 16]);
            o += 16;
            pairing_id = crate::crypto::format_uuid(&raw);
            let host_len = buf[o] as usize;
            o += 1;
            if o + host_len > buf.len() {
                return Err(err());
            }
            hostname = std::str::from_utf8(&buf[o..o + host_len])
                .map_err(|_| err())?
                .to_string();
        }
        _ => return Err(err()),
    }

    Ok(PairingData {
        ps: b64_std_encode(ps),
        pk: b64_std_encode(pk),
        relay,
        did,
        v: version,
        pairing_id,
        hostname,
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
            v: 4,
            pairing_id: "00010203-0405-0607-0809-0a0b0c0d0e0f".to_string(),
            hostname: "my-macbook".to_string(),
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
        assert_eq!(back.v, 4);
        assert_eq!(back.pairing_id, data.pairing_id);
        assert_eq!(back.hostname, data.hostname);
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
    fn round_trip_empty_hostname() {
        let mut data = sample();
        data.hostname = String::new();
        let url = encode_pairing_data(&data).unwrap();
        let back = decode_pairing_data(&url).unwrap();
        assert_eq!(back.hostname, "");
        assert_eq!(back.pairing_id, data.pairing_id);
    }

    /// Byte-exact golden: the v4 default-relay encoding is frozen. If this
    /// string changes, the wire format changed — regenerate the TS twin vectors.
    #[test]
    fn v4_encoding_known_answer() {
        let url = encode_pairing_data(&sample()).unwrap();
        assert_eq!(
            url,
            "tp://p?d=dHAEBmFiYzEyMwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAECAwQFBgcICQoLDA0ODwpteS1tYWNib29r"
        );
    }

    /// A v3 bundle (…|pk, no pairingId/hostname) must still decode; the new
    /// fields come back empty so the caller can derive a legacy id.
    #[test]
    fn decodes_legacy_v3() {
        let url = "tp://p?d=dHADBmFiYzEyMwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC";
        let back = decode_pairing_data(url).unwrap();
        assert_eq!(back.v, 3);
        assert_eq!(back.did, "daemon-abc123");
        assert_eq!(back.ps, b64_std_encode(&[1u8; 32]));
        assert_eq!(back.pk, b64_std_encode(&[2u8; 32]));
        assert_eq!(back.pairing_id, "");
        assert_eq!(back.hostname, "");
    }

    #[test]
    fn rejects_missing_prefix() {
        let mut data = sample();
        data.did = "abc123".to_string();
        assert!(encode_pairing_data(&data).is_err());
    }

    #[test]
    fn rejects_bad_pairing_id() {
        let mut data = sample();
        data.pairing_id = "not-a-uuid".to_string();
        assert!(encode_pairing_data(&data).is_err());
    }

    #[test]
    fn rejects_truncated_v4_tail() {
        // Encode a valid v4 link, then lop bytes off the end so the pairingId
        // and hostname can't both be read — decoder must reject, not panic.
        let url = encode_pairing_data(&sample()).unwrap();
        let d = url.strip_prefix("tp://p?d=").unwrap();
        let raw = b64url_decode(d).unwrap();
        // Truncate to just past pk (drop pairingId+hostname entirely).
        let truncated = &raw[..2 + 1 + 1 + 6 + 1 + 32 + 32 + 5];
        let bad = format!("tp://p?d={}", b64url_encode(truncated));
        assert!(decode_pairing_data(&bad).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_pairing_data("not-a-pairing-url").is_err());
        assert!(decode_pairing_data("tp://p?d=@@@").is_err());
    }

    /// The pre-decode cap (`MAX_PAIRING_B64_LEN`) must reject an oversized `d`
    /// payload BEFORE any decode allocation — this bounds attacker-controlled
    /// allocation from a hostile QR/deep link.
    #[test]
    fn rejects_over_cap_payload_before_decode() {
        // A structurally valid link is far below the cap (headroom guard: if
        // this ever creeps toward the cap, the cap needs revisiting).
        let ok_len = encode_pairing_data(&sample())
            .unwrap()
            .strip_prefix("tp://p?d=")
            .unwrap()
            .len();
        assert!(ok_len < MAX_PAIRING_B64_LEN / 2);

        // One char over the cap → rejected (valid base64url alphabet, so only
        // the length gate can be what rejects it).
        let over = format!("tp://p?d={}", "A".repeat(MAX_PAIRING_B64_LEN + 1));
        assert!(decode_pairing_data(&over).is_err());
        // Grossly oversized → still rejected, no panic/alloc blowup.
        let huge = format!("tp://p?d={}", "A".repeat(10 * MAX_PAIRING_B64_LEN));
        assert!(decode_pairing_data(&huge).is_err());
    }

    fn link_from_raw(raw: &[u8]) -> String {
        format!("tp://p?d={}", b64url_encode(raw))
    }

    /// Non-UTF-8 bytes in the did/relay/hostname fields must reject the whole
    /// bundle (strict `from_utf8`, no lossy substitution).
    #[test]
    fn rejects_invalid_utf8_in_string_fields() {
        let ps = [1u8; 32];
        let pk = [2u8; 32];

        // did = [0xff, 0xfe] (invalid UTF-8), v3 layout.
        let mut bad_did = b"tp\x03\x02\xff\xfe\x00".to_vec();
        bad_did.extend_from_slice(&ps);
        bad_did.extend_from_slice(&pk);
        assert!(decode_pairing_data(&link_from_raw(&bad_did)).is_err());

        // relay = [0xff, 0xfe], v3 layout with did "a".
        let mut bad_relay = b"tp\x03\x01a\x02\xff\xfe".to_vec();
        bad_relay.extend_from_slice(&ps);
        bad_relay.extend_from_slice(&pk);
        assert!(decode_pairing_data(&link_from_raw(&bad_relay)).is_err());

        // hostname = [0xff, 0xfe], v4 layout with did "a", default relay.
        let mut bad_host = b"tp\x04\x01a\x00".to_vec();
        bad_host.extend_from_slice(&ps);
        bad_host.extend_from_slice(&pk);
        bad_host.extend_from_slice(&[7u8; 16]); // pairingId (raw UUID)
        bad_host.extend_from_slice(b"\x02\xff\xfe");
        assert!(decode_pairing_data(&link_from_raw(&bad_host)).is_err());

        // Control: the same v3 layout with VALID UTF-8 decodes fine, proving
        // the rejections above come from the UTF-8 gate, not the layout.
        let mut good = b"tp\x03\x02ab\x00".to_vec();
        good.extend_from_slice(&ps);
        good.extend_from_slice(&pk);
        let back = decode_pairing_data(&link_from_raw(&good)).unwrap();
        assert_eq!(back.did, "daemon-ab");
    }
}
