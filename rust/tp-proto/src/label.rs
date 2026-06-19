//! `Label` tagged union + forgiving decoders.
//!
//! Byte-exact port of `packages/protocol/src/types/label.ts`. A label is either
//! `Set { value }` (a non-empty, trimmed user name) or `Unset`. The decoders
//! accept every shape the field has ever had on the wire / in SQLite so any
//! version can read any peer.
//!
//! `Label` has a **manual `Serialize`** that emits the union shape
//! (`{set:true,value}` / `{set:false}`) and **deliberately no `Deserialize`** —
//! every read must go through `decode_wire_label` / `decode_kx_label_or_keep` /
//! `decode_label_opt_field` (or `parse_label_field` in `ipc.rs`) so a caller can
//! never bypass the lenient legacy-string acceptance by deriving a strict
//! deserialize.
//!
//! ## New unified contract (ADR-0003 Amendment 1, A1.3#1)
//!
//! | Wire shape               | `decode_wire_label` | `decode_label_opt_field` |
//! |--------------------------|---------------------|--------------------------|
//! | `{ set:true, value:"X"}` | `Set("X")`          | `Some(Set("X"))`         |
//! | `{ set:true, value:"" }` | `Unset`             | `Some(Unset)`            |
//! | `{ set:false }`          | `Unset` (Clear)     | `Some(Unset)`            |
//! | `null`                   | `Unset`             | `Some(Unset)`            |
//! | **field absent**         | N/A (caller passes `Value::Null`) | `None` (**keep-current**) |
//! | `"legacy string"`        | `Set("…")` (trimmed) | `Some(Set("…"))`        |
//! | `""` (legacy empty)      | `Unset`             | `Some(Unset)`            |
//!
//! **Keep-current = field absence, not a value.** On kx-hello / meta-hello surfaces
//! the daemon SHOULD prefer omitting the label field entirely (rather than emitting
//! `{set:false}`) when it has no label to advertise, but consumers accept both
//! present-Clear and absent as keep-current via `decode_kx_label_or_keep`.
//!
//! `decode_kx_label_or_keep` is a thin convenience wrapper over
//! `decode_label_opt_field`: it maps the **value** of a parsed `Label` to
//! `None`/`Some`, suitable for callers that already have the raw field value
//! (and treat `null`/absent identically). For callers that distinguish absent from
//! present-null at the object level, use `decode_label_opt_field(obj.get("label"))`
//! directly — `None` unambiguously means keep-current.

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

/// A pairing's human-readable label. `Set` carries a non-empty trimmed value;
/// `Unset` is the canonical "not set".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Label {
    Set { value: String },
    Unset,
}

/// The canonical "not set" label (mirror of `LABEL_UNSET`).
pub const fn label_unset() -> Label {
    Label::Unset
}

impl Serialize for Label {
    /// Emit the new union wire shape: `{ "set": true, "value": ... }` or
    /// `{ "set": false }`. This is what a v2 producer writes and what the golden
    /// vectors compare against.
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Label::Set { value } => {
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("set", &true)?;
                m.serialize_entry("value", value)?;
                m.end()
            }
            Label::Unset => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("set", &false)?;
                m.end()
            }
        }
    }
}

/// `makeLabel(raw)` — trims; empty/whitespace/`None` → `Unset`.
pub fn make_label(raw: Option<&str>) -> Label {
    match raw {
        None => Label::Unset,
        Some(s) => {
            let v = s.trim();
            if v.is_empty() {
                Label::Unset
            } else {
                Label::Set {
                    value: v.to_string(),
                }
            }
        }
    }
}

/// `labelToNullable` — `Set` → `Some(value)`, `Unset` → `None`.
pub fn label_to_nullable(l: &Label) -> Option<&str> {
    match l {
        Label::Set { value } => Some(value),
        Label::Unset => None,
    }
}

