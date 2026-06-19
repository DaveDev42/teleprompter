//! `tp-relay` — Stage 1 relay server crate (ADR-0003, Phase 4 backend Rust
//! migration).
//!
//! **Step 3 scope:** pure relay logic — resume-token issue/verify, connection
//! registry (DaemonState + registrations), and handshake handlers
//! (register/auth/auth.resume/hello).  NO axum / tokio / tungstenite yet
//! (those arrive at Step 4).
//!
//! **Step 2 scope (this file + `messages`):** pure Relay → Client serde core —
//! `RelayServerMessage` discriminated union, manual parse boundary, and
//! framing re-exports.
//!
//! ## Crate layout
//!
//! ```text
//! tp_relay
//! ├── lib.rs          — shared guard primitives + framing helpers (this file)
//! ├── messages.rs     — RelayServerMessage enum + parse_relay_server_message
//! ├── resume_token.rs — ResumeTokenSigner (BLAKE2b keyed-hash, binary 5-part payload)
//! ├── registry.rs     — DaemonState + Registration + Registry mutation helpers
//! └── handshake.rs    — handle_register/handle_auth/handle_auth_resume/handle_hello
//! ```
//!
//! ## Framing
//!
//! Wire frames use the same `u32_be jsonLen | u32_be binLen | UTF-8 JSON`
//! format as every other component in the system. This crate re-exports
//! [`tp_core::codec`]'s `encode_frame` / `FrameDecoder` so callers do not
//! need to depend on `tp-core` directly for the framing layer.
//!
//! Intended usage:
//!
//! ```rust,ignore
//! use tp_relay::{encode_relay_frame, RelayServerMessage, parse_relay_server_message};
//!
//! // Encode a server message for the wire.
//! let msg = RelayServerMessage::Pong(tp_relay::messages::Pong { ts: Some(1234.0) });
//! let json_bytes = serde_json::to_vec(&msg)?;
//! let framed = encode_relay_frame(&json_bytes);
//!
//! // Decode an incoming chunk.
//! let frames = tp_relay::decode_relay_frames(&framed)?;
//! for frame in frames {
//!     if let Some(msg) = parse_relay_server_message(
//!         &serde_json::from_slice(&frame.json)?,
//!     ) {
//!         // handle msg
//!     }
//! }
//! ```
//!
//! ## `deny_unknown_fields` policy
//!
//! The TypeScript relay-server-guard walks the raw JSON value field-by-field
//! and reconstructs the typed output, silently dropping any keys it does not
//! recognise (`denyUnknown: false` for every variant in the surveyed surface).
//! This is intentional in the TS codebase for forward-compatibility: a newer
//! relay may add fields that an older guard ignores cleanly.
//!
//! To preserve that semantics, **neither `RelayServerMessage` nor any of its
//! inner structs carry `#[serde(deny_unknown_fields)]`**. The hand-rolled
//! `parse_relay_server_message` function in `messages.rs` replicates the
//! guard's predicate gauntlets and drops unknown fields the same way.
//!
//! If a future step introduces structs that the TS guard *does* reject on
//! unknown fields, add `#[serde(deny_unknown_fields)]` to those structs only,
//! documented with a reference to the guard line that validates this.

use serde_json::{Map, Value};
use tp_core::codec::{self, DecodedFrame};

pub mod handshake;
pub mod messages;
pub mod rate;
pub mod registry;
pub mod resume_token;
pub mod ring;

pub use messages::{
    parse_relay_server_message, AuthErr, AuthOk, Frame, KeyExchangeFrame, Notification, Pong,
    Presence, PushToken, RegisterErr, RegisterOk, RelayErr, RelayServerMessage,
};

// ── Framing helpers ──────────────────────────────────────────────────────────

/// Encode a JSON-serialized relay message into a framed wire buffer.
///
/// Thin wrapper around [`tp_core::codec::encode_frame`] with no binary sidecar
/// (relay messages are JSON-only). The caller is responsible for serializing
/// the [`RelayServerMessage`] to JSON bytes first:
///
/// ```rust,ignore
/// let json = serde_json::to_vec(&msg)?;
/// let framed = tp_relay::encode_relay_frame(&json);
/// ```
#[must_use]
pub fn encode_relay_frame(json: &[u8]) -> Vec<u8> {
    codec::encode_frame(json, None)
}

/// Decode all complete relay frames contained in `chunk`. Stateless single-shot
/// helper — the caller supplies the full accumulated buffer. Returns raw
/// `DecodedFrame` values; the JSON slice of each can be passed to
/// `serde_json::from_slice` and then to `parse_relay_server_message`.
///
/// # Errors
///
/// Returns a [`tp_core::error::TpError`] if an oversized or otherwise
/// unrecoverable frame header is encountered. The connection should be torn
/// down on error.
pub fn decode_relay_frames(chunk: &[u8]) -> tp_core::error::Result<Vec<DecodedFrame>> {
    let mut dec = codec::FrameDecoder::new();
    dec.decode(chunk)
}

