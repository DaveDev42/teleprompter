//! Push notification fan-out — port of
//! `packages/daemon/src/push/push-notifier.ts` (327 LOC).
//!
//! Maps Claude Code hook events (`Notification` / `PermissionRequest` /
//! `Elicitation`) to APNs push copy + interruption level, and fans out to
//! every registered sealed token. The daemon never unwraps a sealed token —
//! it treats it as an opaque relay blob (`"tpps1.<v>.<b64>"` or a legacy
//! plaintext token for back-compat).
//!
//! # Invariants preserved from `push-notifier.ts` (verify each against the
//! TS source)
//!
//! - **`NOTIFY_EVENTS` gate** (push-notifier.ts:181-183): `onRecord` is a
//!   no-op unless `rec.kind == Event` AND `rec.name` is one of
//!   `{Notification, PermissionRequest, Elicitation}`. Pinning Bun test:
//!   `push-notifier.test.ts` "onRecord ignores non-notify events".
//! - **`tokenCount == 0` gate** (push-notifier.ts:187): even a notify-eligible
//!   event is a no-op (after logging) when there are zero registered tokens
//!   — never builds a push message or calls `sendPush` for nobody. Pinning
//!   Bun test: `push-notifier.test.ts` "onRecord no-ops with zero tokens".
//! - **code-point-safe truncation** (push-notifier.ts `truncate`): must
//!   split on Unicode scalar values, not UTF-16 code units / raw bytes, so a
//!   supplementary-plane character (emoji, flag) at the truncation boundary
//!   is never cut in half.

use std::collections::HashMap;

use tp_proto::ipc::RecordKind;
use tp_proto::relay_client::InterruptionLevel;

/// Hook events that trigger a push notification. Mirrors `NOTIFY_EVENTS`
/// (push-notifier.ts:27-31).
const NOTIFY_EVENTS: &[&str] = &["Notification", "PermissionRequest", "Elicitation"];

/// Whether a hook event name is in the notify set — the first half of the
/// `on_record` gate (the second half is `token_count > 0`). Pure — mirrors the
/// `NOTIFY_EVENTS.has(rec.name)` check (push-notifier.ts:224). Exposed so the
/// probe binary can drive the push-gate differential parity test without
/// duplicating the event list.
#[must_use]
pub fn is_notify_event(event_name: &str) -> bool {
    NOTIFY_EVENTS.contains(&event_name)
}

/// Hook events that warrant `time-sensitive` APNs delivery (breaks through
/// Focus/DND). Mirrors `TIME_SENSITIVE_EVENTS` (push-notifier.ts:49-53) —
/// currently identical to `NOTIFY_EVENTS`, kept as a separate list so a
/// future informational NOTIFY_EVENT can opt out of time-sensitive delivery
/// without touching the notify gate.
const TIME_SENSITIVE_EVENTS: &[&str] = &["Notification", "PermissionRequest", "Elicitation"];

/// Map a hook event name to the iOS interruption level its push should
/// carry. Pure — mirrors `interruptionLevelFor` (push-notifier.ts:60-62).
#[must_use]
pub fn interruption_level_for(event_name: &str) -> InterruptionLevel {
    if TIME_SENSITIVE_EVENTS.contains(&event_name) {
        InterruptionLevel::TimeSensitive
    } else {
        InterruptionLevel::Active
    }
}

/// Push notification copy (title + body). Mirrors the TS `PushMessage`
/// interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushMessage {
    pub title: String,
    pub body: String,
}

/// The subset of a Record's fields `PushNotifier::on_record` needs. Mirrors
/// the TS `RecordInfo` interface — deliberately narrower than the full
/// Record/Envelope type so this module doesn't need to depend on the wider
/// wire-record type.
pub struct RecordInfo<'a> {
    pub sid: &'a str,
    pub kind: RecordKind,
    pub name: Option<&'a str>,
    /// Decoded JSON payload of the hook event, if any.
    pub payload: Option<&'a serde_json::Value>,
}

