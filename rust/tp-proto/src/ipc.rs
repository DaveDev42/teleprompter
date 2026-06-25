//! Runner ↔ Daemon IPC messages.
//!
//! Byte-exact port of `packages/protocol/src/ipc-guard.ts` (`parseIpcMessage`,
//! 28 variants) + `types/ipc.ts`. The IPC transport hands raw decoded JSON as
//! `unknown`; `parse_ipc_message` narrows it to the typed union or returns
//! `None` (a dropped frame), mirroring the TS `switch` predicate-for-predicate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::label::{decode_wire_label, Label};
use crate::{
    as_string_array, is_non_negative_int, is_number, is_positive_int, is_terminal_dimension,
    opt_string, req_bool, req_string,
};

// ---------------------------------------------------------------------------
// Small enums mirrored from types/record.ts + the reason unions in types/ipc.ts.
// Each `from_str` reproduces the corresponding `*_SET.has(..)` membership test.
// ---------------------------------------------------------------------------

/// `RecordKind = "io" | "event" | "meta"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    Io,
    Event,
    Meta,
}

impl RecordKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "io" => Some(Self::Io),
            "event" => Some(Self::Event),
            "meta" => Some(Self::Meta),
            _ => None,
        }
    }
}

/// `Namespace = "claude" | "tp" | "runner" | "daemon"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Namespace {
    Claude,
    Tp,
    Runner,
    Daemon,
}

impl Namespace {
    /// `isOptionalNamespace`: absent → `Some(None)`; a known string →
    /// `Some(Some(..))`; anything else (incl. null) → `None`.
    fn parse_opt(v: Option<&Value>) -> Option<Option<Self>> {
        match v {
            None => Some(None),
            Some(Value::String(s)) => match s.as_str() {
                "claude" => Some(Some(Self::Claude)),
                "tp" => Some(Some(Self::Tp)),
                "runner" => Some(Some(Self::Runner)),
                "daemon" => Some(Some(Self::Daemon)),
                _ => None,
            },
            Some(_) => None,
        }
    }
}