/// Forgiving decoder for a `Label` field that arrived over the wire / out of
/// SQLite / from any untyped source. Total function — NEVER fails. Pass the
/// parsed JSON value of the `label` field, or `Value::Null` when the key was
/// absent (`obj.get("label").unwrap_or(&Value::Null)`).
///
/// Mirror of `decodeWireLabel` (label.ts:88-98), arm-for-arm:
///   - `null` / absent          → `Unset`
///   - string                   → `make_label` (trims; `""` / `"   "` → `Unset`)
///   - `{ set: false, .. }`     → `Unset` (fires first, even with a stray value)
///   - `{ set: true, value:str }` → `make_label(value)` (trims → may collapse)
///   - `{ set: true }` / value non-string → `Unset`
///   - `{ set: <non-bool> }`    → `Unset`
///   - number / bool / array / object-without-`set` → `Unset`
pub fn decode_wire_label(raw: &Value) -> Label {
    match raw {
        Value::Null => Label::Unset,
        Value::String(s) => make_label(Some(s)),
        Value::Object(map) if map.contains_key("set") => match map.get("set") {
            Some(Value::Bool(false)) => Label::Unset,
            Some(Value::Bool(true)) => match map.get("value") {
                Some(Value::String(v)) => make_label(Some(v)),
                _ => Label::Unset,
            },
            _ => Label::Unset, // set present but non-boolean
        },
        _ => Label::Unset, // number, bool, array, object without "set"
    }
}

/// Read a label field that **may be absent at the JSON object level**.
///
/// This is the canonical "field-level optional" decoder:
/// - `None` (key absent) → `None` — **keep-current** (no change to app-side label).
/// - `Some(v)` (key present, any value including `null`) →
///   `Some(decode_wire_label(v))` — the caller receives `Some(Set(…))` or
///   `Some(Unset)` and must act on it.
///
/// Usage:
/// ```rust,ignore
/// let label = decode_label_opt_field(obj.get("label"));
/// // None     → keep current label unchanged
/// // Some(Set)  → overwrite with the new label
/// // Some(Unset) → clear (authoritative)
/// ```
///
/// This is the right decoder for `relay.kx` / meta-hello `daemonLabel` where the
/// field being absent carries the distinct meaning "daemon has no update for you".
pub fn decode_label_opt_field(v: Option<&Value>) -> Option<Label> {
    v.map(decode_wire_label)
}

