//! Relay handshake handlers — pure functions over `Registry`.
//!
//! Each function takes the parsed message fields + a `&mut Registry` reference
//! and returns a `RelayServerMessage` to send back.  No I/O, no async, no
//! WebSocket handles.  The caller (Step 4+ axum/tungstenite layer) is
//! responsible for the actual wire emission and closing connections.
//!
//! ## Coverage
//!
//! * `handle_register`    — `relay.register` (daemon self-register, proof-based)
//! * `handle_auth`        — `relay.auth` (full auth, issues a resume token)
//! * `handle_auth_resume` — `relay.auth.resume` (HMAC fast-path reconnect)
//! * `handle_hello`       — `relay.hello` (proposed merged register+auth, ADR
//!   A1.3 #4) — **NOT wired into the Step-4 hot path** (see below)
//!
//! ## Version gating
//!
//! The TS relay currently does **not** gate on the `v` field value (the field is
//! parsed but ignored at the handler level — see Handshake Survey, "Version
//! field" section).  This port follows the same behaviour for `handle_register`,
//! `handle_auth`, and `handle_auth_resume`.
//!
//! ## `handle_hello` is not yet wired (out of Step-4 scope)
//!
//! `handle_hello` (+ its `v >= 2` gate and [`VERSION_MISMATCH_COUNT`]) is a
//! proposed v2-only message that **has no `RelayClientMessage::Hello` variant**
//! in `tp_proto::relay_client` and **no `dispatch_locked` arm** in `conn.rs`.
//! The wire parser (`parse_relay_client_message`) therefore can never produce a
//! `relay.hello` message — a client sending one is rejected one layer earlier as
//! `UNKNOWN_TYPE`.  As a consequence **`VERSION_MISMATCH_COUNT` is never
//! incremented by a live socket** and [`version_mismatch_count`] returns 0 in
//! production.  This matches the TS reference, which also has no `relay.hello`
//! handler.  The handler + counter are kept (with unit-test coverage) for the
//! future ADR A1.3 #4 wiring, but **Step-6 `/metrics` MUST NOT treat this
//! counter as populated** until a `Hello` variant + dispatch arm land.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::messages::{AuthErr, AuthOk, RegisterErr, RegisterOk, RelayServerMessage};
use crate::registry::Registry;
use crate::resume_token::{ResumePayload, ResumeTokenSigner};

/// Global counter for `relay.hello` messages rejected due to `v < 2`.
///
/// **Not populated in production.** `relay.hello` has no wire parser / dispatch
/// arm in Step 4 (no `RelayClientMessage::Hello` variant), so [`handle_hello`]
/// is only reachable from unit tests — a live socket can never increment this.
/// See the module-level "`handle_hello` is not yet wired" note. Step-6
/// `/metrics` must not assume this is non-zero until `relay.hello` is wired.
pub static VERSION_MISMATCH_COUNT: AtomicU64 = AtomicU64::new(0);

/// Return the current version-mismatch counter value.
pub fn version_mismatch_count() -> u64 {
    VERSION_MISMATCH_COUNT.load(Ordering::Relaxed)
}

// ── handle_register ───────────────────────────────────────────────────────────

/// Process `relay.register` from a daemon.
///
/// Performs the different-credentials guard, stale-token cleanup, and state
/// mutation.  Returns `relay.register.ok` on success or `relay.register.err` on
/// the credentials-conflict reject path.
///
/// Does NOT issue a resume token (that only happens on auth).
///
/// Mirrors `relay-server.ts:760–804`.
pub fn handle_register(
    daemon_id: &str,
    token: &str,
    proof: &str,
    now_ms: u64,
    registry: &mut Registry,
) -> RelayServerMessage {
    match registry.handle_register(daemon_id, token, proof, now_ms) {
        Ok(()) => RelayServerMessage::RegisterOk(RegisterOk {
            daemon_id: daemon_id.to_string(),
        }),
        Err(reason) => RelayServerMessage::RegisterErr(RegisterErr {
            e: reason.to_string(),
        }),
    }
}

// ── handle_auth ───────────────────────────────────────────────────────────────

