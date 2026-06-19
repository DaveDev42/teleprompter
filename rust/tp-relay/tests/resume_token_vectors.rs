//! Self-contained golden vectors for the relay-internal binary resume token.
//!
//! ## Why this fixture lives here (not in message-vectors.json)
//!
//! `rust/tp-proto/tests/fixtures/message-vectors.json` is a cross-implementation
//! parity fixture — it tracks the TS↔Rust wire format for `RelayServerMessage`.
//! The resume token uses a **different** binary layout (BLAKE2b, binary 5-part
//! payload) that is wire-opaque to other implementations (ADR A1.3 #2). Tokens
//! are issued and verified by the same `ResumeTokenSigner` instance; no
//! cross-implementation byte-compatibility is required.  Therefore the vectors
//! are self-contained here: every case uses a FIXED secret + FIXED expiry so
//! the expected round-trip results are deterministic across machines and CI runs.
//!
//! ## Cases covered
//!
//! 1. `daemon_roundtrip`        — daemon-role token issue → verify → payload match
//! 2. `frontend_roundtrip`      — frontend-role token issue → verify → payload match
//! 3. `expired_reject`          — valid token rejected when `now >= expires_at`
//! 4. `tampered_mac_reject`     — single-byte flip in MAC half → rejected
//! 5. `wrong_version_reject`    — version byte ≠ 2 → rejected even with valid MAC
//! 6. `empty_daemon_id_reject`  — daemon-role with `daemon_id == ""` → rejected
//! 7. `empty_frontend_id_reject`— frontend-role with `frontend_id == ""` → rejected
//! 8. `cross_role_reject`       — daemon token decoded as frontend-role header → rejected
//!
//! Cases 1–2 are round-trip assertions (issue → verify returns expected payload).
//! Cases 3–8 are rejection assertions (verify returns `None`).

use tp_relay::resume_token::{ResumePayload, ResumeTokenSigner};

// ── Shared test fixtures ──────────────────────────────────────────────────────

/// A fixed 32-byte BLAKE2b key — deterministic across all test runs.
const FIXED_KEY: [u8; 32] = *b"teleprompter-relay-test-key-2026";

/// A far-future expiry (year 2286 in epoch-ms) so tokens are never "expired"
/// during the round-trip phase of these tests.
const FAR_FUTURE_EXPIRES_AT: u64 = 9_999_999_999_999u64;

/// A "now" value that is well before `FAR_FUTURE_EXPIRES_AT`.
const NOW_MS: u64 = 1_750_000_000_000u64; // ~June 2025 in epoch-ms

fn signer() -> ResumeTokenSigner {
    ResumeTokenSigner::new(Some(&FIXED_KEY), None)
}

// ── Vector 1: daemon round-trip ───────────────────────────────────────────────

/// A daemon-role resume token must round-trip through issue→verify and return
/// exactly the same `ResumePayload::Daemon` value that was issued.
#[test]
fn daemon_roundtrip() {
    let s = signer();

    let payload = ResumePayload::Daemon {
        daemon_id: "daemon-golden-01".to_string(),
        expires_at: FAR_FUTURE_EXPIRES_AT,
    };

    let (token, expires) = s.issue(&payload, NOW_MS, Some(FAR_FUTURE_EXPIRES_AT));

    // The returned expiry must match the override we passed.
    assert_eq!(
        expires, FAR_FUTURE_EXPIRES_AT,
        "issued expiry must match override"
    );

    // Token string must be non-empty and contain exactly one dot.
    assert!(!token.is_empty(), "token must be non-empty");
    assert_eq!(
        token.chars().filter(|&c| c == '.').count(),
        1,
        "token must have exactly one dot"
    );

    // Round-trip verify must succeed and return the original payload.
    let result = s
        .verify(&token, NOW_MS)
        .expect("daemon round-trip must verify successfully");

    assert!(
        matches!(result, ResumePayload::Daemon { .. }),
        "result must be Daemon variant"
    );
    assert_eq!(result.daemon_id(), "daemon-golden-01");
    assert_eq!(result.expires_at(), FAR_FUTURE_EXPIRES_AT);
}

// ── Vector 2: frontend round-trip ────────────────────────────────────────────

