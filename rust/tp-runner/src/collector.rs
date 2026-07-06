//! Record construction — byte-exact port of
//! `packages/runner/src/collector.ts`.
//!
//! Two record kinds, mirroring the Bun `Collector`:
//!
//! - **io** ([`Collector::io_record`]): raw PTY output. The bytes ride as a
//!   **binary sidecar** in the frame — `payload` stays empty — so the ~33%
//!   base64 overhead is skipped on the hot path. This is the load-bearing Stage
//!   4 parity gate: `payload == "" && binary.is_some()`.
//! - **event** ([`Collector::event_record`]): a Claude hook event. The event
//!   JSON is base64-encoded into `payload` (STANDARD alphabet, matching Bun
//!   `Buffer.from(JSON.stringify(event)).toString("base64")`), with `ns="claude"`
//!   and `name=event.hook_event_name`.
//!
//! The wire struct field order matches the TS object-literal key order so the
//! emitted JSON is byte-identical to the Bun runner's:
//! io   → `{t,sid,kind,ts,payload}`
//! event→ `{t,sid,kind,ts,ns,name,payload}`.
//!
//! `ts` is `Date.now()` (a JS millisecond epoch, a float in the wire shape) —
//! non-deterministic, so it is injected by the caller in tests and via a monotone
//! clock in production. The struct carries it as `f64` to match the TS `number`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;

/// A `rec` frame ready to encode. `payload` is empty for io (bytes live in
/// `binary`) and base64 for event. Field order = TS object-literal order.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RecMsg {
    pub t: &'static str,
    pub sid: String,
    pub kind: &'static str,
    pub ts: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ns: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub payload: String,
}

/// An io record: the JSON message plus the raw bytes that ride as a binary
/// sidecar. Mirrors the TS `IoFrame`.
#[derive(Debug, Clone)]
pub struct IoRecord {
    pub msg: RecMsg,
    pub binary: Vec<u8>,
}

/// Converts PTY data and hook events into `rec` frame messages.
pub struct Collector {
    sid: String,
}

impl Collector {
    #[must_use]
    pub fn new(sid: impl Into<String>) -> Self {
        Collector { sid: sid.into() }
    }

    /// Convert raw PTY output to an io record. The bytes ride as a binary
    /// sidecar (`payload=""`); the receiver recognises them via the frame's
    /// `binary` field. `ts` is the caller-supplied `Date.now()`-equivalent
    /// millisecond epoch.
    #[must_use]
    pub fn io_record(&self, data: Vec<u8>, ts: f64) -> IoRecord {
        IoRecord {
            msg: RecMsg {
                t: "rec",
                sid: self.sid.clone(),
                kind: "io",
                ts,
                ns: None,
                name: None,
                payload: String::new(),
            },
            binary: data,
        }
    }

    /// Convert a hook event to an event record. `event` is the parsed hook event
    /// JSON; its `hook_event_name` string becomes `name` and the whole object is
    /// base64(JSON) in `payload`. `ts` is the caller-supplied millisecond epoch.
    ///
    /// Returns `None` if `event` is not a JSON object with a string
    /// `hook_event_name` (the TS receives an already-parsed `HookEventBase`, so
    /// this guards the boundary the Rust hook receiver will feed in).
    #[must_use]
    pub fn event_record(&self, event: &Value, ts: f64) -> Option<RecMsg> {
        let name = event.get("hook_event_name")?.as_str()?.to_string();
        // serde_json::to_vec matches JSON.stringify semantically (compact, no
        // spaces). Byte-exactness of the base64 is not load-bearing — the daemon
        // base64-decodes and JSON-parses this payload, so only valid base64 of
        // valid JSON of the event matters.
        let json = serde_json::to_vec(event).ok()?;
        let payload = STANDARD.encode(&json);
        Some(RecMsg {
            t: "rec",
            sid: self.sid.clone(),
            kind: "event",
            ts,
            ns: Some("claude"),
            name: Some(name),
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn io_record_uses_binary_sidecar_empty_payload() {
        // The Stage 4 parity gate: io bytes never base64 into payload.
        let c = Collector::new("sess-x");
        let rec = c.io_record(vec![0x1b, b'[', b'0', b'm'], 1234.0);
        assert_eq!(rec.msg.payload, "");
        assert_eq!(rec.binary, vec![0x1b, b'[', b'0', b'm']);
        assert_eq!(rec.msg.kind, "io");
        assert_eq!(rec.msg.sid, "sess-x");
        assert!(rec.msg.ns.is_none());
        assert!(rec.msg.name.is_none());
    }

    #[test]
    fn io_record_json_omits_ns_name_and_matches_key_order() {
        // The io JSON must serialise to exactly {t,sid,kind,ts,payload} with no
        // ns/name keys — byte-parity with the Bun IpcRec object literal.
        let c = Collector::new("s");
        let rec = c.io_record(vec![1, 2, 3], 42.0);
        let s = serde_json::to_string(&rec.msg).unwrap();
        assert_eq!(
            s,
            r#"{"t":"rec","sid":"s","kind":"io","ts":42.0,"payload":""}"#
        );
    }

    #[test]
    fn event_record_base64_payload_ns_and_name() {
        let c = Collector::new("sess-y");
        let event = json!({
            "hook_event_name": "Stop",
            "session_id": "abc",
            "last_assistant_message": "done"
        });
        let rec = c.event_record(&event, 999.0).unwrap();
        assert_eq!(rec.kind, "event");
        assert_eq!(rec.ns, Some("claude"));
        assert_eq!(rec.name.as_deref(), Some("Stop"));
        assert_eq!(rec.ts, 999.0);
        // payload decodes back to the event JSON.
        let decoded = STANDARD.decode(rec.payload.as_bytes()).unwrap();
        let back: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(back, event);
    }

    #[test]
    fn event_record_rejects_missing_hook_event_name() {
        let c = Collector::new("s");
        assert!(c.event_record(&json!({"no_name": true}), 0.0).is_none());
        assert!(c
            .event_record(&json!({"hook_event_name": 42}), 0.0)
            .is_none());
        assert!(c.event_record(&json!("not an object"), 0.0).is_none());
    }
}
