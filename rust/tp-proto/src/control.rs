//! Decrypted E2EE control-plane messages (`control.unpair` / `control.rename`).
//!
//! Byte-exact port of `packages/protocol/src/control-guard.ts` +
//! `types/control.ts`. These ride the `__control__` sid as ciphertext; after
//! decryption the JSON is untyped, and this is the most dangerous unguarded
//! surface (unpair reaches pairing removal, rename reaches the label update).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::label::{decode_wire_label, Label};
use crate::{is_number, req_string};

/// Why a pairing was removed (`ControlUnpair["reason"]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnpairReason {
    #[serde(rename = "user-initiated")]
    UserInitiated,
    #[serde(rename = "device-removed")]
    DeviceRemoved,
    #[serde(rename = "rotated")]
    Rotated,
}

impl UnpairReason {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "user-initiated" => Some(Self::UserInitiated),
            "device-removed" => Some(Self::DeviceRemoved),
            "rotated" => Some(Self::Rotated),
            _ => None,
        }
    }
}

/// The decrypted peer-to-peer control union.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t")]
pub enum ControlMessage {
    #[serde(rename = "control.unpair")]
    Unpair {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        #[serde(rename = "frontendId")]
        frontend_id: String,
        reason: UnpairReason,
        ts: f64,
    },
    #[serde(rename = "control.rename")]
    Rename {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        #[serde(rename = "frontendId")]
        frontend_id: String,
        /// Always produced via `decode_wire_label` — NEVER gates frame validity.
        label: Label,
        ts: f64,
    },
}

/// Parse a raw (decrypted + JSON-parsed) control frame. Returns `None` for any
/// unrecognized discriminant or malformed payload (the caller drops the frame).
///
/// Mirror of `parseControlMessage` (control-guard.ts:45-85). For `control.rename`
/// ONLY the structural fields (`daemonId`, `frontendId`, `ts`) gate validity —
/// `label` is decoded leniently and never rejects the frame.
pub fn parse_control_message(raw: &Value) -> Option<ControlMessage> {
    let obj = raw.as_object()?;
    let t = obj.get("t").and_then(Value::as_str)?;

    match t {
        "control.unpair" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let frontend_id = req_string(obj, "frontendId")?;
            let reason = UnpairReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let ts = is_number(obj.get("ts")?)?;
            Some(ControlMessage::Unpair {
                daemon_id,
                frontend_id,
                reason,
                ts,
            })
        }
        "control.rename" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let frontend_id = req_string(obj, "frontendId")?;
            let ts = is_number(obj.get("ts")?)?;
            // label is NEVER gated — decode_wire_label is total.
            let label = decode_wire_label(obj.get("label").unwrap_or(&Value::Null));
            Some(ControlMessage::Rename {
                daemon_id,
                frontend_id,
                label,
                ts,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unpair_accepts_valid_and_rejects_bad_reason() {
        let ok = parse_control_message(&json!({
            "t": "control.unpair", "daemonId": "d", "frontendId": "f",
            "reason": "rotated", "ts": 123.0
        }));
        assert_eq!(
            ok,
            Some(ControlMessage::Unpair {
                daemon_id: "d".into(),
                frontend_id: "f".into(),
                reason: UnpairReason::Rotated,
                ts: 123.0
            })
        );
        // bad reason → None
        assert!(parse_control_message(&json!({
            "t": "control.unpair", "daemonId": "d", "frontendId": "f",
            "reason": "nope", "ts": 1.0
        }))
        .is_none());
        // missing ts → None
        assert!(parse_control_message(&json!({
            "t": "control.unpair", "daemonId": "d", "frontendId": "f", "reason": "rotated"
        }))
        .is_none());
    }

    #[test]
    fn rename_label_never_gates_validity() {
        // label absent → Unset, frame still valid.
        let r = parse_control_message(&json!({
            "t": "control.rename", "daemonId": "d", "frontendId": "f", "ts": 1.0
        }));
        assert_eq!(
            r,
            Some(ControlMessage::Rename {
                daemon_id: "d".into(),
                frontend_id: "f".into(),
                label: Label::Unset,
                ts: 1.0
            })
        );
        // legacy string label.
        let r2 = parse_control_message(&json!({
            "t": "control.rename", "daemonId": "d", "frontendId": "f",
            "label": "Office Mac", "ts": 1.0
        }));
        assert_eq!(
            r2,
            Some(ControlMessage::Rename {
                daemon_id: "d".into(),
                frontend_id: "f".into(),
                label: Label::Set {
                    value: "Office Mac".into()
                },
                ts: 1.0
            })
        );
        // but missing daemonId → None (structural field gates).
        assert!(parse_control_message(&json!({
            "t": "control.rename", "frontendId": "f", "label": "x", "ts": 1.0
        }))
        .is_none());
    }

    #[test]
    fn unknown_discriminant_is_none() {
        assert!(parse_control_message(&json!({"t": "control.bogus"})).is_none());
        assert!(parse_control_message(&json!(42)).is_none());
    }
}
