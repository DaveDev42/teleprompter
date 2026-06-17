//! Client → Relay messages.
//!
//! Byte-exact port of `packages/protocol/src/relay-client-guard.ts` (10 variants).
//! The relay's `handleMessage` JSON-parses a WS frame and runs it through
//! `parseRelayClientMessage`; a `None` here makes the relay reply
//! `relay.err`/`UNKNOWN_TYPE` and never dispatch an under-validated frame.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{is_non_negative_int, is_number, req_string};

/// Relay connection role (`"daemon" | "frontend"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Daemon,
    Frontend,
}

impl Role {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "daemon" => Some(Self::Daemon),
            "frontend" => Some(Self::Frontend),
            _ => None,
        }
    }
}

/// Push device platform (`"ios" | "android"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Ios,
    Android,
}

impl Platform {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "ios" => Some(Self::Ios),
            "android" => Some(Self::Android),
            _ => None,
        }
    }
}

/// APNs interruption level. The privileged `"critical"` is INTENTIONALLY absent
/// (relay-client-guard.ts:63-67) — the wire guard rejects any other string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InterruptionLevel {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "time-sensitive")]
    TimeSensitive,
}

impl InterruptionLevel {
    /// `isOptionalInterruptionLevel`: absent → `Some(None)`; the two allowed
    /// strings → `Some(Some(..))`; anything else (incl. "critical") → `None`.
    fn parse_opt(v: Option<&Value>) -> Option<Option<Self>> {
        match v {
            None => Some(None),
            Some(Value::String(s)) if s == "active" => Some(Some(Self::Active)),
            Some(Value::String(s)) if s == "time-sensitive" => Some(Some(Self::TimeSensitive)),
            Some(_) => None,
        }
    }
}

/// Navigation payload on a `relay.push` (`data.sid` / `daemonId` / `event`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushData {
    pub sid: String,
    #[serde(rename = "daemonId")]
    pub daemon_id: String,
    pub event: String,
}

impl PushData {
    /// `isOptionalPushData`: absent → `Some(None)`; present must be an object
    /// with three string fields, else `None` (reject the message).
    fn parse_opt(v: Option<&Value>) -> Option<Option<Self>> {
        match v {
            None => Some(None),
            Some(Value::Object(map)) => {
                let sid = map.get("sid").and_then(Value::as_str)?.to_string();
                let daemon_id = map.get("daemonId").and_then(Value::as_str)?.to_string();
                let event = map.get("event").and_then(Value::as_str)?.to_string();
                Some(Some(PushData {
                    sid,
                    daemon_id,
                    event,
                }))
            }
            Some(_) => None,
        }
    }
}

/// The Client → Relay discriminated union.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t")]
pub enum RelayClientMessage {
    #[serde(rename = "relay.auth")]
    Auth {
        role: Role,
        #[serde(rename = "daemonId")]
        daemon_id: String,
        token: String,
        v: f64,
        #[serde(rename = "frontendId", skip_serializing_if = "Option::is_none")]
        frontend_id: Option<String>,
    },
    #[serde(rename = "relay.auth.resume")]
    AuthResume { token: String, v: f64 },
    #[serde(rename = "relay.register")]
    Register {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        proof: String,
        token: String,
        v: f64,
    },
    #[serde(rename = "relay.kx")]
    KeyExchange { ct: String, role: Role },
    #[serde(rename = "relay.pub")]
    Publish { sid: String, ct: String, seq: u64 },
    #[serde(rename = "relay.sub")]
    Subscribe {
        sid: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        after: Option<u64>,
    },
    #[serde(rename = "relay.unsub")]
    Unsubscribe { sid: String },
    #[serde(rename = "relay.ping")]
    Ping {
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<f64>,
    },
    #[serde(rename = "relay.push")]
    Push {
        #[serde(rename = "frontendId")]
        frontend_id: String,
        sealed: String,
        title: String,
        body: String,
        #[serde(rename = "interruptionLevel", skip_serializing_if = "Option::is_none")]
        interruption_level: Option<InterruptionLevel>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<PushData>,
    },
    #[serde(rename = "relay.push.register")]
    PushRegister {
        #[serde(rename = "frontendId")]
        frontend_id: String,
        token: String,
        platform: Platform,
    },
}