/// Everything `PushNotifier` needs from the daemon's relay + store layers.
/// A trait (rather than concrete `RelayConnectionManager`/`Store`
/// references) matches the TS `PushNotifierDeps` interface and keeps this
/// module unit-testable with a fake.
pub trait PushNotifierDeps: Send + Sync {
    /// Send (or queue) a push notification via the relay. `sealed` is the
    /// opaque relay blob — never unwrapped here.
    ///
    /// 8 args mirrors the TS `PushNotifierDeps.sendPush` call shape 1:1;
    /// bundling into a params struct would only add indirection for a
    /// trait method with a single production impl (`relay_manager.rs`'s
    /// `StorePushNotifierDeps`).
    #[allow(clippy::too_many_arguments)]
    fn send_push(
        &self,
        frontend_id: &str,
        sealed: &str,
        title: &str,
        body: &str,
        interruption_level: InterruptionLevel,
        sid: &str,
        event: &str,
        daemon_id: &str,
    );

    /// Persist a newly registered sealed token to store for daemon-restart
    /// recovery.
    fn persist_token(&self, frontend_id: &str, daemon_id: &str, sealed: &str, platform: &str);

    /// Load all persisted sealed tokens on startup.
    fn load_tokens(&self) -> Vec<PersistedToken>;

    /// Delete a persisted token (e.g. on unseal failure or unregister).
    fn delete_token(&self, frontend_id: &str);
}

/// A persisted token row, as returned by `PushNotifierDeps::load_tokens`.
pub struct PersistedToken {
    pub frontend_id: String,
    pub daemon_id: String,
    pub sealed: String,
    pub platform: String,
}

/// In-memory token entry. The daemon never stores plaintext tokens — only
/// the opaque sealed blob.
struct TokenEntry {
    sealed: String,
    #[allow(dead_code)] // parity field: TS keeps `platform` on the entry too, unread today
    platform: String,
    daemon_id: String,
}

/// Fans out push notifications for notify-eligible hook events to every
/// registered frontend token. Mirrors the TS `PushNotifier` class.
pub struct PushNotifier<D: PushNotifierDeps> {
    tokens: HashMap<String, TokenEntry>,
    deps: D,
}

impl<D: PushNotifierDeps> PushNotifier<D> {
    /// Construct a new notifier, seeding `tokens` from `deps.load_tokens()`
    /// (daemon-restart recovery). Mirrors the TS constructor
    /// (push-notifier.ts:132-146).
    pub fn new(deps: D) -> Self {
        let mut tokens = HashMap::new();
        for t in deps.load_tokens() {
            tokens.insert(
                t.frontend_id,
                TokenEntry {
                    sealed: t.sealed,
                    platform: t.platform,
                    daemon_id: t.daemon_id,
                },
            );
        }
        PushNotifier { tokens, deps }
    }

    /// Register a sealed push token for a frontend — updates the in-memory
    /// map AND persists via `deps.persist_token`. Mirrors
    /// `registerSealedToken` (push-notifier.ts:154-164).
    pub fn register_sealed_token(
        &mut self,
        frontend_id: &str,
        daemon_id: &str,
        sealed: &str,
        platform: &str,
    ) {
        self.tokens.insert(
            frontend_id.to_string(),
            TokenEntry {
                sealed: sealed.to_string(),
                platform: platform.to_string(),
                daemon_id: daemon_id.to_string(),
            },
        );
        self.deps
            .persist_token(frontend_id, daemon_id, sealed, platform);
    }

    /// Mirrors `unregisterToken` (push-notifier.ts:166-169).
    pub fn unregister_token(&mut self, frontend_id: &str) {
        self.tokens.remove(frontend_id);
        self.deps.delete_token(frontend_id);
    }

    /// Called on `PUSH_UNSEAL_FAILED` for a given frontend — drops the stale
    /// entry so future events don't keep sending to a dead token. Mirrors
    /// `handleUnsealFailed` (push-notifier.ts:177-187).
    pub fn handle_unseal_failed(&mut self, frontend_id: &str) {
        if !self.tokens.contains_key(frontend_id) {
            return;
        }
        self.tokens.remove(frontend_id);
        self.deps.delete_token(frontend_id);
    }

