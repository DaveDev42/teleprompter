//! `--emit-push-notification` (TP_E2E_PUSH=1): inject a synthetic
//! `Notification` hook event over IPC so the daemon's PushNotifier dispatches a
//! push to the live app (in-band `relay.notification` → the app's
//! `TP_PUSH_NOTIFY_RECEIVED` marker). No real APNs involved.
//!
//! Preconditions handled here:
//!   - the session DB must exist (the daemon's `handle_rec` rejects an unknown
//!     sid) → poll `session_db_ready` up to 60 s.
//!   - the app must have registered its synthetic push token
//!     (`--tp-push-smoke`) so the daemon's `tokenCount > 0` gate is open. There
//!     is no holder-visible signal for that, so the event is RE-SENT on a
//!     bounded loop (8 × @3 s): an injection landing before the token registers
//!     simply no-ops, and a later re-send succeeds. Each re-send is cheap and
//!     idempotent; `assert_push_e2e` polls the marker independently.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::json;

use crate::db::session_db_ready;
use crate::envcfg::env_nonempty;
use crate::ipc::IpcWriter;
use crate::out::log;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

pub fn emit_push_notification(sid: &str, writer: &IpcWriter) {
    // Wait for the session DB so the daemon will accept the rec.
    let db_deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < db_deadline && !session_db_ready(sid) {
        std::thread::sleep(Duration::from_millis(500));
    }
    if !session_db_ready(sid) {
        log(&format!(
            "push: session DB {sid} never appeared — skipping push injection"
        ));
        return;
    }

    let message = env_nonempty("TP_E2E_PUSH_MESSAGE")
        .unwrap_or_else(|| "QA push smoke — Claude needs you".to_string());
    let payload = BASE64_STANDARD.encode(json!({ "message": message }).to_string());

    for attempt in 1..=8u32 {
        // Hand-built JSON (not the typed `IpcMessage::Rec`) so `ts` serializes
        // as an integer millisecond timestamp, matching the Bun holder's
        // `Date.now()` — the typed variant's f64 would emit a trailing `.0`.
        let rec = json!({
            "t": "rec",
            "sid": sid,
            "kind": "event",
            "name": "Notification",
            "payload": payload.as_str(),
            "ts": now_ms(),
        });
        if let Err(err) = writer.send_value(&rec) {
            log(&format!("push: emitPushNotification failed: {err}"));
            return;
        }
        log(&format!(
            "push: injected synthetic Notification event (sid={sid}, attempt {attempt})"
        ));
        std::thread::sleep(Duration::from_millis(3_000));
    }
    log("push: finished injecting Notification events");
}