/// Decoder for the `relay.kx` daemon-hello / meta `hello` `daemonLabel` fields,
/// where "not set" means **keep the current app-side label**, not "clear".
///
/// Returns `None` for every keep-current signal (`Unset` or absent field treated
/// uniformly) and `Some(Set { .. })` only when a concrete label is present.
/// There is **no** `Some(Unset)` outcome from this decoder — if you need to
/// distinguish authoritative Clear from keep-current, use `decode_label_opt_field`
/// directly (absent → `None`, present-Clear → `Some(Unset)`).
///
/// Mirror of `decodeKxLabelOrKeep` (label.ts). For field-level optional callers
/// that have already resolved absent→`Value::Null`: pass `raw` directly and this
/// decoder handles both present-null and absent equivalently.
pub fn decode_kx_label_or_keep(raw: &Value) -> Option<Label> {
    match decode_wire_label(raw) {
        Label::Set { value } => Some(Label::Set { value }),
        Label::Unset => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Golden-vector cases (ADR-0003 A1.3#1 labelUpdate gate) ──────────────

    /// `{set:true,value:"Office Mac"}` → `Set("Office Mac")`
    #[test]
    fn golden_set_non_empty() {
        let raw = json!({"set": true, "value": "Office Mac"});
        assert_eq!(
            decode_wire_label(&raw),
            Label::Set {
                value: "Office Mac".into()
            }
        );
        assert_eq!(
            decode_label_opt_field(Some(&raw)),
            Some(Label::Set {
                value: "Office Mac".into()
            })
        );
    }

    /// `{set:true,value:"  x  "}` → `Set("x")` (trimmed)
    #[test]
    fn golden_set_trimmed() {
        let raw = json!({"set": true, "value": "  x  "});
        assert_eq!(decode_wire_label(&raw), Label::Set { value: "x".into() });
        assert_eq!(
            decode_label_opt_field(Some(&raw)),
            Some(Label::Set { value: "x".into() })
        );
    }

    /// `{set:true,value:""}` → `Unset` (makeLabel trims empty → unset)
    #[test]
    fn golden_set_empty_value_becomes_unset() {
        let raw = json!({"set": true, "value": ""});
        assert_eq!(decode_wire_label(&raw), Label::Unset);
        assert_eq!(decode_label_opt_field(Some(&raw)), Some(Label::Unset));
    }

    /// `{set:false}` → `Unset` (authoritative Clear)
    #[test]
    fn golden_clear_becomes_unset() {
        let raw = json!({"set": false});
        assert_eq!(decode_wire_label(&raw), Label::Unset);
        assert_eq!(decode_label_opt_field(Some(&raw)), Some(Label::Unset));
    }

    /// Absent field → `None` (keep-current; field-level, kx surface).
    /// `decode_label_opt_field(None)` — the ONLY path that produces `None`.
    #[test]
    fn golden_absent_field_is_keep_current() {
        assert_eq!(decode_label_opt_field(None), None);
    }

    /// Legacy string `"x"` → `Set("x")` (lenient SQLite/back-compat read)
    #[test]
    fn golden_legacy_string_becomes_set() {
        let raw = json!("x");
        assert_eq!(decode_wire_label(&raw), Label::Set { value: "x".into() });
        assert_eq!(
            decode_label_opt_field(Some(&raw)),
            Some(Label::Set { value: "x".into() })
        );
    }

    /// Legacy `""` → `Unset`
    #[test]
    fn golden_legacy_empty_string_becomes_unset() {
        let raw = json!("");
        assert_eq!(decode_wire_label(&raw), Label::Unset);
        assert_eq!(decode_label_opt_field(Some(&raw)), Some(Label::Unset));
    }

    /// Legacy `null` → `Unset` (NOT keep-current — `null` is a present value)
    #[test]
    fn golden_legacy_null_is_unset_not_keep() {
        // null is a PRESENT value (Some(&Value::Null)), so decode_label_opt_field
        // returns Some(Unset), not None. Keep-current = field ABSENCE only.
        assert_eq!(decode_wire_label(&Value::Null), Label::Unset);
        assert_eq!(
            decode_label_opt_field(Some(&Value::Null)),
            Some(Label::Unset)
        );
        // kx helper: null → Unset → None (same as absent in kx context)
        assert_eq!(decode_kx_label_or_keep(&Value::Null), None);
    }

    // ── Full decoder coverage ────────────────────────────────────────────────

    #[test]
    fn decode_wire_label_covers_every_shape() {
        // null / absent
        assert_eq!(decode_wire_label(&Value::Null), Label::Unset);
        // strings
        assert_eq!(
            decode_wire_label(&json!("Office Mac")),
            Label::Set {
                value: "Office Mac".into()
            }
        );
        assert_eq!(
            decode_wire_label(&json!("  Office Mac  ")),
            Label::Set {
                value: "Office Mac".into()
            }
        );
        assert_eq!(decode_wire_label(&json!("")), Label::Unset);
        assert_eq!(decode_wire_label(&json!("   ")), Label::Unset);
        // union objects
        assert_eq!(
            decode_wire_label(&json!({"set": true, "value": "x"})),
            Label::Set { value: "x".into() }
        );
        assert_eq!(
            decode_wire_label(&json!({"set": true, "value": "  x  "})),
            Label::Set { value: "x".into() }
        );
        assert_eq!(
            decode_wire_label(&json!({"set": true, "value": ""})),
            Label::Unset
        );
        assert_eq!(
            decode_wire_label(&json!({"set": true, "value": 42})),
            Label::Unset
        );
        assert_eq!(decode_wire_label(&json!({"set": true})), Label::Unset);
        assert_eq!(decode_wire_label(&json!({"set": false})), Label::Unset);
        assert_eq!(
            decode_wire_label(&json!({"set": false, "value": "x"})),
            Label::Unset
        );
        assert_eq!(decode_wire_label(&json!({"set": 1})), Label::Unset);
        assert_eq!(decode_wire_label(&json!({"set": "true"})), Label::Unset);
        // not a union (no "set" key) / wrong types
        assert_eq!(decode_wire_label(&json!({"name": "x"})), Label::Unset);
        assert_eq!(decode_wire_label(&json!(42)), Label::Unset);
        assert_eq!(decode_wire_label(&json!(["x"])), Label::Unset);
        assert_eq!(decode_wire_label(&json!(true)), Label::Unset);
    }

    #[test]
    fn decode_label_opt_field_distinguishes_absent_from_null() {
        // present null → Some(Unset) — not keep-current
        assert_eq!(
            decode_label_opt_field(Some(&Value::Null)),
            Some(Label::Unset)
        );
        // absent → None (keep-current)
        assert_eq!(decode_label_opt_field(None), None);
        // present Set → Some(Set)
        assert_eq!(
            decode_label_opt_field(Some(&json!({"set": true, "value": "hi"}))),
            Some(Label::Set { value: "hi".into() })
        );
        // present Clear → Some(Unset)
        assert_eq!(
            decode_label_opt_field(Some(&json!({"set": false}))),
            Some(Label::Unset)
        );
        // present legacy string → Some(Set)
        assert_eq!(
            decode_label_opt_field(Some(&json!("hi"))),
            Some(Label::Set { value: "hi".into() })
        );
    }

    #[test]
    fn decode_kx_label_or_keep_collapses_unset_to_none() {
        assert_eq!(decode_kx_label_or_keep(&Value::Null), None);
        assert_eq!(decode_kx_label_or_keep(&json!("")), None);
        assert_eq!(decode_kx_label_or_keep(&json!({"set": false})), None);
        assert_eq!(
            decode_kx_label_or_keep(&json!({"set": true, "value": 42})),
            None
        );
        assert_eq!(
            decode_kx_label_or_keep(&json!("Office Mac")),
            Some(Label::Set {
                value: "Office Mac".into()
            })
        );
        assert_eq!(
            decode_kx_label_or_keep(&json!({"set": true, "value": "x"})),
            Some(Label::Set { value: "x".into() })
        );
    }

    #[test]
    fn serialize_emits_union_shape() {
        assert_eq!(
            serde_json::to_value(Label::Set { value: "x".into() }).unwrap(),
            json!({"set": true, "value": "x"})
        );
        assert_eq!(
            serde_json::to_value(Label::Unset).unwrap(),
            json!({"set": false})
        );
    }

    /// Serialize round-trip byte-equality: same bytes as the canonical wire shape.
    #[test]
    fn serialize_round_trip_byte_exact() {
        // Set: must produce exactly `{"set":true,"value":"Office Mac"}`
        let set_label = Label::Set {
            value: "Office Mac".into(),
        };
        assert_eq!(
            serde_json::to_string(&set_label).unwrap(),
            r#"{"set":true,"value":"Office Mac"}"#
        );
        // Unset: must produce exactly `{"set":false}`
        assert_eq!(
            serde_json::to_string(&Label::Unset).unwrap(),
            r#"{"set":false}"#
        );
    }

    #[test]
    fn make_label_and_nullable() {
        assert_eq!(make_label(None), Label::Unset);
        assert_eq!(make_label(Some("  x ")), Label::Set { value: "x".into() });
        assert_eq!(make_label(Some("   ")), Label::Unset);
        assert_eq!(
            label_to_nullable(&Label::Set { value: "x".into() }),
            Some("x")
        );
        assert_eq!(label_to_nullable(&Label::Unset), None);
        assert_eq!(label_unset(), Label::Unset);
    }
}