    /// Called on `PUSH_TOKEN_DEAD` (APNs 400/410) for a given frontend —
    /// drops the single stale entry. Mirrors `handleTokenDead`
    /// (push-notifier.ts:199-211).
    pub fn handle_token_dead(&mut self, frontend_id: &str) {
        if !self.tokens.contains_key(frontend_id) {
            return;
        }
        self.tokens.remove(frontend_id);
        self.deps.delete_token(frontend_id);
    }

    /// Current number of registered tokens. Exposed for the `tokenCount`
    /// gate's test coverage and for relay-manager diagnostics.
    #[must_use]
    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }

    /// Notify-eligible-event fan-out. Mirrors `onRecord`
    /// (push-notifier.ts:213-234).
    pub fn on_record(&self, rec: &RecordInfo<'_>) {
        if rec.kind != RecordKind::Event {
            return;
        }
        let Some(name) = rec.name else {
            return;
        };
        if !NOTIFY_EVENTS.contains(&name) {
            return;
        }

        // `tokenCount == 0` gate: still logged in the TS source before the
        // early return, but there is nobody to send to.
        if self.tokens.is_empty() {
            return;
        }

        let msg = build_push_message(name, rec.payload);
        let level = interruption_level_for(name);

        for (frontend_id, entry) in &self.tokens {
            self.deps.send_push(
                frontend_id,
                &entry.sealed,
                &msg.title,
                &msg.body,
                level,
                rec.sid,
                name,
                &entry.daemon_id,
            );
        }
    }
}

/// Pure helper — exposed for testing — that turns a hook event name + raw
/// payload into push notification copy. Mirrors `buildPushMessage`
/// (push-notifier.ts:266-321).
#[must_use]
pub fn build_push_message(event_name: &str, payload: Option<&serde_json::Value>) -> PushMessage {
    let get_str = |key: &str| -> Option<String> {
        payload
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };

    match event_name {
        "Notification" => {
            let message = get_str("message").unwrap_or_default();
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                let title = if regex_permission(trimmed) {
                    "Permission needed"
                } else if regex_wait_idle(trimmed) {
                    "Waiting for input"
                } else {
                    "Claude needs attention"
                };
                PushMessage {
                    title: title.to_string(),
                    body: truncate(trimmed, 178),
                }
            } else {
                PushMessage {
                    title: "Claude needs attention".to_string(),
                    body: "Tap to open the session".to_string(),
                }
            }
        }
        "PermissionRequest" => {
            let tool = get_str("tool_name");
            let body = match tool {
                Some(t) => format!("Approve {} to continue", truncate(&t, 160)),
                None => "Tool permission approval required".to_string(),
            };
            PushMessage {
                title: "Permission needed".to_string(),
                body,
            }
        }
        "Elicitation" => {
            let question = get_str("message")
                .or_else(|| get_str("question"))
                .unwrap_or_default();
            let trimmed = question.trim();
            let body = if !trimmed.is_empty() {
                truncate(trimmed, 178)
            } else {
                "Claude is waiting for your answer".to_string()
            };
            PushMessage {
                title: "Response needed".to_string(),
                body,
            }
        }
        _ => PushMessage {
            title: "Claude needs attention".to_string(),
            body: "Tap to open the session".to_string(),
        },
    }
}

/// Case-insensitive substring match for `/permission/i` (push-notifier.ts:294).
fn regex_permission(s: &str) -> bool {
    s.to_lowercase().contains("permission")
}

/// Case-insensitive substring match for `/wait|idle/i` (push-notifier.ts:296).
fn regex_wait_idle(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.contains("wait") || lower.contains("idle")
}

