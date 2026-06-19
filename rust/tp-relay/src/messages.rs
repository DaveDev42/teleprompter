//! Relay → Client server-message types.
//!
//! Byte-exact port of the 11 variants surveyed from
//! `packages/protocol/src/types/relay.ts` (lines 173-282) plus the guard
//! behaviour documented in `packages/relay/src/relay-server-guard.ts`
//! (lines 69-202).
//!
//! ## Design: serde derive + manual parse boundary
//!
//! The guard uses a field-by-field reconstruct pattern: it never `JSON.parse`s
//! into a typed shape but walks the raw value in predicate order, dropping
//! extra/unknown fields on every variant. This asymmetry drives a split:
//!
//! - **`#[derive(Serialize)]`** — emit these variants over the wire. The
//!   `#[serde(tag = "t")]` enum produces the correct `{"t":"relay.xxx",...}`
//!   discriminated-union JSON that TS expects.
//! - **`parse_relay_server_message`** — hand-rolled fallible parse that mirrors
//!   the predicate gauntlets in `relay-server-guard.ts` exactly: extra fields
//!   are silently dropped, and `None` (= TS `null`) is returned on any guard
//!   failure.
//!
//! The inner structs deliberately do **NOT** carry `#[serde(deny_unknown_fields)]`
//! because the TS guard silently drops extra fields on every variant
//! (`denyUnknown: false` in the survey). See `deny_unknown_fields` note in
//! lib.rs for the full rationale.
//!
//! ## Shared types re-used from `tp-proto`
//!
//! - `tp_proto::relay_client::Platform` — `"ios" | "android"` wire enum.
//! - `tp_proto::relay_client::PushData`  — `{sid, daemonId, event}` sub-object,
//!   shared byte-exactly between client-push (relay.push) and server-notification
//!   (relay.notification data field).
//! - `tp_proto::relay_client::Role`      — `"daemon" | "frontend"`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tp_proto::relay_client::{Platform, PushData, Role};

use crate::{is_number, opt_bool, opt_number, opt_string, req_bool, req_string};

// ── Inner payload structs ────────────────────────────────────────────────────
// These are split out from the enum variants so their field-level `#[serde]`
// attributes stay readable. All camelCase → snake_case renames are declared
// here; the `tag = "t"` enum layer adds the discriminant.

/// Payload for `relay.auth.ok` (lines 173-194 relay.ts).
///
/// `resumed == true` additionally requires `resumeToken` and `resumeExpiresAt`
/// to be non-absent. The guard enforces this at lines 90-93; `parse_auth_ok`
/// replicates the check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthOk {
    #[serde(rename = "daemonId")]
    pub daemon_id: String,
    #[serde(rename = "resumeToken", skip_serializing_if = "Option::is_none")]
    pub resume_token: Option<String>,
    #[serde(rename = "resumeExpiresAt", skip_serializing_if = "Option::is_none")]
    pub resume_expires_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed: Option<bool>,
}

/// Payload for `relay.auth.err` (relay.ts:196-199).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthErr {
    pub e: String,
}

/// Payload for `relay.register.ok` (relay.ts:201-204).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterOk {
    #[serde(rename = "daemonId")]
    pub daemon_id: String,
}

/// Payload for `relay.register.err` (relay.ts:205-209).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterErr {
    pub e: String,
}

/// Payload for `relay.frame` (relay.ts:211-220).
///
/// `seq` is validated with `isNonNegativeInt` (same semantics as `relay.pub`);
/// represented as `u64`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub sid: String,
    /// Ciphertext — base64-encoded AEAD blob.
    pub ct: String,
    pub seq: u64,
    /// Direction of the original frame: daemon → frontend or vice versa.
    pub from: Role,
    #[serde(rename = "frontendId", skip_serializing_if = "Option::is_none")]
    pub frontend_id: Option<String>,
}

/// Payload for `relay.kx.frame` (relay.ts:221-228).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyExchangeFrame {
    pub ct: String,
    pub from: Role,
}

