//! Stage 0 message-type parity (ADR-0003, Phase 4 backend Rust migration).
//!
//! This crate is a **host-only sibling** of `tp-core`. Its sole job is to
//! reproduce, byte-for-byte, the TypeScript wire-message *parse boundaries* —
//! `parseRelayClientMessage` / `parseIpcMessage` / `parseControlMessage` and the
//! lenient `Label` decoder — plus a random `generate_keypair` (the one
//! non-deterministic primitive `tp-core` lacks).
//!
//! **There is NO runtime cutover at Stage 0.** No daemon/relay/runner/CLI code
//! changes. The only proof obligation is the golden-vector gate
//! (`tests/message_vectors.rs` + `tests/fixtures/message-vectors.json`): the
//! live TS guards serialize canonical message instances, and these Rust parsers
//! must produce field-identical output (and reject the same malformed frames).
//!
//! ## Design: manual fallible parse, not derive-deserialize
//!
//! The TS guards are not "deserialize into a shape" — they are predicate
//! gauntlets that return `null` on any failure and reconstruct the output
//! field-by-field from the raw value (extra peer fields are silently dropped).
//! `serde`'s internally-tagged enum diverges from that in three load-bearing
//! ways (null-vs-absent for optionals, integer-valued floats, and the lenient
//! `Label` legacy-string read). So each boundary is a hand-rolled
//! `parse_*(raw: &serde_json::Value) -> Option<T>` that walks the `Value` in the
//! exact predicate order of the TS `switch`. `Option` (not `Result`) mirrors
//! "returns null" — a dropped frame carries no surfaced reason.
//!
//! The typed enums still `#[derive(Serialize, Deserialize)]` so the golden test
//! can round-trip a parsed value back to JSON for field-by-field comparison and
//! so a future Rust producer can emit the same wire shapes.

use serde_json::{Map, Value};

pub mod control;
pub mod ipc;
pub mod keypair;
pub mod label;
pub mod relay_client;

// ---------------------------------------------------------------------------
// Shared primitive guards — the ONLY place numeric/string semantics live.
// Mirror packages/protocol/src/guard-primitives.ts exactly.
// ---------------------------------------------------------------------------

/// `isString` on a map field. `None` if absent or not a string.
pub(crate) fn req_string(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(String::from)
}

/// `isNumber` — `typeof === "number" && Number.isFinite`. Rejects NaN/±Inf,
/// **accepts non-integer floats** (e.g. `ts: 1.5`). serde_json can't represent
/// NaN/Inf in parsed JSON, so `as_f64()` already excludes them; the `is_finite`
/// filter is belt-and-suspenders.
pub(crate) fn is_number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

/// `isNonNegativeInt` — `Number.isInteger && >= 0`. Rejects `1.5`, `-1`.
///
/// JS has no int/float distinction, so `Number.isInteger(2.0)` is `true`. A
/// JSON token written as `2.0` parses to a serde float whose `as_u64()` is
/// `None` — which would wrongly reject a value TS accepts. We therefore also
/// accept integer-valued finite floats (`fract() == 0`). Real producers emit
/// `2` (so `as_u64()` hits the fast path); the float arm only matters for an
/// odd/hostile peer, but it keeps us byte-faithful to `Number.isInteger`.
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

/// `isPositiveInt` — `Number.isInteger && > 0`. Rejects `0`. Same
/// integer-valued-float acceptance as `is_non_negative_int`.
pub(crate) fn is_positive_int(v: &Value) -> Option<u64> {
    is_non_negative_int(v).filter(|&n| n > 0)
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

/// `isOptionalString` — absent OR string. **A present `null` is REJECTED**
/// (TS `isOptionalString(null)` is `false`). Outer `None` = predicate failed
/// (reject the whole message); inner `None` = field absent; inner `Some` =
/// present string.
pub(crate) fn opt_string(obj: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match obj.get(key) {
        None => Some(None),                              // absent → ok, no value
        Some(Value::String(s)) => Some(Some(s.clone())), // present string
        Some(_) => None,                                 // null / number / etc → reject
    }
}

/// `isOptionalNumber` — absent OR finite number (non-integer ok). Present `null`
/// is rejected, matching `isOptionalNumber(null) === false`.
pub(crate) fn opt_number(obj: &Map<String, Value>, key: &str) -> Option<Option<f64>> {
    match obj.get(key) {
        None => Some(None),
        // Present → must be a finite number; `is_number` returning None rejects
        // the whole message (outer None), matching `isOptionalNumber(null)`.
        Some(v) => is_number(v).map(Some),
    }
}