/// Code-point-safe truncation — mirrors `truncate` (push-notifier.ts:323-330).
/// Splits on Unicode scalar values (`char`), not UTF-16 code units or raw
/// bytes, so a supplementary-plane character at the boundary is never cut in
/// half.
fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut out: String = chars[..keep].iter().collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeDeps {
        sent: Mutex<Vec<(String, String, String, InterruptionLevel)>>,
        persisted: Mutex<Vec<String>>,
        deleted: Mutex<Vec<String>>,
        seed: Vec<PersistedToken>,
    }

    impl FakeDeps {
        fn new() -> Self {
            FakeDeps {
                sent: Mutex::new(vec![]),
                persisted: Mutex::new(vec![]),
                deleted: Mutex::new(vec![]),
                seed: vec![],
            }
        }
    }

    impl PushNotifierDeps for FakeDeps {
        fn send_push(
            &self,
            frontend_id: &str,
            _sealed: &str,
            title: &str,
            body: &str,
            interruption_level: InterruptionLevel,
            _sid: &str,
            _event: &str,
            _daemon_id: &str,
        ) {
            self.sent.lock().unwrap().push((
                frontend_id.to_string(),
                title.to_string(),
                body.to_string(),
                interruption_level,
            ));
        }

        fn persist_token(
            &self,
            frontend_id: &str,
            _daemon_id: &str,
            _sealed: &str,
            _platform: &str,
        ) {
            self.persisted.lock().unwrap().push(frontend_id.to_string());
        }

        fn load_tokens(&self) -> Vec<PersistedToken> {
            self.seed
                .iter()
                .map(|t| PersistedToken {
                    frontend_id: t.frontend_id.clone(),
                    daemon_id: t.daemon_id.clone(),
                    sealed: t.sealed.clone(),
                    platform: t.platform.clone(),
                })
                .collect()
        }

        fn delete_token(&self, frontend_id: &str) {
            self.deleted.lock().unwrap().push(frontend_id.to_string());
        }
    }

    #[test]
    fn notify_events_gate_ignores_non_notify_event_names() {
        // Pinning Bun test: push-notifier.test.ts "onRecord ignores
        // non-notify events" — an event outside NOTIFY_EVENTS never reaches
        // send_push even with tokens registered.
        let notifier = PushNotifier::new(FakeDeps::new());
        // (no tokens registered — but this test targets the NAME gate, not
        // the token-count gate, so it must short-circuit before checking
        // token count at all)
        let rec = RecordInfo {
            sid: "sess-1",
            kind: RecordKind::Event,
            name: Some("Stop"),
            payload: None,
        };
        notifier.on_record(&rec);
        assert!(notifier.deps.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn non_event_kind_is_ignored() {
        let notifier = PushNotifier::new(FakeDeps::new());
        let rec = RecordInfo {
            sid: "sess-1",
            kind: RecordKind::Io,
            name: Some("Notification"),
            payload: None,
        };
        notifier.on_record(&rec);
        assert!(notifier.deps.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn token_count_zero_gate_noop() {
        // Pinning Bun test: push-notifier.test.ts "onRecord no-ops with zero
        // tokens" — a notify-eligible event with zero registered tokens must
        // not call send_push (nobody to send to).
        let notifier = PushNotifier::new(FakeDeps::new());
        assert_eq!(notifier.token_count(), 0);
        let rec = RecordInfo {
            sid: "sess-1",
            kind: RecordKind::Event,
            name: Some("Notification"),
            payload: None,
        };
        notifier.on_record(&rec);
        assert!(notifier.deps.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn registered_token_receives_push_on_notify_event() {
        let mut notifier = PushNotifier::new(FakeDeps::new());
        notifier.register_sealed_token("fe-1", "daemon-1", "tpps1.v1.abc", "ios");
        assert_eq!(notifier.token_count(), 1);

        let rec = RecordInfo {
            sid: "sess-1",
            kind: RecordKind::Event,
            name: Some("Notification"),
            payload: None,
        };
        notifier.on_record(&rec);

        let sent = notifier.deps.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "fe-1");
    }

    #[test]
    fn unregister_removes_token_and_calls_delete() {
        let mut notifier = PushNotifier::new(FakeDeps::new());
        notifier.register_sealed_token("fe-1", "daemon-1", "sealed", "ios");
        notifier.unregister_token("fe-1");
        assert_eq!(notifier.token_count(), 0);
        assert_eq!(notifier.deps.deleted.lock().unwrap().as_slice(), ["fe-1"]);
    }

    #[test]
    fn handle_unseal_failed_is_noop_for_unknown_frontend() {
        let mut notifier = PushNotifier::new(FakeDeps::new());
        notifier.handle_unseal_failed("unknown-fe");
        assert!(notifier.deps.deleted.lock().unwrap().is_empty());
    }

    #[test]
    fn handle_token_dead_drops_only_the_named_frontend() {
        let mut notifier = PushNotifier::new(FakeDeps::new());
        notifier.register_sealed_token("fe-1", "daemon-1", "sealed-1", "ios");
        notifier.register_sealed_token("fe-2", "daemon-1", "sealed-2", "ios");
        notifier.handle_token_dead("fe-1");
        assert_eq!(notifier.token_count(), 1);
        assert_eq!(notifier.deps.deleted.lock().unwrap().as_slice(), ["fe-1"]);
    }

    #[test]
    fn interruption_level_matches_time_sensitive_set() {
        assert_eq!(
            interruption_level_for("Notification"),
            InterruptionLevel::TimeSensitive
        );
        assert_eq!(
            interruption_level_for("PermissionRequest"),
            InterruptionLevel::TimeSensitive
        );
        assert_eq!(
            interruption_level_for("Elicitation"),
            InterruptionLevel::TimeSensitive
        );
        assert_eq!(interruption_level_for("Stop"), InterruptionLevel::Active);
    }

    #[test]
    fn build_push_message_notification_with_permission_keyword() {
        let payload = serde_json::json!({ "message": "Claude needs your permission to use Bash" });
        let msg = build_push_message("Notification", Some(&payload));
        assert_eq!(msg.title, "Permission needed");
        assert_eq!(msg.body, "Claude needs your permission to use Bash");
    }

    #[test]
    fn build_push_message_notification_with_wait_keyword() {
        let payload = serde_json::json!({ "message": "Waiting for you to respond" });
        let msg = build_push_message("Notification", Some(&payload));
        assert_eq!(msg.title, "Waiting for input");
    }

    #[test]
    fn build_push_message_notification_generic_fallback() {
        let payload = serde_json::json!({ "message": "Something happened" });
        let msg = build_push_message("Notification", Some(&payload));
        assert_eq!(msg.title, "Claude needs attention");
    }

    #[test]
    fn build_push_message_notification_empty_message_falls_back() {
        let msg = build_push_message("Notification", None);
        assert_eq!(msg.title, "Claude needs attention");
        assert_eq!(msg.body, "Tap to open the session");
    }

    #[test]
    fn build_push_message_permission_request_with_tool_name() {
        let payload = serde_json::json!({ "tool_name": "Bash" });
        let msg = build_push_message("PermissionRequest", Some(&payload));
        assert_eq!(msg.title, "Permission needed");
        assert_eq!(msg.body, "Approve Bash to continue");
    }

    #[test]
    fn build_push_message_permission_request_without_tool_name() {
        let msg = build_push_message("PermissionRequest", None);
        assert_eq!(msg.body, "Tool permission approval required");
    }

    #[test]
    fn build_push_message_elicitation_uses_message_then_question() {
        let payload = serde_json::json!({ "question": "Pick a color" });
        let msg = build_push_message("Elicitation", Some(&payload));
        assert_eq!(msg.title, "Response needed");
        assert_eq!(msg.body, "Pick a color");
    }

    #[test]
    fn build_push_message_elicitation_empty_falls_back() {
        let msg = build_push_message("Elicitation", None);
        assert_eq!(msg.body, "Claude is waiting for your answer");
    }

    #[test]
    fn build_push_message_unknown_event_generic_fallback() {
        let msg = build_push_message("SomeUnknownEvent", None);
        assert_eq!(msg.title, "Claude needs attention");
        assert_eq!(msg.body, "Tap to open the session");
    }

    #[test]
    fn truncate_is_code_point_safe_across_surrogate_pairs() {
        // A supplementary-plane emoji (4 UTF-16 code units in JS, 1 Rust
        // `char`) must not be split — the TS source spreads the string into
        // code points precisely to avoid this. Build a string just past the
        // max with an emoji at the boundary.
        let s = format!("{}{}", "a".repeat(178), "😀"); // 179 chars total
        let out = truncate(&s, 178);
        // Must end with the ellipsis, not a mangled/lone surrogate, and must
        // not panic (byte-slicing `&s[..178]` on this string would panic —
        // the emoji is a 4-byte UTF-8 sequence straddling nothing here, but
        // char-based slicing is the load-bearing property under test).
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 178);
    }

    #[test]
    fn truncate_noop_when_under_max() {
        let s = "short string";
        assert_eq!(truncate(s, 178), s);
    }
}