/// Parse a raw (JSON-parsed) client→relay frame. `None` if not a recognized,
/// well-formed message. Mirror of `parseRelayClientMessage` (lines 75-203),
/// predicate-for-predicate in the same order.
pub fn parse_relay_client_message(raw: &Value) -> Option<RelayClientMessage> {
    let obj = raw.as_object()?;
    let t = obj.get("t").and_then(Value::as_str)?;

    match t {
        "relay.auth" => {
            let role = Role::from_str(obj.get("role").and_then(Value::as_str)?)?;
            let daemon_id = req_string(obj, "daemonId")?;
            let token = req_string(obj, "token")?;
            let v = is_number(obj.get("v")?)?;
            let frontend_id = crate::opt_string(obj, "frontendId")?;
            Some(RelayClientMessage::Auth {
                role,
                daemon_id,
                token,
                v,
                frontend_id,
            })
        }
        "relay.auth.resume" => {
            let token = req_string(obj, "token")?;
            let v = is_number(obj.get("v")?)?;
            Some(RelayClientMessage::AuthResume { token, v })
        }
        "relay.register" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let proof = req_string(obj, "proof")?;
            let token = req_string(obj, "token")?;
            let v = is_number(obj.get("v")?)?;
            Some(RelayClientMessage::Register {
                daemon_id,
                proof,
                token,
                v,
            })
        }
        "relay.kx" => {
            let ct = req_string(obj, "ct")?;
            let role = Role::from_str(obj.get("role").and_then(Value::as_str)?)?;
            Some(RelayClientMessage::KeyExchange { ct, role })
        }
        "relay.pub" => {
            let sid = req_string(obj, "sid")?;
            let ct = req_string(obj, "ct")?;
            let seq = is_non_negative_int(obj.get("seq")?)?;
            Some(RelayClientMessage::Publish { sid, ct, seq })
        }
        "relay.sub" => {
            let sid = req_string(obj, "sid")?;
            // after: present → must be non-neg-int; absent → None.
            let after = match obj.get("after") {
                None => None,
                Some(v) => Some(is_non_negative_int(v)?),
            };
            Some(RelayClientMessage::Subscribe { sid, after })
        }
        "relay.unsub" => {
            let sid = req_string(obj, "sid")?;
            Some(RelayClientMessage::Unsubscribe { sid })
        }
        "relay.ping" => {
            // isOptionalNumber(ts): absent → None; present finite number → Some;
            // present null/non-number → reject.
            let ts = crate::opt_number(obj, "ts")?;
            Some(RelayClientMessage::Ping { ts })
        }
        "relay.push" => {
            let frontend_id = req_string(obj, "frontendId")?;
            // sealed required (legacy plaintext `token` removed, line 169-172).
            let sealed = req_string(obj, "sealed")?;
            let title = req_string(obj, "title")?;
            let body = req_string(obj, "body")?;
            let interruption_level = InterruptionLevel::parse_opt(obj.get("interruptionLevel"))?;
            let data = PushData::parse_opt(obj.get("data"))?;
            Some(RelayClientMessage::Push {
                frontend_id,
                sealed,
                title,
                body,
                interruption_level,
                data,
            })
        }
        "relay.push.register" => {
            let frontend_id = req_string(obj, "frontendId")?;
            let token = req_string(obj, "token")?;
            let platform = Platform::from_str(obj.get("platform").and_then(Value::as_str)?)?;
            Some(RelayClientMessage::PushRegister {
                frontend_id,
                token,
                platform,
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
    fn auth_accepts_with_and_without_frontend_id() {
        let with = parse_relay_client_message(&json!({
            "t": "relay.auth", "role": "frontend", "daemonId": "d1",
            "token": "tk", "v": 2, "frontendId": "f1"
        }));
        assert_eq!(
            with,
            Some(RelayClientMessage::Auth {
                role: Role::Frontend,
                daemon_id: "d1".into(),
                token: "tk".into(),
                v: 2.0,
                frontend_id: Some("f1".into())
            })
        );
        let without = parse_relay_client_message(&json!({
            "t": "relay.auth", "role": "daemon", "daemonId": "d1", "token": "tk", "v": 2
        }));
        assert_eq!(
            without,
            Some(RelayClientMessage::Auth {
                role: Role::Daemon,
                daemon_id: "d1".into(),
                token: "tk".into(),
                v: 2.0,
                frontend_id: None
            })
        );
        // frontendId: null → reject (isOptionalString rejects null).
        assert!(parse_relay_client_message(&json!({
            "t": "relay.auth", "role": "daemon", "daemonId": "d1", "token": "tk",
            "v": 2, "frontendId": null
        }))
        .is_none());
    }

    #[test]
    fn push_requires_sealed_and_rejects_critical() {
        // critical interruption level → reject.
        assert!(parse_relay_client_message(&json!({
            "t": "relay.push", "frontendId": "f", "sealed": "s",
            "title": "t", "body": "b", "interruptionLevel": "critical"
        }))
        .is_none());
        // missing sealed → reject.
        assert!(parse_relay_client_message(&json!({
            "t": "relay.push", "frontendId": "f", "title": "t", "body": "b"
        }))
        .is_none());
        // full valid push round-trips field-for-field.
        let ok = parse_relay_client_message(&json!({
            "t": "relay.push", "frontendId": "f", "sealed": "tpps1.1.AAAA",
            "title": "T", "body": "B", "interruptionLevel": "time-sensitive",
            "data": {"sid": "s", "daemonId": "d", "event": "Stop"}
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({
                "t": "relay.push", "frontendId": "f", "sealed": "tpps1.1.AAAA",
                "title": "T", "body": "B", "interruptionLevel": "time-sensitive",
                "data": {"sid": "s", "daemonId": "d", "event": "Stop"}
            })
        );
    }

    #[test]
    fn pub_seq_integer_semantics() {
        assert!(parse_relay_client_message(&json!({
            "t": "relay.pub", "sid": "s", "ct": "c", "seq": 1.5
        }))
        .is_none());
        // 2.0 (integer-valued float) accepted, matching Number.isInteger(2.0).
        let ok = parse_relay_client_message(&json!({
            "t": "relay.pub", "sid": "s", "ct": "c", "seq": 2.0
        }));
        assert_eq!(
            ok,
            Some(RelayClientMessage::Publish {
                sid: "s".into(),
                ct: "c".into(),
                seq: 2
            })
        );
    }

    #[test]
    fn extra_peer_fields_are_dropped() {
        // unsub with an extra field still parses (field-by-field reconstruction
        // drops it, matching the TS guard).
        let ok = parse_relay_client_message(&json!({"t": "relay.unsub", "sid": "s", "evil": "x"}));
        assert_eq!(
            ok,
            Some(RelayClientMessage::Unsubscribe { sid: "s".into() })
        );
    }

    #[test]
    fn unknown_and_bad_role_rejected() {
        assert!(parse_relay_client_message(&json!({"t": "relay.bogus"})).is_none());
        assert!(parse_relay_client_message(&json!({
            "t": "relay.auth", "role": "admin", "daemonId": "d", "token": "t", "v": 2
        }))
        .is_none());
        assert!(parse_relay_client_message(&json!({
            "t": "relay.push.register", "frontendId": "f", "token": "t", "platform": "web"
        }))
        .is_none());
    }
}