/// Process `relay.auth` from daemon or frontend.
///
/// Validates the token, upserts daemon state, and issues a fresh resume token.
/// Returns `relay.auth.ok { resumeToken, resumeExpiresAt, resumed: false }` on
/// success or `relay.auth.err` on failure.
///
/// The caller must have already validated that `role == "frontend"` implies
/// `frontendId` is present and non-empty (the TS guard at line 825–831 handles
/// this; replicate that check before calling here).
///
/// Mirrors `relay-server.ts:806–877`.
pub fn handle_auth(
    daemon_id: &str,
    token: &str,
    is_daemon: bool,
    frontend_id: Option<&str>,
    now_ms: u64,
    registry: &mut Registry,
    signer: &ResumeTokenSigner,
) -> RelayServerMessage {
    // frontendId required for frontend role (relay-server.ts:825–831).
    if !is_daemon {
        match frontend_id {
            None | Some("") => {
                return RelayServerMessage::AuthErr(AuthErr {
                    e: "frontendId is required for role=frontend".to_string(),
                });
            }
            _ => {}
        }
    }

    match registry.handle_auth(daemon_id, token, is_daemon, now_ms) {
        Ok(()) => {
            let resume_payload = build_resume_payload(daemon_id, is_daemon, frontend_id);
            let (resume_token, expires_at) = signer.issue(&resume_payload, now_ms, None);
            RelayServerMessage::AuthOk(AuthOk {
                daemon_id: daemon_id.to_string(),
                resume_token: Some(resume_token),
                resume_expires_at: Some(expires_at as f64),
                resumed: Some(false),
            })
        }
        Err(reason) => RelayServerMessage::AuthErr(AuthErr {
            e: reason.to_string(),
        }),
    }
}

// ── handle_auth_resume ────────────────────────────────────────────────────────

/// Process `relay.auth.resume` fast-path reconnect.
///
/// Verifies the HMAC token, checks daemon still registered, upserts state.
/// Returns `relay.auth.ok { resumed: true }` or `relay.auth.err`.
///
/// Mirrors `relay-server.ts:885–956`.
pub fn handle_auth_resume(
    token: &str,
    now_ms: u64,
    registry: &mut Registry,
    signer: &ResumeTokenSigner,
) -> RelayServerMessage {
    // 1. HMAC verification + TTL.
    let payload = match signer.verify(token, now_ms) {
        Some(p) => p,
        None => {
            return RelayServerMessage::AuthErr(AuthErr {
                e: "Resume token invalid or expired".to_string(),
            });
        }
    };

    let daemon_id = payload.daemon_id().to_string();
    let is_daemon = matches!(payload, ResumePayload::Daemon { .. });
    let frontend_id: Option<String> = match &payload {
        ResumePayload::Frontend { frontend_id, .. } => Some(frontend_id.clone()),
        ResumePayload::Daemon { .. } => None,
    };

    // 2. Daemon still registered? (relay-server.ts:900–917)
    match registry.handle_auth_resume(&daemon_id, is_daemon, now_ms) {
        Ok(()) => {}
        Err(reason) => {
            return RelayServerMessage::AuthErr(AuthErr {
                e: reason.to_string(),
            });
        }
    }

    // 3. Issue a fresh resume token (relay-server.ts:947–948).
    let effective_payload =
        build_resume_payload_from_strings(&daemon_id, is_daemon, frontend_id.as_deref());
    let (new_token, new_expires) = signer.issue(&effective_payload, now_ms, None);

    RelayServerMessage::AuthOk(AuthOk {
        daemon_id,
        resume_token: Some(new_token),
        resume_expires_at: Some(new_expires as f64),
        resumed: Some(true),
    })
}

// ── handle_hello (ADR A1.3 #4 — register+auth merged) ────────────────────────