/// A frontend-role resume token must round-trip and return a matching
/// `ResumePayload::Frontend` value including `frontend_id`.
#[test]
fn frontend_roundtrip() {
    let s = signer();

    let payload = ResumePayload::Frontend {
        daemon_id: "daemon-golden-02".to_string(),
        frontend_id: "frontend-golden-02".to_string(),
        expires_at: FAR_FUTURE_EXPIRES_AT,
    };

    let (token, expires) = s.issue(&payload, NOW_MS, Some(FAR_FUTURE_EXPIRES_AT));

    assert_eq!(
        expires, FAR_FUTURE_EXPIRES_AT,
        "issued expiry must match override"
    );

    let result = s
        .verify(&token, NOW_MS)
        .expect("frontend round-trip must verify successfully");

    match result {
        ResumePayload::Frontend {
            daemon_id,
            frontend_id,
            expires_at,
        } => {
            assert_eq!(daemon_id, "daemon-golden-02");
            assert_eq!(frontend_id, "frontend-golden-02");
            assert_eq!(expires_at, FAR_FUTURE_EXPIRES_AT);
        }
        _ => panic!("result must be Frontend variant"),
    }
}

// ── Vector 3: expired token rejected ─────────────────────────────────────────

/// A token is rejected when `now_ms >= expires_at` (strict less-than required).
#[test]
fn expired_reject() {
    let s = signer();

    let expires_at = 2_000_000_000_000u64; // a past-ish value relative to NOW_MS if we set now past it

    let payload = ResumePayload::Daemon {
        daemon_id: "daemon-expiry-test".to_string(),
        expires_at,
    };

    let (token, _) = s.issue(&payload, 0, Some(expires_at));

    // now_ms == expires_at → strict ≤ → rejected
    assert!(
        s.verify(&token, expires_at).is_none(),
        "now == expires_at must be rejected (strict <=)"
    );

    // now_ms == expires_at + 1 → also rejected
    assert!(
        s.verify(&token, expires_at + 1).is_none(),
        "now > expires_at must be rejected"
    );

    // now_ms == expires_at - 1 → accepted
    assert!(
        s.verify(&token, expires_at - 1).is_some(),
        "now < expires_at must be accepted"
    );
}

// ── Vector 4: tampered MAC rejected ──────────────────────────────────────────

/// Flipping any bit in the MAC half of the wire token must cause rejection.
#[test]
fn tampered_mac_reject() {
    use base64::Engine as _;

    let s = signer();

    let payload = ResumePayload::Daemon {
        daemon_id: "daemon-tamper-mac".to_string(),
        expires_at: FAR_FUTURE_EXPIRES_AT,
    };

    let (token, _) = s.issue(&payload, NOW_MS, Some(FAR_FUTURE_EXPIRES_AT));

    // Split on the last dot to isolate the MAC half.
    let dot = token.rfind('.').expect("token must contain a dot");
    let payload_b64 = &token[..dot];
    let mac_b64 = &token[dot + 1..];

    // Decode, flip first byte, re-encode.
    let mut mac_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(mac_b64)
        .expect("mac must be valid base64url");
    mac_bytes[0] ^= 0xFF; // single-byte flip
    let tampered_mac_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&mac_bytes);

    let tampered_token = format!("{payload_b64}.{tampered_mac_b64}");

    assert!(
        s.verify(&tampered_token, NOW_MS).is_none(),
        "tampered MAC must be rejected"
    );
}

// ── Vector 5: wrong version byte rejected ────────────────────────────────────

/// A payload with version byte ≠ 2 must be rejected even when the BLAKE2b MAC
/// is correctly computed over that (wrong-version) payload.
#[test]
fn wrong_version_reject() {
    use base64::Engine as _;
    use blake2::digest::generic_array::typenum::U32;
    use blake2::digest::{FixedOutput, Mac};
    use blake2::Blake2bMac;

    // Hand-craft a payload with version=1 (wrong), role=daemon(0), valid
    // daemonId and expiresAt, so the only flaw is the version byte.
    let daemon_id = b"d-golden-wrong-ver";
    let expires_at: u64 = FAR_FUTURE_EXPIRES_AT;

    let mut buf: Vec<u8> = Vec::new();
    buf.push(1u8); // version = 1 (wrong; current = 2)
    buf.push(0u8); // role = daemon
    buf.extend_from_slice(&(daemon_id.len() as u32).to_be_bytes());
    buf.extend_from_slice(daemon_id);
    buf.extend_from_slice(&0u32.to_be_bytes()); // frontendId len = 0
    buf.extend_from_slice(&expires_at.to_be_bytes());

    // Compute a valid BLAKE2b MAC over this payload using the same fixed key.
    let mut mac = Blake2bMac::<U32>::new_from_slice(&FIXED_KEY).expect("32-byte key is valid");
    blake2::digest::Update::update(&mut mac, &buf);
    let mac_bytes: Vec<u8> = mac.finalize_fixed().to_vec();

    let token = format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&mac_bytes)
    );

    // Verify must reject because version ≠ 2.
    let s = signer();
    assert!(
        s.verify(&token, 0).is_none(),
        "wrong version byte must be rejected even with valid MAC"
    );
}