macro_rules! str_enum {
    ($name:ident { $($variant:ident => $lit:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $lit)] $variant),+
        }
        impl $name {
            fn from_str(s: &str) -> Option<Self> {
                match s {
                    $($lit => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

str_enum!(IpcPairBeginErrReason {
    AlreadyPending => "already-pending",
    DaemonIdTaken => "daemon-id-taken",
    RelayUnreachable => "relay-unreachable",
    Internal => "internal",
});
str_enum!(IpcPairErrorReason {
    RelayUnreachable => "relay-unreachable",
    RelayClosed => "relay-closed",
    KxDecryptFailed => "kx-decrypt-failed",
    Internal => "internal",
});
str_enum!(IpcPairRemoveErrReason {
    NotFound => "not-found",
    Internal => "internal",
});
str_enum!(IpcPairRenameErrReason {
    NotFound => "not-found",
    Internal => "internal",
});
str_enum!(IpcSessionDeleteErrReason {
    NotFound => "not-found",
    Internal => "internal",
});
str_enum!(IpcSessionPruneErrReason {
    Internal => "internal",
});

/// `AgeFilter = { kind: "all" } | { kind: "olderThan"; ms }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AgeFilter {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "olderThan")]
    OlderThan { ms: u64 },
}

/// `parseAgeFilter` (ipc-guard.ts:74-84). `None` for any malformed shape.
fn parse_age_filter(v: Option<&Value>) -> Option<AgeFilter> {
    let obj = v?.as_object()?;
    match obj.get("kind").and_then(Value::as_str)? {
        "all" => Some(AgeFilter::All),
        "olderThan" => {
            let ms = is_non_negative_int(obj.get("ms")?)?;
            Some(AgeFilter::OlderThan { ms })
        }
        _ => None,
    }
}

/// `parseLabelField` (ipc-guard.ts:54-64). Reject only an outright wrong-typed
/// field — a non-null, non-string value that is NOT an object carrying a "set"
/// key (a bare number/boolean, OR an object/array lacking "set"). Everything
/// that survives is run through the total `decode_wire_label`.
///
/// Pass `None` for an absent key (TS `undefined`) — it is accepted and decodes
/// to `Unset`, same as `null`.
fn parse_label_field(v: Option<&Value>) -> Option<Label> {
    match v {
        None | Some(Value::Null) => Some(decode_wire_label(&Value::Null)),
        Some(Value::String(_)) => Some(decode_wire_label(v.unwrap())),
        Some(Value::Object(map)) if map.contains_key("set") => Some(decode_wire_label(v.unwrap())),
        // number / boolean / array / object-without-"set" → reject.
        Some(_) => None,
    }
}

/// Per-pairing relay health snapshot (`IpcDoctorRelayStatus`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DoctorRelayStatus {
    #[serde(rename = "daemonId")]
    pub daemon_id: String,
    #[serde(rename = "relayUrl")]
    pub relay_url: String,
    pub connected: bool,
    #[serde(rename = "peerCount")]
    pub peer_count: u64,
}

/// The Runner ↔ Daemon discriminated union.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t")]
pub enum IpcMessage {
    #[serde(rename = "hello")]
    Hello {
        sid: String,
        cwd: String,
        // Field order in the struct matches the TS interface (pid last) so
        // serde's serialized key order is byte-stable for the golden test...
        #[serde(rename = "worktreePath", skip_serializing_if = "Option::is_none")]
        worktree_path: Option<String>,
        #[serde(rename = "claudeVersion", skip_serializing_if = "Option::is_none")]
        claude_version: Option<String>,
        pid: u64,
    },
    #[serde(rename = "rec")]
    Rec {
        sid: String,
        kind: RecordKind,
        ts: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        ns: Option<Namespace>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        payload: String,
    },
    #[serde(rename = "bye")]
    Bye {
        sid: String,
        #[serde(rename = "exitCode")]
        exit_code: f64,
    },
    #[serde(rename = "ack")]
    Ack { sid: String, seq: u64 },
    #[serde(rename = "input")]
    Input { sid: String, data: String },
    #[serde(rename = "resize")]
    Resize { sid: String, cols: u64, rows: u64 },
    #[serde(rename = "pair.begin")]
    PairBegin {
        #[serde(rename = "relayUrl")]
        relay_url: String,
        #[serde(rename = "daemonId", skip_serializing_if = "Option::is_none")]
        daemon_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<Label>,
    },
    #[serde(rename = "pair.begin.ok")]
    PairBeginOk {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        #[serde(rename = "qrString")]
        qr_string: String,
        #[serde(rename = "daemonId")]
        daemon_id: String,
    },
    #[serde(rename = "pair.begin.err")]
    PairBeginErr {
        reason: IpcPairBeginErrReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "pair.cancel")]
    PairCancel {
        #[serde(rename = "pairingId")]
        pairing_id: String,
    },
    #[serde(rename = "pair.completed")]
    PairCompleted {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        #[serde(rename = "daemonId")]
        daemon_id: String,
        label: Label,
    },
    #[serde(rename = "pair.cancelled")]
    PairCancelled {
        #[serde(rename = "pairingId")]
        pairing_id: String,
    },
    #[serde(rename = "pair.error")]
    PairError {
        #[serde(rename = "pairingId")]
        pairing_id: String,
        reason: IpcPairErrorReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "pair.remove")]
    PairRemove {
        #[serde(rename = "daemonId")]
        daemon_id: String,
    },
    #[serde(rename = "pair.remove.ok")]
    PairRemoveOk {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        #[serde(rename = "notifiedPeers")]
        notified_peers: u64,
    },
    #[serde(rename = "pair.remove.err")]
    PairRemoveErr {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        reason: IpcPairRemoveErrReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "pair.rename")]
    PairRename {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        label: Label,
    },
    #[serde(rename = "pair.rename.ok")]
    PairRenameOk {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        label: Label,
        #[serde(rename = "notifiedPeers")]
        notified_peers: u64,
    },
    #[serde(rename = "pair.rename.err")]
    PairRenameErr {
        #[serde(rename = "daemonId")]
        daemon_id: String,
        reason: IpcPairRenameErrReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "session.delete")]
    SessionDelete { sid: String },
    #[serde(rename = "session.delete.ok")]
    SessionDeleteOk {
        sid: String,
        #[serde(rename = "wasRunning")]
        was_running: bool,
    },
    #[serde(rename = "session.delete.err")]
    SessionDeleteErr {
        sid: String,
        reason: IpcSessionDeleteErrReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "session.prune")]
    SessionPrune {
        age: AgeFilter,
        #[serde(rename = "includeRunning")]
        include_running: bool,
        #[serde(rename = "dryRun")]
        dry_run: bool,
    },
    #[serde(rename = "session.prune.ok")]
    SessionPruneOk {
        sids: Vec<String>,
        #[serde(rename = "runningKilled")]
        running_killed: u64,
        #[serde(rename = "dryRun")]
        dry_run: bool,
    },
    #[serde(rename = "session.prune.err")]
    SessionPruneErr {
        reason: IpcSessionPruneErrReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(rename = "partialSids")]
        partial_sids: Vec<String>,
        #[serde(rename = "partialRunningKilled")]
        partial_running_killed: u64,
    },
    #[serde(rename = "doctor.probe")]
    DoctorProbe,
    #[serde(rename = "doctor.probe.ok")]
    DoctorProbeOk { relays: Vec<DoctorRelayStatus> },
}