/// Process the new `relay.hello` message — a single-RTT merge of
/// `relay.register` (optional) + `relay.auth`.
///
/// Wire shape (subset of relevant fields):
/// ```json
/// { "t": "relay.hello", "daemonId": "...", "token": "...",
///   "proof": "...",        // optional — present → run register branch
///   "role": "daemon",      // or "frontend"
///   "v": 2,                // MUST be >= 2; lower → relay.auth.err
///   "frontendId": "..."    // required for frontend role
/// }
/// ```
///
/// Sequence:
/// 1. Reject `v < 2` with `relay.auth.err`; increment `VERSION_MISMATCH_COUNT`.
/// 2. If `proof` is `Some(_)`: run the register branch (different-credentials
///    guard, stale-token cleanup, `valid_tokens`/`registrations` mutation).
/// 3. Validate `valid_tokens[token] == daemonId`.
/// 4. Issue resume token, emit `relay.auth.ok { resumed: false }`.
///
/// The proof-sentinel invariant is preserved exactly: `proof` is `Option<String>`
/// at the call site — `None` = "no proof field on wire", `Some(s)` = explicit
/// proof string (even if `s == ""`).
///
/// Mirrors the ADR A1.3 #4 design in the Handshake Survey.
#[allow(clippy::too_many_arguments)]
pub fn handle_hello(
    daemon_id: &str,
    token: &str,
    proof: Option<&str>, // None = proof field absent; Some("") = explicit empty proof
    is_daemon: bool,
    frontend_id: Option<&str>,
    v: f64,
    now_ms: u64,
    registry: &mut Registry,
    signer: &ResumeTokenSigner,
) -> RelayServerMessage {
    // 1. Version gate — relay.hello is v2+ only.
    if v < 2.0 {
        VERSION_MISMATCH_COUNT.fetch_add(1, Ordering::Relaxed);
        return RelayServerMessage::AuthErr(AuthErr {
            e: format!("relay.hello requires v>=2 (got {v})"),
        });
    }

    // 2. frontendId required for frontend role.
    if !is_daemon {
        match frontend_id {
            None | Some("") => {
                return RelayServerMessage::AuthErr(AuthErr {
                    e: "frontendId is required for role=frontend".to_string(),
                });
            }
            _ => {}
        }
    }

    // 3. Register branch (only when proof field is present on the wire).
    if let Some(proof_str) = proof {
        // The different-credentials guard, stale-token cleanup, and mutations
        // are all inside registry.handle_register.
        if let Err(reason) = registry.handle_register(daemon_id, token, proof_str, now_ms) {
            return RelayServerMessage::AuthErr(AuthErr {
                e: reason.to_string(),
            });
        }
    }

    // 4. Auth branch — validate token.
    match registry.handle_auth(daemon_id, token, is_daemon, now_ms) {
        Ok(()) => {}
        Err(reason) => {
            return RelayServerMessage::AuthErr(AuthErr {
                e: reason.to_string(),
            });
        }
    }

    // 5. Issue resume token, emit auth.ok.
    let resume_payload = build_resume_payload(daemon_id, is_daemon, frontend_id);
    let (resume_token, expires_at) = signer.issue(&resume_payload, now_ms, None);

    RelayServerMessage::AuthOk(AuthOk {
        daemon_id: daemon_id.to_string(),
        resume_token: Some(resume_token),
        resume_expires_at: Some(expires_at as f64),
        resumed: Some(false),
    })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn build_resume_payload(
    daemon_id: &str,
    is_daemon: bool,
    frontend_id: Option<&str>,
) -> ResumePayload {
    if is_daemon {
        ResumePayload::Daemon {
            daemon_id: daemon_id.to_string(),
            expires_at: 0, // overridden by signer.issue()
        }
    } else {
        ResumePayload::Frontend {
            daemon_id: daemon_id.to_string(),
            frontend_id: frontend_id.unwrap_or("").to_string(),
            expires_at: 0,
        }
    }
}

fn build_resume_payload_from_strings(
    daemon_id: &str,
    is_daemon: bool,
    frontend_id: Option<&str>,
) -> ResumePayload {
    build_resume_payload(daemon_id, is_daemon, frontend_id)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::RelayServerMessage;
    use crate::registry::Registry;
    use crate::resume_token::ResumeTokenSigner;

    fn test_signer() -> ResumeTokenSigner {
        ResumeTokenSigner::new(Some(&[b't'; 32]), Some(3_600_000))
    }

    fn seeded_registry(daemon_id: &str, token: &str) -> Registry {
        let mut r = Registry::new();
        r.valid_tokens
            .insert(token.to_string(), daemon_id.to_string());
        r
    }

    // ── handle_register ───────────────────────────────────────────────────────

    #[test]
    fn register_ok_returns_register_ok() {
        let mut r = seeded_registry("d1", "tok");
        let msg = handle_register("d1", "tok", "proof-xyz", 0, &mut r);
        assert!(matches!(msg, RelayServerMessage::RegisterOk(_)));
        if let RelayServerMessage::RegisterOk(ok) = msg {
            assert_eq!(ok.daemon_id, "d1");
        }
    }

    #[test]
    fn register_different_credentials_returns_err() {
        let mut r = seeded_registry("d1", "tok");
        // First register.
        handle_register("d1", "tok", "proof-a", 0, &mut r);
        // Same daemonId, different proof → relay.register.err.
        let msg = handle_register("d1", "tok", "proof-b", 0, &mut r);
        assert!(matches!(msg, RelayServerMessage::RegisterErr(_)));
    }

    #[test]
    fn register_none_proof_does_not_block_subsequent_register() {
        let mut r = seeded_registry("d1", "tok");
        // Seed with proof=None (auth-only seeded registration).
        r.registrations.insert(
            "d1".to_string(),
            crate::registry::Registration {
                token: "tok".to_string(),
                proof: None,
            },
        );
        // Subsequent register with any proof must succeed.
        let msg = handle_register("d1", "tok", "new-proof", 0, &mut r);
        assert!(matches!(msg, RelayServerMessage::RegisterOk(_)));
    }

    // ── handle_auth ───────────────────────────────────────────────────────────

    #[test]
    fn auth_daemon_ok_issues_resume_token() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let msg = handle_auth("d1", "tok", true, None, 0, &mut r, &s);
        match msg {
            RelayServerMessage::AuthOk(ok) => {
                assert_eq!(ok.daemon_id, "d1");
                assert!(ok.resume_token.is_some(), "resume token must be issued");
                assert_eq!(ok.resumed, Some(false));
            }
            _ => panic!("expected relay.auth.ok"),
        }
    }

    #[test]
    fn auth_frontend_requires_frontend_id() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        // Missing frontendId → relay.auth.err.
        let msg = handle_auth("d1", "tok", false, None, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
        // Empty frontendId → relay.auth.err.
        let msg = handle_auth("d1", "tok", false, Some(""), 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
    }

    #[test]
    fn auth_frontend_ok_with_frontend_id() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let msg = handle_auth("d1", "tok", false, Some("fe-1"), 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthOk(_)));
    }

    #[test]
    fn auth_invalid_token_returns_err() {
        let mut r = Registry::new(); // no valid_tokens entries
        let s = test_signer();
        let msg = handle_auth("d1", "bad-tok", true, None, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
    }

    // ── handle_auth_resume ────────────────────────────────────────────────────

    #[test]
    fn auth_resume_ok_returns_resumed_true() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        // Full auth first.
        handle_auth("d1", "tok", true, None, 0, &mut r, &s);
        // Extract the resume token from the auth.ok response.
        let auth_msg = handle_auth("d1", "tok", true, None, 0, &mut r, &s);
        let resume_token = if let RelayServerMessage::AuthOk(ok) = auth_msg {
            ok.resume_token.unwrap()
        } else {
            panic!("expected auth.ok")
        };

        // Resume with the token.
        let msg = handle_auth_resume(&resume_token, 1, &mut r, &s);
        match msg {
            RelayServerMessage::AuthOk(ok) => {
                assert_eq!(ok.daemon_id, "d1");
                assert_eq!(ok.resumed, Some(true));
                assert!(
                    ok.resume_token.is_some(),
                    "fresh token must be issued on resume"
                );
            }
            _ => panic!("expected relay.auth.ok with resumed=true"),
        }
    }

    #[test]
    fn auth_resume_invalid_token_returns_err() {
        let mut r = Registry::new();
        let s = test_signer();
        let msg = handle_auth_resume("bad.token", 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
    }

    #[test]
    fn auth_resume_evicted_daemon_returns_err() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        handle_auth("d1", "tok", true, None, 0, &mut r, &s);

        let auth_msg = handle_auth("d1", "tok", true, None, 0, &mut r, &s);
        let resume_token = if let RelayServerMessage::AuthOk(ok) = auth_msg {
            ok.resume_token.unwrap()
        } else {
            panic!("expected auth.ok")
        };

        // Evict the daemon.
        r.evict_daemon("d1");

        // Resume should fail: daemon no longer registered.
        let msg = handle_auth_resume(&resume_token, 1, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
        if let RelayServerMessage::AuthErr(e) = msg {
            assert!(
                e.e.contains("no longer registered"),
                "error message should mention 'no longer registered'"
            );
        }
    }

    // ── handle_hello ──────────────────────────────────────────────────────────

    #[test]
    fn hello_v2_daemon_with_proof_ok() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let msg = handle_hello("d1", "tok", Some("proof"), true, None, 2.0, 0, &mut r, &s);
        match msg {
            RelayServerMessage::AuthOk(ok) => {
                assert_eq!(ok.daemon_id, "d1");
                assert_eq!(ok.resumed, Some(false));
                assert!(ok.resume_token.is_some());
            }
            _ => panic!("expected auth.ok, got {msg:?}"),
        }
        // Registration must record the proof.
        let reg = r.registrations.get("d1").unwrap();
        assert_eq!(reg.proof, Some("proof".to_string()));
    }

    #[test]
    fn hello_v2_daemon_without_proof_ok() {
        // No proof field — auth-only path.
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let msg = handle_hello("d1", "tok", None, true, None, 2.0, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthOk(_)));
    }

    #[test]
    fn hello_v2_frontend_ok() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let msg = handle_hello("d1", "tok", None, false, Some("fe-1"), 2.0, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthOk(_)));
    }

    #[test]
    fn hello_v1_rejected_increments_counter() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let before = version_mismatch_count();
        let msg = handle_hello("d1", "tok", None, true, None, 1.0, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
        assert_eq!(version_mismatch_count(), before + 1);
    }

    #[test]
    fn hello_frontend_missing_frontend_id_returns_err() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        // Missing frontendId for frontend role.
        let msg = handle_hello("d1", "tok", None, false, None, 2.0, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
    }

    #[test]
    fn hello_different_credentials_returns_err() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        // First hello registers proof-a.
        handle_hello("d1", "tok", Some("proof-a"), true, None, 2.0, 0, &mut r, &s);
        // Second hello with different proof must fail.
        let msg = handle_hello("d1", "tok", Some("proof-b"), true, None, 2.0, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
    }

    #[test]
    fn hello_proof_none_sentinel_allows_subsequent_register() {
        // Auth-only seeded registration (proof=None) must not block a subsequent
        // hello with any proof value — the proof-sentinel invariant.
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        // Seed via auth (no register).
        handle_auth("d1", "tok", true, None, 0, &mut r, &s);
        // registrations now has proof=None.
        assert_eq!(r.registrations.get("d1").unwrap().proof, None);

        // hello with any proof must succeed.
        let msg = handle_hello(
            "d1",
            "tok",
            Some("new-proof"),
            true,
            None,
            2.0,
            0,
            &mut r,
            &s,
        );
        assert!(
            matches!(msg, RelayServerMessage::AuthOk(_)),
            "proof=None sentinel must allow subsequent register; got {msg:?}"
        );
    }

    // ── version gate: v==2.0 exactly is accepted ──────────────────────────────

    #[test]
    fn hello_exactly_v2_accepted() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        let msg = handle_hello("d1", "tok", None, true, None, 2.0, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthOk(_)));
    }

    // ── v==1.9 is below 2.0 and must be rejected ──────────────────────────────

    #[test]
    fn hello_v1_9_rejected() {
        let mut r = seeded_registry("d1", "tok");
        let s = test_signer();
        // Only assert the response type here; the counter increment is already
        // verified by hello_v1_rejected_increments_counter.  Checking
        // version_mismatch_count() == before+1 here would be a race when both
        // tests run in parallel (the shared AtomicU64 can be incremented by
        // the other test between load and assert).
        let msg = handle_hello("d1", "tok", None, true, None, 1.9, 0, &mut r, &s);
        assert!(matches!(msg, RelayServerMessage::AuthErr(_)));
    }
}
