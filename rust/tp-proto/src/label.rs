//! `Label` tagged union + forgiving decoders.
//!
//! Byte-exact port of `packages/protocol/src/types/label.ts`. A label is either
//! `Set { value }` (a non-empty, trimmed user name) or `Unset`. The decoders
//! accept every shape the field has ever had on the wire / in SQLite so any
//! version can read any peer.
//!
//! `Label` has a **manual `Serialize`** that emits the union shape
//! (`{set:true,value}` / `{set:false}`) and **deliberately no `Deserialize`** —
//! every read must go through `decode_wire_label` / `decode_kx_label_or_keep`
//! (or `parse_label_field` in `ipc.rs`) so a caller can never bypass the lenient
//! legacy-string acceptance by deriving a strict deserialize.

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

/// Decoder for the `relay.kx` daemon-hello / meta `hello` `daemonLabel` fields,
/// where "not set" means **keep the current app-side label**, not "clear".
/// Returns `None` for every keep-current signal and `Some(Set { .. })` only when
/// a concrete label is present. There is no `Some(Unset)` outcome.
///
/// Mirror of `decodeKxLabelOrKeep` (label.ts:113-116).
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