/// Parse a raw (JSON-parsed) IPC payload. `None` if not a valid IPC message.
/// Mirror of `parseIpcMessage` (ipc-guard.ts:167-473).
pub fn parse_ipc_message(raw: &Value) -> Option<IpcMessage> {
    let obj = raw.as_object()?;
    let t = obj.get("t").and_then(Value::as_str)?;

    match t {
        "hello" => {
            let sid = req_string(obj, "sid")?;
            let cwd = req_string(obj, "cwd")?;
            let pid = is_positive_int(obj.get("pid")?)?;
            let worktree_path = opt_string(obj, "worktreePath")?;
            let claude_version = opt_string(obj, "claudeVersion")?;
            Some(IpcMessage::Hello {
                sid,
                cwd,
                worktree_path,
                claude_version,
                pid,
            })
        }
        "rec" => {
            let sid = req_string(obj, "sid")?;
            let kind = RecordKind::from_str(obj.get("kind").and_then(Value::as_str)?)?;
            let ts = is_number(obj.get("ts")?)?;
            let payload = req_string(obj, "payload")?;
            let ns = Namespace::parse_opt(obj.get("ns"))?;
            let name = opt_string(obj, "name")?;
            Some(IpcMessage::Rec {
                sid,
                kind,
                ts,
                ns,
                name,
                payload,
            })
        }
        "bye" => {
            let sid = req_string(obj, "sid")?;
            let exit_code = is_number(obj.get("exitCode")?)?;
            Some(IpcMessage::Bye { sid, exit_code })
        }
        "ack" => {
            let sid = req_string(obj, "sid")?;
            let seq = is_non_negative_int(obj.get("seq")?)?;
            Some(IpcMessage::Ack { sid, seq })
        }
        "input" => {
            let sid = req_string(obj, "sid")?;
            let data = req_string(obj, "data")?;
            Some(IpcMessage::Input { sid, data })
        }
        "resize" => {
            let sid = req_string(obj, "sid")?;
            // cols/rows are uint16 at the kernel (TIOCSWINSZ ws_col/ws_row); cap at
            // 65535 (MAX_TERMINAL_DIMENSION) so a relay-plane value the daemon forwards
            // here cannot truncate. Mirrors `isTerminalDimension` (guard-primitives.ts).
            let cols = is_terminal_dimension(obj.get("cols")?)?;
            let rows = is_terminal_dimension(obj.get("rows")?)?;
            Some(IpcMessage::Resize { sid, cols, rows })
        }
        "pair.begin" => {
            let relay_url = req_string(obj, "relayUrl")?;
            let daemon_id = opt_string(obj, "daemonId")?;
            // label optional: absent → None; present → must survive parse_label_field.
            let label = match obj.get("label") {
                None => None,
                Some(v) => Some(parse_label_field(Some(v))?),
            };
            Some(IpcMessage::PairBegin {
                relay_url,
                daemon_id,
                label,
            })
        }
        "pair.begin.ok" => {
            let pairing_id = req_string(obj, "pairingId")?;
            let qr_string = req_string(obj, "qrString")?;
            let daemon_id = req_string(obj, "daemonId")?;
            Some(IpcMessage::PairBeginOk {
                pairing_id,
                qr_string,
                daemon_id,
            })
        }
        "pair.begin.err" => {
            let reason =
                IpcPairBeginErrReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let message = opt_string(obj, "message")?;
            Some(IpcMessage::PairBeginErr { reason, message })
        }
        "pair.cancel" => {
            let pairing_id = req_string(obj, "pairingId")?;
            Some(IpcMessage::PairCancel { pairing_id })
        }
        "pair.completed" => {
            let pairing_id = req_string(obj, "pairingId")?;
            let daemon_id = req_string(obj, "daemonId")?;
            // label REQUIRED here: parse_label_field(None) → Some(Unset) would be
            // wrong — TS calls parseLabelField(raw["label"]) where absent ===
            // undefined, which decodeWireLabel maps to Unset and is accepted.
            // So absent label is accepted and decodes to Unset, matching TS.
            let label = parse_label_field(obj.get("label"))?;
            Some(IpcMessage::PairCompleted {
                pairing_id,
                daemon_id,
                label,
            })
        }
        "pair.cancelled" => {
            let pairing_id = req_string(obj, "pairingId")?;
            Some(IpcMessage::PairCancelled { pairing_id })
        }
        "pair.error" => {
            let pairing_id = req_string(obj, "pairingId")?;
            let reason = IpcPairErrorReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let message = opt_string(obj, "message")?;
            Some(IpcMessage::PairError {
                pairing_id,
                reason,
                message,
            })
        }
        "pair.remove" => {
            let daemon_id = req_string(obj, "daemonId")?;
            Some(IpcMessage::PairRemove { daemon_id })
        }
        "pair.remove.ok" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let notified_peers = is_non_negative_int(obj.get("notifiedPeers")?)?;
            Some(IpcMessage::PairRemoveOk {
                daemon_id,
                notified_peers,
            })
        }
        "pair.remove.err" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let reason =
                IpcPairRemoveErrReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let message = opt_string(obj, "message")?;
            Some(IpcMessage::PairRemoveErr {
                daemon_id,
                reason,
                message,
            })
        }
        "pair.rename" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let label = parse_label_field(obj.get("label"))?;
            Some(IpcMessage::PairRename { daemon_id, label })
        }
        "pair.rename.ok" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let label = parse_label_field(obj.get("label"))?;
            let notified_peers = is_non_negative_int(obj.get("notifiedPeers")?)?;
            Some(IpcMessage::PairRenameOk {
                daemon_id,
                label,
                notified_peers,
            })
        }
        "pair.rename.err" => {
            let daemon_id = req_string(obj, "daemonId")?;
            let reason =
                IpcPairRenameErrReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let message = opt_string(obj, "message")?;
            Some(IpcMessage::PairRenameErr {
                daemon_id,
                reason,
                message,
            })
        }
        "session.delete" => {
            let sid = req_string(obj, "sid")?;
            Some(IpcMessage::SessionDelete { sid })
        }
        "session.delete.ok" => {
            let sid = req_string(obj, "sid")?;
            let was_running = req_bool(obj, "wasRunning")?;
            Some(IpcMessage::SessionDeleteOk { sid, was_running })
        }
        "session.delete.err" => {
            let sid = req_string(obj, "sid")?;
            let reason =
                IpcSessionDeleteErrReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let message = opt_string(obj, "message")?;
            Some(IpcMessage::SessionDeleteErr {
                sid,
                reason,
                message,
            })
        }
        "session.prune" => {
            let age = parse_age_filter(obj.get("age"))?;
            let include_running = req_bool(obj, "includeRunning")?;
            let dry_run = req_bool(obj, "dryRun")?;
            Some(IpcMessage::SessionPrune {
                age,
                include_running,
                dry_run,
            })
        }
        "session.prune.ok" => {
            let sids = as_string_array(obj.get("sids")?)?;
            let running_killed = is_non_negative_int(obj.get("runningKilled")?)?;
            let dry_run = req_bool(obj, "dryRun")?;
            Some(IpcMessage::SessionPruneOk {
                sids,
                running_killed,
                dry_run,
            })
        }
        "session.prune.err" => {
            let reason =
                IpcSessionPruneErrReason::from_str(obj.get("reason").and_then(Value::as_str)?)?;
            let message = opt_string(obj, "message")?;
            let partial_sids = as_string_array(obj.get("partialSids")?)?;
            let partial_running_killed = is_non_negative_int(obj.get("partialRunningKilled")?)?;
            Some(IpcMessage::SessionPruneErr {
                reason,
                message,
                partial_sids,
                partial_running_killed,
            })
        }
        "doctor.probe" => Some(IpcMessage::DoctorProbe),
        "doctor.probe.ok" => {
            let relays_raw = obj.get("relays")?.as_array()?;
            let mut relays = Vec::with_capacity(relays_raw.len());
            for r in relays_raw {
                let ro = r.as_object()?;
                let daemon_id = req_string(ro, "daemonId")?;
                let relay_url = req_string(ro, "relayUrl")?;
                let connected = req_bool(ro, "connected")?;
                let peer_count = is_non_negative_int(ro.get("peerCount")?)?;
                relays.push(DoctorRelayStatus {
                    daemon_id,
                    relay_url,
                    connected,
                    peer_count,
                });
            }
            Some(IpcMessage::DoctorProbeOk { relays })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hello_requires_positive_pid() {
        assert!(parse_ipc_message(&json!({
            "t": "hello", "sid": "s", "cwd": "/x", "pid": 0
        }))
        .is_none());
        let ok = parse_ipc_message(&json!({
            "t": "hello", "sid": "s", "cwd": "/x", "pid": 42
        }));
        assert_eq!(
            ok,
            Some(IpcMessage::Hello {
                sid: "s".into(),
                cwd: "/x".into(),
                worktree_path: None,
                claude_version: None,
                pid: 42
            })
        );
        // null worktreePath → reject (isOptionalString rejects null).
        assert!(parse_ipc_message(&json!({
            "t": "hello", "sid": "s", "cwd": "/x", "pid": 1, "worktreePath": null
        }))
        .is_none());
    }

    #[test]
    fn rec_ns_and_ts_semantics() {
        // ts may be a non-integer (isNumber).
        let ok = parse_ipc_message(&json!({
            "t": "rec", "sid": "s", "kind": "event", "ts": 1.5,
            "payload": "AAAA", "ns": "claude"
        }))
        .unwrap();
        assert_eq!(
            ok,
            IpcMessage::Rec {
                sid: "s".into(),
                kind: RecordKind::Event,
                ts: 1.5,
                ns: Some(Namespace::Claude),
                name: None,
                payload: "AAAA".into()
            }
        );
        // bad ns → reject.
        assert!(parse_ipc_message(&json!({
            "t": "rec", "sid": "s", "kind": "io", "ts": 1, "payload": "x", "ns": "bogus"
        }))
        .is_none());
        // null ns → reject (isOptionalNamespace(null) is false).
        assert!(parse_ipc_message(&json!({
            "t": "rec", "sid": "s", "kind": "io", "ts": 1, "payload": "x", "ns": null
        }))
        .is_none());
    }

    #[test]
    fn bye_exit_code_is_number_not_int() {
        // exitCode uses isNumber → a non-integer is accepted on the wire.
        let ok = parse_ipc_message(&json!({"t": "bye", "sid": "s", "exitCode": -1.0}));
        assert_eq!(
            ok,
            Some(IpcMessage::Bye {
                sid: "s".into(),
                exit_code: -1.0
            })
        );
    }

    #[test]
    fn age_filter_shapes() {
        assert_eq!(
            parse_ipc_message(&json!({
                "t": "session.prune", "age": {"kind": "all"},
                "includeRunning": false, "dryRun": true
            })),
            Some(IpcMessage::SessionPrune {
                age: AgeFilter::All,
                include_running: false,
                dry_run: true
            })
        );
        assert_eq!(
            parse_ipc_message(&json!({
                "t": "session.prune", "age": {"kind": "olderThan", "ms": 86400000},
                "includeRunning": true, "dryRun": false
            })),
            Some(IpcMessage::SessionPrune {
                age: AgeFilter::OlderThan { ms: 86_400_000 },
                include_running: true,
                dry_run: false
            })
        );
        // olderThan without ms → reject.
        assert!(parse_ipc_message(&json!({
            "t": "session.prune", "age": {"kind": "olderThan"},
            "includeRunning": false, "dryRun": false
        }))
        .is_none());
        // includeRunning must be strict boolean (no truthy coercion).
        assert!(parse_ipc_message(&json!({
            "t": "session.prune", "age": {"kind": "all"},
            "includeRunning": 1, "dryRun": false
        }))
        .is_none());
    }

    #[test]
    fn label_field_rejects_wrong_types_but_accepts_legacy() {
        // pair.rename with a bare number label → reject.
        assert!(parse_ipc_message(&json!({
            "t": "pair.rename", "daemonId": "d", "label": 42
        }))
        .is_none());
        // object without "set" key → reject.
        assert!(parse_ipc_message(&json!({
            "t": "pair.rename", "daemonId": "d", "label": {"name": "x"}
        }))
        .is_none());
        // array → reject.
        assert!(parse_ipc_message(&json!({
            "t": "pair.rename", "daemonId": "d", "label": ["x"]
        }))
        .is_none());
        // legacy string accepted → trimmed Set.
        assert_eq!(
            parse_ipc_message(&json!({
                "t": "pair.rename", "daemonId": "d", "label": "  Office  "
            })),
            Some(IpcMessage::PairRename {
                daemon_id: "d".into(),
                label: Label::Set {
                    value: "Office".into()
                }
            })
        );
        // union object accepted.
        assert_eq!(
            parse_ipc_message(&json!({
                "t": "pair.rename", "daemonId": "d", "label": {"set": false}
            })),
            Some(IpcMessage::PairRename {
                daemon_id: "d".into(),
                label: Label::Unset
            })
        );
        // absent label on pair.rename → decodes to Unset (TS reads undefined).
        assert_eq!(
            parse_ipc_message(&json!({"t": "pair.rename", "daemonId": "d"})),
            Some(IpcMessage::PairRename {
                daemon_id: "d".into(),
                label: Label::Unset
            })
        );
    }

    #[test]
    fn pair_begin_label_optional() {
        // pair.begin: absent label → None (the field itself is optional).
        assert_eq!(
            parse_ipc_message(&json!({"t": "pair.begin", "relayUrl": "wss://r"})),
            Some(IpcMessage::PairBegin {
                relay_url: "wss://r".into(),
                daemon_id: None,
                label: None
            })
        );
        // present-but-bad label → reject the whole frame.
        assert!(parse_ipc_message(&json!({
            "t": "pair.begin", "relayUrl": "wss://r", "label": 5
        }))
        .is_none());
        // present good label → Some.
        assert_eq!(
            parse_ipc_message(&json!({
                "t": "pair.begin", "relayUrl": "wss://r", "label": "Mac"
            })),
            Some(IpcMessage::PairBegin {
                relay_url: "wss://r".into(),
                daemon_id: None,
                label: Some(Label::Set {
                    value: "Mac".into()
                })
            })
        );
    }

    #[test]
    fn doctor_probe_and_ok() {
        assert_eq!(
            parse_ipc_message(&json!({"t": "doctor.probe"})),
            Some(IpcMessage::DoctorProbe)
        );
        let ok = parse_ipc_message(&json!({
            "t": "doctor.probe.ok",
            "relays": [
                {"daemonId": "d1", "relayUrl": "wss://r", "connected": true, "peerCount": 2}
            ]
        }))
        .unwrap();
        assert_eq!(
            ok,
            IpcMessage::DoctorProbeOk {
                relays: vec![DoctorRelayStatus {
                    daemon_id: "d1".into(),
                    relay_url: "wss://r".into(),
                    connected: true,
                    peer_count: 2
                }]
            }
        );
        // a relay row missing peerCount → reject the whole frame.
        assert!(parse_ipc_message(&json!({
            "t": "doctor.probe.ok",
            "relays": [{"daemonId": "d", "relayUrl": "r", "connected": false}]
        }))
        .is_none());
    }

    #[test]
    fn resize_terminal_dimension_cap() {
        // cols=65535 (MAX_TERMINAL_DIMENSION) → accepted.
        assert!(parse_ipc_message(&json!({
            "t": "resize", "sid": "s", "cols": 65535, "rows": 24
        }))
        .is_some());

        // cols=65536 → rejected (truncates to 0 in kernel uint16 ws_col).
        assert!(parse_ipc_message(&json!({
            "t": "resize", "sid": "s", "cols": 65536, "rows": 24
        }))
        .is_none());

        // rows=65536 → rejected.
        assert!(parse_ipc_message(&json!({
            "t": "resize", "sid": "s", "cols": 80, "rows": 65536
        }))
        .is_none());

        // cols=0 → rejected (is_positive_int: must be > 0; existing behavior preserved).
        assert!(parse_ipc_message(&json!({
            "t": "resize", "sid": "s", "cols": 0, "rows": 24
        }))
        .is_none());
    }

    #[test]
    fn unknown_discriminant_is_none() {
        assert!(parse_ipc_message(&json!({"t": "nope"})).is_none());
        assert!(parse_ipc_message(&json!({"sid": "s"})).is_none());
        assert!(parse_ipc_message(&json!(7)).is_none());
    }
}