/// Payload for `relay.presence` (relay.ts:229-239).
///
/// `lastSeen` is validated with `isNumber` (finite float, epoch ms) → `f64`.
/// `sessions` is always a `Vec<String>` (may be empty for offline presence).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Presence {
    #[serde(rename = "daemonId")]
    pub daemon_id: String,
    pub online: bool,
    pub sessions: Vec<String>,
    #[serde(rename = "lastSeen")]
    pub last_seen: f64,
}

/// Payload for `relay.pong` (relay.ts:240-244).
///
/// `ts` is validated with `isOptionalNumber` (absent or finite number); `f64`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pong {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<f64>,
}

/// Payload for `relay.err` (relay.ts:246-251).
///
/// `e` is a raw error-code string (e.g. `"PUSH_UNSEAL_FAILED"`). There is NO
/// structured enum on the wire — it is always a plain `String`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelayErr {
    pub e: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub m: Option<String>,
}

/// Payload for `relay.notification` (relay.ts:252-270).
///
/// Sent only to frontends. The optional `data` sub-object reuses `PushData`
/// byte-exactly (same three fields, same `daemonId` rename).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<PushData>,
}

/// Payload for `relay.push.token` (relay.ts:271-282).
///
/// Sent only to daemons when a frontend registers its push device token. The
/// relay seals the raw device token before forwarding; `sealed` is the
/// ciphertext.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushToken {
    #[serde(rename = "frontendId")]
    pub frontend_id: String,
    pub sealed: String,
    pub platform: Platform,
}

// ── Top-level discriminated union ────────────────────────────────────────────

/// All messages the relay server can send to a connected client (daemon or
/// frontend). One variant per `t` discriminant value; wire names are preserved
/// via `#[serde(rename = "relay.xxx")]`.
///
/// Serializes to `{"t":"relay.xxx",...rest}` via `#[serde(tag = "t")]`.
/// Deserialization via `serde` is intentionally NOT `#[derive(Deserialize)]`
/// for the enum itself — use `parse_relay_server_message` which replicates the
/// guard's predicate-for-predicate semantics (silent field drop, opt semantics).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t")]
pub enum RelayServerMessage {
    #[serde(rename = "relay.auth.ok")]
    AuthOk(AuthOk),
    #[serde(rename = "relay.auth.err")]
    AuthErr(AuthErr),
    #[serde(rename = "relay.register.ok")]
    RegisterOk(RegisterOk),
    #[serde(rename = "relay.register.err")]
    RegisterErr(RegisterErr),
    #[serde(rename = "relay.frame")]
    Frame(Frame),
    #[serde(rename = "relay.kx.frame")]
    KeyExchangeFrame(KeyExchangeFrame),
    #[serde(rename = "relay.presence")]
    Presence(Presence),
    #[serde(rename = "relay.pong")]
    Pong(Pong),
    #[serde(rename = "relay.err")]
    Err(RelayErr),
    #[serde(rename = "relay.notification")]
    Notification(Notification),
    #[serde(rename = "relay.push.token")]
    PushToken(PushToken),
}

// ── Manual parse boundary ────────────────────────────────────────────────────
// Mirror of relay-server-guard.ts lines 69-202, predicate-for-predicate.