// ── Shared guard primitives ──────────────────────────────────────────────────
// These mirror the equivalents in tp-proto/src/lib.rs exactly (same logic,
// same TS-source annotation). Duplicated rather than re-exported from tp-proto
// because tp-proto is pub(crate) scoped for those helpers and tp-relay is an
// independent crate that happens to need the same primitives.

/// `isString` on a map field. `None` if absent or not a string.
pub(crate) fn req_string(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(String::from)
}

/// `isNumber` — `typeof === "number" && Number.isFinite`. Rejects NaN/±Inf;
/// accepts non-integer floats (e.g. `lastSeen: 1_700_000_000.5`).
pub(crate) fn is_number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

/// `isNonNegativeInt` — `Number.isInteger && >= 0`. Rejects `1.5`, `-1`.
/// Integer-valued floats like `2.0` are accepted (matching JS `Number.isInteger(2.0)`).
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub(crate) fn is_non_negative_int(v: &Value) -> Option<u64> {
    if let Some(u) = v.as_u64() {
        return Some(u);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f.fract() == 0.0 && f >= 0.0 && f <= (u64::MAX as f64) {
            return Some(f as u64);
        }
    }
    None
}

/// `isStringArray` — every element must be a string.
pub(crate) fn as_string_array(v: &Value) -> Option<Vec<String>> {
    v.as_array()?
        .iter()
        .map(|e| e.as_str().map(String::from))
        .collect()
}

/// `isBoolean` (strict — no truthy coercion). `None` if absent or non-bool.
pub(crate) fn req_bool(obj: &Map<String, Value>, key: &str) -> Option<bool> {
    obj.get(key).and_then(Value::as_bool)
}

/// `isOptionalString` — absent OR string. A present `null` is REJECTED,
/// matching `isOptionalString(null) === false` in the TS guard.
///
/// Returns `None` (outer) when the predicate fails (reject the whole message);
/// `Some(None)` when the field is absent; `Some(Some(s))` for a present string.
///
/// `Option<Option<T>>` is intentional: the three states (absent / present-valid /
/// present-invalid) cannot collapse to two without losing the reject semantics.
#[allow(clippy::option_option)]
pub(crate) fn opt_string(obj: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match obj.get(key) {
        None => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None, // null / number / bool / array / object → reject
    }
}

/// `isOptionalNumber` — absent OR finite number (non-integer ok). Present
/// `null` is rejected, matching `isOptionalNumber(null) === false`.
/// `Option<Option<f64>>` — same three-state rationale as `opt_string`.
#[allow(clippy::option_option)]
pub(crate) fn opt_number(obj: &Map<String, Value>, key: &str) -> Option<Option<f64>> {
    match obj.get(key) {
        None => Some(None),
        Some(v) => is_number(v).map(Some),
    }
}

/// `isOptionalBoolean` — absent OR boolean. Present `null` is REJECTED,
/// matching `isOptionalBoolean(null) === false`.
///
/// Returns `None` (outer) when the predicate fails; `Some(None)` when absent;
/// `Some(Some(b))` for a present boolean.
/// `Option<Option<bool>>` — same three-state rationale as `opt_string`.
#[allow(clippy::option_option)]
pub(crate) fn opt_bool(obj: &Map<String, Value>, key: &str) -> Option<Option<bool>> {
    match obj.get(key) {
        None => Some(None),
        Some(Value::Bool(b)) => Some(Some(*b)),
        Some(_) => None, // null / string / number / etc → reject
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encode_decode_roundtrip() {
        let json = br#"{"t":"relay.pong"}"#;
        let wire = encode_relay_frame(json);
        let decoded = decode_relay_frames(&wire).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].json, json);
        assert!(decoded[0].binary.is_none());
    }

    #[test]
    fn opt_bool_semantics() {
        let obj = json!({"a": true, "b": false, "c": null, "d": "yes"})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(opt_bool(&obj, "a"), Some(Some(true)));
        assert_eq!(opt_bool(&obj, "b"), Some(Some(false)));
        assert_eq!(opt_bool(&obj, "missing"), Some(None)); // absent → ok, no value
        assert_eq!(opt_bool(&obj, "c"), None); // null → reject
        assert_eq!(opt_bool(&obj, "d"), None); // string → reject
    }

    #[test]
    fn opt_string_semantics() {
        let obj = json!({"a": "hello", "b": null, "c": 42})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(opt_string(&obj, "a"), Some(Some("hello".into())));
        assert_eq!(opt_string(&obj, "missing"), Some(None));
        assert_eq!(opt_string(&obj, "b"), None); // null → reject
        assert_eq!(opt_string(&obj, "c"), None); // number → reject
    }

    #[test]
    fn is_non_negative_int_semantics() {
        assert_eq!(is_non_negative_int(&json!(0_u64)), Some(0));
        assert_eq!(is_non_negative_int(&json!(42_u64)), Some(42));
        assert_eq!(is_non_negative_int(&json!(2.0_f64)), Some(2)); // integer-valued float
        assert_eq!(is_non_negative_int(&json!(1.5_f64)), None); // fractional → reject
        assert_eq!(is_non_negative_int(&json!(-1_i64)), None); // negative → reject
        assert_eq!(is_non_negative_int(&json!("1")), None); // string → reject
    }
}