// ── Vector 6: empty daemonId rejected ────────────────────────────────────────

/// A daemon-role token with an empty `daemon_id` must be rejected by verify.
#[test]
fn empty_daemon_id_reject() {
    let s = signer();

    let payload = ResumePayload::Daemon {
        daemon_id: String::new(), // empty
        expires_at: FAR_FUTURE_EXPIRES_AT,
    };

    let (token, _) = s.issue(&payload, 0, Some(FAR_FUTURE_EXPIRES_AT));

    assert!(
        s.verify(&token, 0).is_none(),
        "empty daemon_id must be rejected"
    );
}

// ── Vector 7: frontend-role with empty frontendId rejected ───────────────────

/// A frontend-role token with an empty `frontend_id` must be rejected by verify.
#[test]
fn empty_frontend_id_reject() {
    let s = signer();

    let payload = ResumePayload::Frontend {
        daemon_id: "daemon-golden-07".to_string(),
        frontend_id: String::new(), // empty
        expires_at: FAR_FUTURE_EXPIRES_AT,
    };

    let (token, _) = s.issue(&payload, 0, Some(FAR_FUTURE_EXPIRES_AT));

    assert!(
        s.verify(&token, 0).is_none(),
        "frontend-role with empty frontend_id must be rejected"
    );
}

// ── Vector 8: cross-role rejection (daemon token used as frontend) ────────────

/// A daemon-role token must NOT verify as a frontend-role token.
/// Because the binary payload carries an explicit role byte, decoding a
/// daemon token always returns `ResumePayload::Daemon { .. }`.  The caller
/// (handshake.rs) must check role against the actual connection role; here
/// we assert that the payload's role is Daemon and NOT Frontend — i.e.,
/// the enum discriminant acts as the role guard, and the empty `frontend_id`
/// slot in a daemon token would fail the frontend-empty-frontendId guard if
/// someone tried to re-interpret the decoded bytes as frontend.
#[test]
fn cross_role_reject() {
    let s = signer();

    // Issue a valid daemon token.
    let daemon_payload = ResumePayload::Daemon {
        daemon_id: "daemon-golden-08".to_string(),
        expires_at: FAR_FUTURE_EXPIRES_AT,
    };

    let (token, _) = s.issue(&daemon_payload, NOW_MS, Some(FAR_FUTURE_EXPIRES_AT));

    // Verify succeeds — the token is structurally valid.
    let result = s
        .verify(&token, NOW_MS)
        .expect("daemon token must verify OK on its own");

    // The decoded payload must be Daemon, NOT Frontend.
    assert!(
        matches!(result, ResumePayload::Daemon { .. }),
        "daemon token must decode to Daemon variant, not Frontend"
    );

    // Confirm the caller-side role check: if the receiver expected a Frontend
    // token, it would see a Daemon variant and reject.
    let is_frontend = matches!(result, ResumePayload::Frontend { .. });
    assert!(
        !is_frontend,
        "daemon token must NOT be accepted as a frontend token"
    );

    // Additionally: hand-craft a payload whose role byte is set to frontend (1)
    // but whose `frontendId` slot encodes "" (empty) — simulating a daemon token
    // with the role byte flipped.  The verify must reject it because the
    // frontend-role path checks `frontend_id.is_empty()`.
    use base64::Engine as _;
    use blake2::digest::generic_array::typenum::U32;
    use blake2::digest::{FixedOutput, Mac};
    use blake2::Blake2bMac;

    let daemon_id = b"daemon-golden-08";
    let expires_at: u64 = FAR_FUTURE_EXPIRES_AT;

    let mut buf: Vec<u8> = Vec::new();
    buf.push(2u8); // version = 2 (correct)
    buf.push(1u8); // role = FRONTEND (1) — but frontendId will be empty
    buf.extend_from_slice(&(daemon_id.len() as u32).to_be_bytes());
    buf.extend_from_slice(daemon_id);
    buf.extend_from_slice(&0u32.to_be_bytes()); // frontendId len = 0 (empty)
    buf.extend_from_slice(&expires_at.to_be_bytes());

    let mut mac = Blake2bMac::<U32>::new_from_slice(&FIXED_KEY).expect("32-byte key is valid");
    blake2::digest::Update::update(&mut mac, &buf);
    let mac_bytes: Vec<u8> = mac.finalize_fixed().to_vec();

    let flipped_role_token = format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&mac_bytes)
    );

    // verify must reject: frontend-role with empty frontendId.
    assert!(
        s.verify(&flipped_role_token, 0).is_none(),
        "frontend-role token with empty frontendId must be rejected (cross-role reject)"
    );
}