/// Parse a raw (already JSON-parsed) server→client frame. Returns `None` for
/// any unrecognized or malformed message — a dropped frame carries no surfaced
/// reason, mirroring the guard's `return null` paths.
///
/// Extra fields on any variant are silently dropped, matching the guard's
/// field-by-field reconstruct pattern.
pub fn parse_relay_server_message(raw: &Value) -> Option<RelayServerMessage> {
    let obj = raw.as_object()?;
    let t = obj.get("t").and_then(Value::as_str)?;

    match t {
        "relay.auth.ok" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let resume_token = opt_string(obj, "resumeToken")?;
            let resume_expires_at = opt_number(obj, "resumeExpiresAt")?;
            let resumed = opt_bool(obj, "resumed")?;
            // Conditional requirement (guard lines 90-93): when resumed == true,
            // BOTH resumeToken AND resumeExpiresAt must be present.
            if resumed == Some(true) && (resume_token.is_none() || resume_expires_at.is_none()) {
                return None;
            }
            Some(RelayServerMessage::AuthOk(AuthOk {
                daemon_id,
                resume_token,
                resume_expires_at,
                resumed,
            }))
        }
        "relay.auth.err" => {
            let e = req_string(obj, "e")?;
            Some(RelayServerMessage::AuthErr(AuthErr { e }))
        }
        "relay.register.ok" => {
            let daemon_id = req_string(obj, "daemonId")?;
            Some(RelayServerMessage::RegisterOk(RegisterOk { daemon_id }))
        }
        "relay.register.err" => {
            let e = req_string(obj, "e")?;
            Some(RelayServerMessage::RegisterErr(RegisterErr { e }))
        }
        "relay.frame" => {
            let sid = req_string(obj, "sid")?;
            let ct = req_string(obj, "ct")?;
            // seq: isNonNegativeInt (guard line ~130) — integer-valued float ok.
            let seq = crate::is_non_negative_int(obj.get("seq")?)?;
            let from = parse_role(obj.get("from")?)?;
            let frontend_id = opt_string(obj, "frontendId")?;
            Some(RelayServerMessage::Frame(Frame {
                sid,
                ct,
                seq,
                from,
                frontend_id,
            }))
        }
        "relay.kx.frame" => {
            let ct = req_string(obj, "ct")?;
            let from = parse_role(obj.get("from")?)?;
            Some(RelayServerMessage::KeyExchangeFrame(KeyExchangeFrame {
                ct,
                from,
            }))
        }
        "relay.presence" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let online = req_bool(obj, "online")?;
            // sessions: isStringArray (guard line 153) — required, never omitted.
            let sessions = crate::as_string_array(obj.get("sessions")?)?;
            // lastSeen: isNumber (finite float, epoch ms) → f64.
            let last_seen = is_number(obj.get("lastSeen")?)?;
            Some(RelayServerMessage::Presence(Presence {
                daemon_id,
                online,
                sessions,
                last_seen,
            }))
        }
        "relay.pong" => {
            // ts: isOptionalNumber — absent→None, present finite number→Some,
            // present null/non-finite → reject.
            let ts = opt_number(obj, "ts")?;
            Some(RelayServerMessage::Pong(Pong { ts }))
        }
        "relay.err" => {
            let e = req_string(obj, "e")?;
            let m = opt_string(obj, "m")?;
            Some(RelayServerMessage::Err(RelayErr { e, m }))
        }
        "relay.notification" => {
            let title = req_string(obj, "title")?;
            let body = req_string(obj, "body")?;
            // data: isOptionalNotifData (guard lines 55-61).
            let data = parse_push_data_opt(obj.get("data"))?;
            Some(RelayServerMessage::Notification(Notification {
                title,
                body,
                data,
            }))
        }
        "relay.push.token" => {
            let frontend_id = req_string(obj, "frontendId")?;
            let sealed = req_string(obj, "sealed")?;
            let platform = parse_platform(obj.get("platform")?)?;
            Some(RelayServerMessage::PushToken(PushToken {
                frontend_id,
                sealed,
                platform,
            }))
        }
        _ => None, // unrecognized `t` → null (guard default branch)
    }
}

// ── Local parse helpers ──────────────────────────────────────────────────────

/// Parse `"daemon" | "frontend"` wire string into `Role`.
fn parse_role(v: &Value) -> Option<Role> {
    match v.as_str()? {
        "daemon" => Some(Role::Daemon),
        "frontend" => Some(Role::Frontend),
        _ => None,
    }
}

/// Parse `"ios" | "android"` wire string into `Platform`.
fn parse_platform(v: &Value) -> Option<Platform> {
    match v.as_str()? {
        "ios" => Some(Platform::Ios),
        "android" => Some(Platform::Android),
        _ => None,
    }
}

/// `isOptionalNotifData` (guard lines 55-61): absent→`None`; present object
/// with three required string fields→`Some(PushData)`; anything else→reject.
/// `Option<Option<PushData>>` — outer `None` = reject whole message;
/// inner `None` = field absent (ok); `Some(Some(_))` = field present and valid.
#[allow(clippy::option_option)]
fn parse_push_data_opt(v: Option<&Value>) -> Option<Option<PushData>> {
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
        Some(_) => None, // present non-object → reject the whole message
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── relay.auth.ok ────────────────────────────────────────────────────────

    #[test]
    fn auth_ok_minimal_roundtrip() {
        let raw = json!({"t": "relay.auth.ok", "daemonId": "d1"});
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::AuthOk(AuthOk {
                daemon_id: "d1".into(),
                resume_token: None,
                resume_expires_at: None,
                resumed: None,
            })
        );
        // Serialize back and check discriminant + field presence.
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["t"], "relay.auth.ok");
        assert_eq!(v["daemonId"], "d1");
        assert!(v.get("resumeToken").is_none());
    }

    #[test]
    fn auth_ok_resumed_true_requires_token_and_expires() {
        // resumed=true without resumeToken → reject.
        assert!(parse_relay_server_message(&json!({
            "t": "relay.auth.ok", "daemonId": "d1", "resumed": true,
            "resumeExpiresAt": 9999
        }))
        .is_none());
        // resumed=true without resumeExpiresAt → reject.
        assert!(parse_relay_server_message(&json!({
            "t": "relay.auth.ok", "daemonId": "d1", "resumed": true,
            "resumeToken": "tok"
        }))
        .is_none());
        // resumed=true with both present → accept.
        let ok = parse_relay_server_message(&json!({
            "t": "relay.auth.ok", "daemonId": "d1", "resumed": true,
            "resumeToken": "tok", "resumeExpiresAt": 9999
        }))
        .unwrap();
        assert_eq!(
            ok,
            RelayServerMessage::AuthOk(AuthOk {
                daemon_id: "d1".into(),
                resume_token: Some("tok".into()),
                resume_expires_at: Some(9999.0),
                resumed: Some(true),
            })
        );
    }

    #[test]
    fn auth_ok_resumed_false_tokens_optional() {
        // resumed=false → resumeToken / resumeExpiresAt may be absent.
        let ok = parse_relay_server_message(&json!({
            "t": "relay.auth.ok", "daemonId": "d1", "resumed": false
        }))
        .unwrap();
        assert_eq!(
            ok,
            RelayServerMessage::AuthOk(AuthOk {
                daemon_id: "d1".into(),
                resume_token: None,
                resume_expires_at: None,
                resumed: Some(false),
            })
        );
    }

    #[test]
    fn auth_ok_null_optional_fields_rejected() {
        // resumeToken: null → isOptionalString rejects → whole message rejected.
        assert!(parse_relay_server_message(&json!({
            "t": "relay.auth.ok", "daemonId": "d1", "resumeToken": null
        }))
        .is_none());
        // resumed: null → isOptionalBoolean rejects.
        assert!(parse_relay_server_message(&json!({
            "t": "relay.auth.ok", "daemonId": "d1", "resumed": null
        }))
        .is_none());
    }

    // ── relay.auth.err ───────────────────────────────────────────────────────

    #[test]
    fn auth_err_roundtrip() {
        let raw = json!({"t": "relay.auth.err", "e": "UNAUTHORIZED"});
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::AuthErr(AuthErr {
                e: "UNAUTHORIZED".into()
            })
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["t"], "relay.auth.err");
        assert_eq!(v["e"], "UNAUTHORIZED");
    }

    // ── relay.register.ok / err ──────────────────────────────────────────────

    #[test]
    fn register_ok_roundtrip() {
        let raw = json!({"t": "relay.register.ok", "daemonId": "d2"});
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::RegisterOk(RegisterOk {
                daemon_id: "d2".into()
            })
        );
    }

    #[test]
    fn register_err_roundtrip() {
        let raw = json!({"t": "relay.register.err", "e": "BAD_PROOF"});
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::RegisterErr(RegisterErr {
                e: "BAD_PROOF".into()
            })
        );
    }

    // ── relay.frame ──────────────────────────────────────────────────────────

    #[test]
    fn frame_roundtrip_with_frontend_id() {
        let raw = json!({
            "t": "relay.frame", "sid": "s1", "ct": "AAAA==", "seq": 3,
            "from": "daemon", "frontendId": "f1"
        });
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::Frame(Frame {
                sid: "s1".into(),
                ct: "AAAA==".into(),
                seq: 3,
                from: Role::Daemon,
                frontend_id: Some("f1".into()),
            })
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["frontendId"], "f1");
    }

    #[test]
    fn frame_seq_integer_semantics() {
        // Non-integer float → reject (isNonNegativeInt).
        assert!(parse_relay_server_message(&json!({
            "t": "relay.frame", "sid": "s", "ct": "c", "seq": 1.5, "from": "daemon"
        }))
        .is_none());
        // Integer-valued float 2.0 → accepted (Number.isInteger(2.0) is true).
        let ok = parse_relay_server_message(&json!({
            "t": "relay.frame", "sid": "s", "ct": "c", "seq": 2.0, "from": "daemon"
        }));
        assert!(ok.is_some());
    }

    #[test]
    fn frame_bad_from_rejected() {
        assert!(parse_relay_server_message(&json!({
            "t": "relay.frame", "sid": "s", "ct": "c", "seq": 0, "from": "relay"
        }))
        .is_none());
    }

    // ── relay.kx.frame ───────────────────────────────────────────────────────

    #[test]
    fn kx_frame_roundtrip() {
        let raw = json!({"t": "relay.kx.frame", "ct": "kxblob", "from": "frontend"});
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::KeyExchangeFrame(KeyExchangeFrame {
                ct: "kxblob".into(),
                from: Role::Frontend,
            })
        );
    }

    // ── relay.presence ───────────────────────────────────────────────────────

    #[test]
    fn presence_online() {
        let raw = json!({
            "t": "relay.presence", "daemonId": "d1", "online": true,
            "sessions": ["s1", "s2"], "lastSeen": 1_700_000_000.5
        });
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::Presence(Presence {
                daemon_id: "d1".into(),
                online: true,
                sessions: vec!["s1".into(), "s2".into()],
                last_seen: 1_700_000_000.5,
            })
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["lastSeen"], 1_700_000_000.5_f64);
    }

    #[test]
    fn presence_offline_empty_sessions() {
        // Offline presence may have an empty sessions array (relay emits `[]`).
        let raw = json!({
            "t": "relay.presence", "daemonId": "d1", "online": false,
            "sessions": [], "lastSeen": 0
        });
        assert!(parse_relay_server_message(&raw).is_some());
    }

    #[test]
    fn presence_missing_sessions_rejected() {
        // sessions is required (isStringArray, never omitted).
        assert!(parse_relay_server_message(&json!({
            "t": "relay.presence", "daemonId": "d1", "online": true, "lastSeen": 0
        }))
        .is_none());
    }

    // ── relay.pong ───────────────────────────────────────────────────────────

    #[test]
    fn pong_with_and_without_ts() {
        let with_ts = parse_relay_server_message(&json!({"t": "relay.pong", "ts": 1234.5}));
        assert_eq!(
            with_ts.unwrap(),
            RelayServerMessage::Pong(Pong { ts: Some(1234.5) })
        );
        let without_ts = parse_relay_server_message(&json!({"t": "relay.pong"}));
        assert_eq!(
            without_ts.unwrap(),
            RelayServerMessage::Pong(Pong { ts: None })
        );
        // ts: null → isOptionalNumber rejects → whole message rejected.
        assert!(parse_relay_server_message(&json!({"t": "relay.pong", "ts": null})).is_none());
    }

    // ── relay.err ────────────────────────────────────────────────────────────

    #[test]
    fn relay_err_with_and_without_m() {
        let with_m = parse_relay_server_message(&json!({
            "t": "relay.err", "e": "PUSH_UNSEAL_FAILED", "m": "bad key"
        }))
        .unwrap();
        assert_eq!(
            with_m,
            RelayServerMessage::Err(RelayErr {
                e: "PUSH_UNSEAL_FAILED".into(),
                m: Some("bad key".into()),
            })
        );
        let without_m =
            parse_relay_server_message(&json!({"t": "relay.err", "e": "UNKNOWN_TYPE"})).unwrap();
        assert_eq!(
            without_m,
            RelayServerMessage::Err(RelayErr {
                e: "UNKNOWN_TYPE".into(),
                m: None,
            })
        );
    }

    // ── relay.notification ───────────────────────────────────────────────────

    #[test]
    fn notification_with_data() {
        let raw = json!({
            "t": "relay.notification",
            "title": "Claude finished", "body": "Session done",
            "data": {"sid": "s1", "daemonId": "d1", "event": "Stop"}
        });
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::Notification(Notification {
                title: "Claude finished".into(),
                body: "Session done".into(),
                data: Some(PushData {
                    sid: "s1".into(),
                    daemon_id: "d1".into(),
                    event: "Stop".into(),
                }),
            })
        );
        // data.daemonId serializes as "daemonId" (PushData rename).
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["data"]["daemonId"], "d1");
    }

    #[test]
    fn notification_without_data() {
        let raw = json!({"t": "relay.notification", "title": "T", "body": "B"});
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::Notification(Notification {
                title: "T".into(),
                body: "B".into(),
                data: None,
            })
        );
    }

    #[test]
    fn notification_data_null_rejected() {
        // data: null → isOptionalNotifData rejects (null is not an object).
        assert!(parse_relay_server_message(&json!({
            "t": "relay.notification", "title": "T", "body": "B", "data": null
        }))
        .is_none());
    }

    // ── relay.push.token ─────────────────────────────────────────────────────

    #[test]
    fn push_token_roundtrip() {
        let raw = json!({
            "t": "relay.push.token",
            "frontendId": "f1", "sealed": "tpps1.1.AAAA", "platform": "ios"
        });
        let msg = parse_relay_server_message(&raw).unwrap();
        assert_eq!(
            msg,
            RelayServerMessage::PushToken(PushToken {
                frontend_id: "f1".into(),
                sealed: "tpps1.1.AAAA".into(),
                platform: Platform::Ios,
            })
        );
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["frontendId"], "f1");
        assert_eq!(v["platform"], "ios");
    }

    #[test]
    fn push_token_android() {
        let ok = parse_relay_server_message(&json!({
            "t": "relay.push.token",
            "frontendId": "f1", "sealed": "s", "platform": "android"
        }));
        assert!(matches!(
            ok,
            Some(RelayServerMessage::PushToken(PushToken {
                platform: Platform::Android,
                ..
            }))
        ));
    }

    #[test]
    fn push_token_bad_platform_rejected() {
        assert!(parse_relay_server_message(&json!({
            "t": "relay.push.token",
            "frontendId": "f1", "sealed": "s", "platform": "web"
        }))
        .is_none());
    }

    // ── Extra-field drop + unknown-t ─────────────────────────────────────────

    #[test]
    fn extra_fields_are_dropped() {
        // relay.pong with an extra "evil" field still parses (guard drops it).
        let ok = parse_relay_server_message(&json!({
            "t": "relay.pong", "ts": 1, "evil": "x"
        }));
        assert!(ok.is_some());
    }

    #[test]
    fn unknown_t_is_rejected() {
        assert!(parse_relay_server_message(&json!({"t": "relay.bogus"})).is_none());
        assert!(parse_relay_server_message(&json!({"t": "relay.frame.v3"})).is_none());
    }
}
