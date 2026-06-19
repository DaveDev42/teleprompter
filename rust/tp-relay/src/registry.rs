//! Relay connection state: `DaemonState` + `Registration` — pure data structures
//! and mutation helpers with no I/O.
//!
//! Port of the surveyed TypeScript structures (`relay-server.ts:222–265`) plus
//! the documented invariants, adapted to Rust idioms:
//!
//! * `sessions: IndexSet<String>` — insertion-ordered set (matches JavaScript's
//!   `Set` insertion order) capped at `MAX_SESSIONS_PER_DAEMON` (256) with
//!   oldest-first eviction.
//! * `attached: HashMap<String, u32>` — sid → live frontend subscription
//!   ref-count.  Decrements stop at zero and remove the key.
//! * `proof: Option<String>` — `None` is the out-of-band "no proof recorded"
//!   sentinel.  `Some("")` is a legitimate empty-string proof and must never be
//!   used as a sentinel (that would collapse two distinct states).
//! * `last_seen: u64` — epoch-ms, refreshed only by daemon-role traffic.

use std::collections::HashMap;

use indexmap::IndexSet;

/// Maximum sessions per daemon in the `sessions` set.  Mirrors
/// `MAX_SESSIONS_PER_DAEMON = 256` at `relay-server.ts:127`.
pub const MAX_SESSIONS_PER_DAEMON: usize = 256;

// ── Registration ─────────────────────────────────────────────────────────────

/// One entry in the `registrations` map (`daemonId → Registration`).
///
/// `proof` discriminant (mirrors `relay-server.ts:256–265` comment):
///
/// * `None` — daemonId was populated by a token-only `relay.auth` (or
///   `relay.hello` without a proof field). This is the out-of-band
///   "no proof recorded" sentinel — distinct from any real proof value
///   including the empty string.
/// * `Some(s)` — the real proof string supplied by `relay.register` /
///   `relay.hello { proof }`. May be `Some("")` if the daemon
///   sent an empty proof; that is a valid proof and is compared
///   normally in the different-credentials guard.
///
/// **Using `""` as a sentinel would collide with a daemon that legitimately sends
/// `proof=""`, silently bypassing the different-credentials guard.  `None` is
/// unambiguous.**
#[derive(Debug, Clone, PartialEq)]
pub struct Registration {
    /// The relay auth token string.
    pub token: String,
    /// `None` = seeded by token-only auth; `Some(s)` = real proof from register.
    pub proof: Option<String>,
}

// ── DaemonState ───────────────────────────────────────────────────────────────

/// Per-daemon connection state.  One entry in the `daemonStates` map.
///
/// Fields mirror `DaemonState` in `relay-server.ts:222–236` exactly.
#[derive(Debug, Clone)]
pub struct DaemonState {
    /// Whether the daemon's WebSocket is currently connected and not stale.
    pub online: bool,
    /// Ordered set of session IDs seen from this daemon's `relay.pub` frames.
    /// Capped at `MAX_SESSIONS_PER_DAEMON`; oldest-insertion entry is evicted
    /// when the cap is exceeded.
    pub sessions: IndexSet<String>,
    /// Last epoch-ms timestamp of daemon-own traffic (ping, pub, connect,
    /// disconnect).  Frontend traffic does NOT refresh this.
    pub last_seen: u64,
    /// `sid → live frontend subscription count`.  Key absent == 0.
    pub attached: HashMap<String, u32>,
    /// The registration token most recently registered by this daemon.
    /// `None` when the entry was seeded by a frontend-first auth.
    pub registration_token: Option<String>,
}

impl DaemonState {
    /// Seed a minimal `DaemonState` from a frontend-first auth (the daemon has
    /// not connected yet).  Mirrors `relay-server.ts:999–1010`.
    pub fn seed_offline(now_ms: u64) -> Self {
        DaemonState {
            online: false,
            sessions: IndexSet::new(),
            last_seen: now_ms,
            attached: HashMap::new(),
            registration_token: None,
        }
    }

    /// Add a session ID and enforce the `MAX_SESSIONS_PER_DAEMON` cap.
    ///
    /// Only called from daemon-role `relay.pub` handling.  Mirrors
    /// `relay-server.ts:1117–1126`.
    pub fn add_session(&mut self, sid: String) {
        self.sessions.insert(sid);
        // Evict oldest-inserted entries until at or below cap.
        while self.sessions.len() > MAX_SESSIONS_PER_DAEMON {
            // `shift_remove_index(0)` removes the first (oldest) entry in O(1)
            // amortised, shifting remaining indices down.
            self.sessions.shift_remove_index(0);
        }
    }

    /// Increment the subscription ref-count for `sid`.  Only called when a
    /// frontend subscribes (`relay.sub`).
    pub fn attach(&mut self, sid: &str) {
        let count = self.attached.entry(sid.to_string()).or_insert(0);
        *count += 1;
    }

    /// Decrement the subscription ref-count for `sid`.  Removes the key when the
    /// count reaches zero.  No-op if the key is absent.
    ///
    /// Mirrors the guard "only decrement if key exists" (`relay-server.ts:1300`).
    pub fn detach(&mut self, sid: &str) {
        if let Some(count) = self.attached.get_mut(sid) {
            if *count <= 1 {
                self.attached.remove(sid);
            } else {
                *count -= 1;
            }
        }
        // Key absent → no-op (no phantom unwrap_or(1) fallback).
    }
}

// ── Registry ──────────────────────────────────────────────────────────────────

/// Central relay connection registry — holds all per-daemon state and the
/// token validity maps.  Pure data structure with no I/O.
#[derive(Debug, Default)]
pub struct Registry {
    /// `daemonId → DaemonState`
    pub daemon_states: HashMap<String, DaemonState>,
    /// `daemonId → Registration`
    pub registrations: HashMap<String, Registration>,
    /// `token → daemonId` — fast O(1) token validity lookup.
    pub valid_tokens: HashMap<String, String>,
}

impl Registry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    // ── upsert_daemon_state ───────────────────────────────────────────────────

    /// Upsert daemon state on auth or resume.
    ///
    /// For a **daemon** auth: `online` is forced to `true`, `last_seen` is reset
    /// to `now_ms`, existing `sessions`/`attached` are preserved (reconnect does
    /// not lose session history).  `registration_token` is updated only when
    /// `reg_token` is `Some` — resume auth passes `None` to avoid overwriting
    /// the existing token.
    ///
    /// For a **frontend** auth (or any non-daemon reconnect): if no entry exists
    /// for the `daemon_id`, a minimal `online=false` stub is seeded.  Existing
    /// entries are left untouched (they may have come from the daemon itself).
    ///
    /// Mirrors `relay-server.ts:986–1011`.
    pub fn upsert_daemon_state(
        &mut self,
        daemon_id: &str,
        is_daemon: bool,
        reg_token: Option<&str>,
        now_ms: u64,
    ) {
        if is_daemon {
            // Daemon (re)connecting: set online, reset last_seen, preserve sessions.
            let state = self
                .daemon_states
                .entry(daemon_id.to_string())
                .or_insert_with(|| DaemonState::seed_offline(now_ms));
            state.online = true;
            state.last_seen = now_ms;
            // Only update registration_token if the caller supplied one.
            if let Some(tok) = reg_token {
                if state.registration_token.is_none() {
                    state.registration_token = Some(tok.to_string());
                }
            }
        } else {
            // Frontend (re)connecting: seed a minimal stub if absent.
            self.daemon_states
                .entry(daemon_id.to_string())
                .or_insert_with(|| DaemonState::seed_offline(now_ms));
        }
    }

    // ── handle_register ───────────────────────────────────────────────────────

    /// Process `relay.register` — different-credentials guard + state mutation.
    ///
    /// Returns `Err(reason)` if the daemonId is already registered with a
    /// *different* non-null proof.  On success mutates `valid_tokens` and
    /// `registrations`.
    ///
    /// Mirrors `relay-server.ts:760–804` (without the WS response emission).
    pub fn handle_register(
        &mut self,
        daemon_id: &str,
        token: &str,
        proof: &str,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        // 1. Different-credentials guard (relay-server.ts:768–775).
        //    `existing.proof !== null && existing.proof !== msg.proof`
        //    → `None` stored proof never blocks a subsequent register.
        if let Some(existing) = self.registrations.get(daemon_id) {
            if let Some(stored_proof) = &existing.proof {
                if stored_proof != proof {
                    return Err("Daemon ID already registered with different credentials");
                }
            }
        }

        // 2. Stale-token cleanup (relay-server.ts:781–788).
        if let Some(existing) = self.registrations.get(daemon_id) {
            if existing.token != token {
                // Old token is no longer valid.
                self.valid_tokens.remove(&existing.token);
                // Update daemonStates.registrationToken if a state entry exists.
                if let Some(state) = self.daemon_states.get_mut(daemon_id) {
                    state.registration_token = Some(token.to_string());
                }
            }
        }

        // 3. State mutation (relay-server.ts:791–803).
        self.valid_tokens
            .insert(token.to_string(), daemon_id.to_string());
        self.registrations.insert(
            daemon_id.to_string(),
            Registration {
                token: token.to_string(),
                proof: Some(proof.to_string()), // real proof string, even if empty
            },
        );
        // Seed a daemonState if none exists (frontend-first path may have
        // pre-created one; don't overwrite it — just ensure it exists).
        self.daemon_states
            .entry(daemon_id.to_string())
            .or_insert_with(|| DaemonState::seed_offline(now_ms));
        // If the existing state has registration_token == None, set it.
        if let Some(state) = self.daemon_states.get_mut(daemon_id) {
            if state.registration_token.is_none() {
                state.registration_token = Some(token.to_string());
            }
        }

        Ok(())
    }

    // ── handle_auth (token validation + state seeding) ────────────────────────

    /// Validate a `relay.auth` token.
    ///
    /// Returns `Ok(())` if valid; `Err(reason)` if the token is unknown or the
    /// daemonId does not match the stored mapping.
    ///
    /// On success for daemon role, also inserts a `proof: None` registration if
    /// none exists — enabling subsequent `registrations.contains_key()` checks
    /// for resume auth.
    ///
    /// Mirrors `relay-server.ts:806–877` (state + validation only, no WS I/O).
    pub fn handle_auth(
        &mut self,
        daemon_id: &str,
        token: &str,
        is_daemon: bool,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        // 1. Token validity check (relay-server.ts:810–817).
        match self.valid_tokens.get(token) {
            Some(stored_id) if stored_id == daemon_id => {}
            _ => return Err("Invalid token or daemon ID"),
        }

        // 2. Upsert daemon state.
        let reg_token = if is_daemon { Some(token) } else { None };
        self.upsert_daemon_state(daemon_id, is_daemon, reg_token, now_ms);

        // 3. Seed registrations with proof=None if daemon + not already present
        //    (relay-server.ts:867–869).
        if is_daemon && !self.registrations.contains_key(daemon_id) {
            self.registrations.insert(
                daemon_id.to_string(),
                Registration {
                    token: token.to_string(),
                    proof: None, // the null sentinel — out-of-band "no proof recorded"
                },
            );
        }

        Ok(())
    }

    // ── handle_auth_resume ────────────────────────────────────────────────────

    /// Validate that the daemon is still registered (O(1) check) for resume auth.
    ///
    /// The resume-token HMAC signature and expiry are verified by the caller
    /// (`ResumeTokenSigner::verify`).  This function only checks the
    /// `registrations.has(daemon_id)` gate — `valid_tokens` is not consulted
    /// (mirrors `relay-server.ts:900–917`).
    ///
    /// On success, upserts daemon state with `reg_token = None` so the existing
    /// `registration_token` is preserved.
    pub fn handle_auth_resume(
        &mut self,
        daemon_id: &str,
        is_daemon: bool,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        if !self.registrations.contains_key(daemon_id) {
            return Err("Daemon no longer registered");
        }
        // upsert with reg_token=None preserves the existing registrationToken.
        self.upsert_daemon_state(daemon_id, is_daemon, None, now_ms);
        Ok(())
    }

    // ── daemon_disconnect ─────────────────────────────────────────────────────

    /// Mark a daemon as offline when its WebSocket closes.  Starts the
    /// offline-eviction clock (`last_seen = now_ms`).
    ///
    /// Mirrors `relay-server.ts:1275–1282`.
    pub fn daemon_disconnect(&mut self, daemon_id: &str, now_ms: u64) {
        if let Some(state) = self.daemon_states.get_mut(daemon_id) {
            state.online = false;
            state.last_seen = now_ms;
        }
    }

    // ── frontend_disconnect ───────────────────────────────────────────────────

    /// Decrement `attached` for all subscriptions held by a disconnecting
    /// frontend.  Mirrors `relay-server.ts:1288–1307`.
    pub fn frontend_disconnect(&mut self, daemon_id: &str, subscriptions: &[String]) {
        if let Some(state) = self.daemon_states.get_mut(daemon_id) {
            for sid in subscriptions {
                state.detach(sid);
            }
        }
    }

    // ── handle_pub (session tracking + lastSeen) ──────────────────────────────

    /// Record a daemon-role `relay.pub` — adds the session to the ordered set
    /// (with cap eviction) and refreshes `last_seen`.
    ///
    /// Frontend-role `relay.pub` does NOT call this — `last_seen` must not be
    /// refreshed by frontend traffic.  Mirrors `relay-server.ts:1117–1126`.
    pub fn daemon_pub(&mut self, daemon_id: &str, sid: String, now_ms: u64) {
        if let Some(state) = self.daemon_states.get_mut(daemon_id) {
            state.add_session(sid);
            state.last_seen = now_ms;
        }
    }

    // ── handle_ping (daemon-only lastSeen refresh) ────────────────────────────

    /// Refresh `last_seen` for a daemon ping.  No-op for non-daemon callers.
    ///
    /// Mirrors `relay-server.ts:1334–1338`.
    pub fn daemon_ping(&mut self, daemon_id: &str, now_ms: u64) {
        if let Some(state) = self.daemon_states.get_mut(daemon_id) {
            state.last_seen = now_ms;
        }
    }

    // ── evict_daemon ──────────────────────────────────────────────────────────

    /// Remove all state for a daemon after the offline-eviction TTL expires.
    ///
    /// Deletes:
    /// - `valid_tokens[state.registration_token]` (if present)
    /// - `registrations[daemon_id]`
    /// - `daemon_states[daemon_id]`
    /// - (callers should also purge `recentFrames` keys prefixed `"daemonId:"`
    ///   — that map lives outside this struct in the full relay server)
    ///
    /// Mirrors `relay-server.ts:1580–1596`.
    pub fn evict_daemon(&mut self, daemon_id: &str) {
        // Remove the auth token from the valid-tokens map.
        if let Some(state) = self.daemon_states.get(daemon_id) {
            if let Some(tok) = &state.registration_token {
                self.valid_tokens.remove(tok);
            }
        }
        self.registrations.remove(daemon_id);
        self.daemon_states.remove(daemon_id);
    }

    // ── stale / eviction sweep ────────────────────────────────────────────────

    /// Two-phase stale check.  Designed to be called by a periodic timer.
    ///
    /// Phase 1 (stale timeout, default 90 s): if `online && now - last_seen >
    /// stale_timeout_ms`, set `online=false`. **`last_seen` is NOT touched** —
    /// it is refreshed only by the daemon's own traffic (`daemon_pub` and the
    /// daemon branch of `upsert_daemon_state`, both role-gated), so the stale
    /// sweep, which is internal bookkeeping rather than daemon traffic, must
    /// leave the offline-eviction clock anchored at the last real daemon
    /// activity (see the `last_seen` invariant in `.claude/rules/relay-capacity.md`
    /// and the `DaemonState.last_seen` doc). Resetting it here would (a) violate
    /// that invariant and (b) push Phase 2 eviction ~`stale_timeout_ms` later
    /// than the TS reference, holding dead `DaemonState`/`recentFrames` longer.
    ///
    /// Phase 2 (offline evict TTL, default 1 h): if `!online && now - last_seen >
    /// offline_evict_ms`, evict the daemon.
    ///
    /// Returns both transition lists so the caller (Step 4 WS layer) can mirror
    /// `relay-server.ts:1553-1566`: `broadcastPresence(daemonId)` for every
    /// daemon newly marked offline in Phase 1, and an offline presence + a
    /// `recentFrames` purge for every daemon evicted in Phase 2.
    ///
    /// Mirrors `relay-server.ts:1553–1566`.
    pub fn check_stale_daemons(
        &mut self,
        now_ms: u64,
        stale_timeout_ms: u64,
        offline_evict_ms: u64,
    ) -> StaleCheckResult {
        let mut newly_offline: Vec<String> = Vec::new();
        let mut evicted: Vec<String> = Vec::new();

        // Phase 1: mark online → offline. Do NOT touch last_seen (see doc above).
        for (daemon_id, state) in &mut self.daemon_states {
            if state.online && now_ms.saturating_sub(state.last_seen) > stale_timeout_ms {
                state.online = false;
                newly_offline.push(daemon_id.clone());
            }
        }

        // Phase 2: collect offline entries past the eviction TTL.
        for (daemon_id, state) in &self.daemon_states {
            if !state.online && now_ms.saturating_sub(state.last_seen) > offline_evict_ms {
                evicted.push(daemon_id.clone());
            }
        }

        // Evict.
        for daemon_id in &evicted {
            self.evict_daemon(daemon_id);
        }

        StaleCheckResult {
            newly_offline,
            evicted,
        }
    }
}

/// Result of a [`Registry::check_stale_daemons`] sweep. Both lists drive
/// presence broadcasts in the Step-4 WS layer: `newly_offline` daemons just
/// transitioned online→offline (Phase 1); `evicted` daemons were removed after
/// exceeding the offline-eviction TTL (Phase 2) and also need a `recentFrames`
/// purge. Mirrors the two `broadcastPresence` sites in
/// `relay-server.ts:1560` (Phase 1) and `evictDaemon` (Phase 2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StaleCheckResult {
    /// daemon_ids transitioned online → offline this sweep (Phase 1).
    pub newly_offline: Vec<String>,
    /// daemon_ids evicted this sweep (Phase 2).
    pub evicted: Vec<String>,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Invariant 1: proof None vs Some("") are distinct ─────────────────────

    #[test]
    fn proof_none_vs_some_empty_are_distinct() {
        // None-stored proof must NOT block a subsequent register (the null sentinel
        // is out-of-band "no proof recorded", not the same as an empty string).

        // Part A: None does not block a register with any proof.
        let mut reg = Registry::new();
        reg.registrations.insert(
            "d1".to_string(),
            Registration {
                token: "tok".to_string(),
                proof: None, // None sentinel
            },
        );
        reg.valid_tokens.insert("tok".to_string(), "d1".to_string());
        reg.valid_tokens
            .insert("tok2".to_string(), "d1".to_string());
        // Register with an empty-string proof — None sentinel should not block this.
        assert!(reg.handle_register("d1", "tok2", "", 0).is_ok());
        // After that, stored proof is Some("") — a different proof IS rejected.
        reg.valid_tokens
            .insert("tok3".to_string(), "d1".to_string());
        let result = reg.handle_register("d1", "tok3", "real-proof", 0);
        assert!(
            result.is_err(),
            "different proof should be rejected after Some(\"\") stored"
        );

        // Part B: None does not block a register with a non-empty proof either.
        let mut reg2 = Registry::new();
        reg2.registrations.insert(
            "d2".to_string(),
            Registration {
                token: "tok-x".to_string(),
                proof: None, // None sentinel
            },
        );
        reg2.valid_tokens
            .insert("tok-x".to_string(), "d2".to_string());
        reg2.valid_tokens
            .insert("tok-y".to_string(), "d2".to_string());
        assert!(reg2.handle_register("d2", "tok-y", "real-proof", 0).is_ok());
        // Now stored is Some("real-proof") — a different proof must be rejected.
        reg2.valid_tokens
            .insert("tok-z".to_string(), "d2".to_string());
        let result2 = reg2.handle_register("d2", "tok-z", "other-proof", 0);
        assert!(result2.is_err(), "different proof should be rejected");
        // Same proof again → accepted.
        reg2.valid_tokens
            .insert("tok-w".to_string(), "d2".to_string());
        assert!(reg2.handle_register("d2", "tok-w", "real-proof", 0).is_ok());
    }

    #[test]
    fn empty_string_proof_stored_as_some_empty() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_register("d", "tok", "", 0).unwrap();

        let stored = r.registrations.get("d").unwrap();
        assert_eq!(stored.proof, Some(String::new())); // Some("") not None
    }

    // ── Invariant 2: sessions cap=256, insertion-order eviction ──────────────

    #[test]
    fn sessions_cap_evicts_oldest() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 0).unwrap();

        // Push 257 distinct sids from daemon-role pub.
        for i in 0u32..257 {
            r.daemon_pub("d", format!("sid-{i:04}"), 1);
        }

        let state = r.daemon_states.get("d").unwrap();
        assert_eq!(state.sessions.len(), 256);
        // The first-inserted ("sid-0000") must have been evicted.
        assert!(
            !state.sessions.contains("sid-0000"),
            "oldest sid should be evicted"
        );
        // The last-inserted ("sid-0256") must be present.
        assert!(
            state.sessions.contains("sid-0256"),
            "newest sid must be retained"
        );
    }

    // ── Invariant 3: lastSeen only by daemon traffic ──────────────────────────

    #[test]
    fn last_seen_not_refreshed_by_frontend_traffic() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 1000).unwrap();

        // Daemon disconnects at t=2000.
        r.daemon_disconnect("d", 2000);
        let last_seen_after_disconnect = r.daemon_states.get("d").unwrap().last_seen;
        assert_eq!(last_seen_after_disconnect, 2000);

        // Frontend auth (not daemon) → should NOT update last_seen.
        r.valid_tokens.insert("fe-tok".to_string(), "d".to_string());
        // Simulate frontend-role upsert (is_daemon=false).
        r.upsert_daemon_state("d", false, None, 9999);
        let last_seen_after_frontend = r.daemon_states.get("d").unwrap().last_seen;
        assert_eq!(
            last_seen_after_frontend, 2000,
            "frontend auth must not update last_seen"
        );
    }

    // ── Invariant 4: frontend-first auth seeds online=false ──────────────────

    #[test]
    fn frontend_first_auth_seeds_offline_state() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());

        // Frontend auth before daemon has connected.
        r.handle_auth("d", "tok", false, 0).unwrap();

        let state = r.daemon_states.get("d").expect("state must exist");
        assert!(!state.online, "seeded state must be offline");
        assert!(state.registration_token.is_none(), "token must be None");
    }

    // ── Invariant 5: daemon reconnect preserves sessions/attached ─────────────

    #[test]
    fn daemon_reconnect_preserves_sessions_and_attached() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 1000).unwrap();

        // Add sessions and attached state.
        r.daemon_pub("d", "sid-a".into(), 1000);
        r.daemon_pub("d", "sid-b".into(), 1000);
        r.daemon_states.get_mut("d").unwrap().attach("sid-a");

        // Daemon disconnects.
        r.daemon_disconnect("d", 2000);

        // Daemon reconnects.
        r.upsert_daemon_state("d", true, Some("tok"), 3000);

        let state = r.daemon_states.get("d").unwrap();
        assert!(state.online, "must be online after reconnect");
        assert!(
            state.sessions.contains("sid-a"),
            "sessions must be preserved"
        );
        assert!(
            state.sessions.contains("sid-b"),
            "sessions must be preserved"
        );
        assert_eq!(
            state.attached.get("sid-a").copied(),
            Some(1),
            "attached must be preserved"
        );
    }

    // ── Invariant 6: evict_daemon cleans all three locations ─────────────────

    #[test]
    fn evict_daemon_cleans_all_locations() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_register("d", "tok", "proof", 0).unwrap();
        r.upsert_daemon_state("d", true, Some("tok"), 0);

        r.evict_daemon("d");

        assert!(!r.valid_tokens.contains_key("tok"), "token must be removed");
        assert!(
            !r.registrations.contains_key("d"),
            "registration must be removed"
        );
        assert!(!r.daemon_states.contains_key("d"), "state must be removed");
    }

    // ── Invariant 7: token rotation in handle_register ────────────────────────

    #[test]
    fn token_rotation_removes_old_token() {
        let mut r = Registry::new();
        r.valid_tokens
            .insert("tok-old".to_string(), "d".to_string());
        r.handle_register("d", "tok-old", "proof", 0).unwrap();
        r.upsert_daemon_state("d", true, Some("tok-old"), 0);

        // Re-register with a new token.
        r.valid_tokens
            .insert("tok-new".to_string(), "d".to_string());
        r.handle_register("d", "tok-new", "proof", 0).unwrap();

        assert!(
            !r.valid_tokens.contains_key("tok-old"),
            "old token must be deleted"
        );
        assert!(
            r.valid_tokens.contains_key("tok-new"),
            "new token must be present"
        );
        assert_eq!(
            r.daemon_states.get("d").unwrap().registration_token,
            Some("tok-new".to_string())
        );
    }

    // ── Invariant 8: handle_auth seeds registrations with proof=None ──────────

    #[test]
    fn auth_seeds_registration_with_proof_none() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 0).unwrap();

        let reg = r.registrations.get("d").unwrap();
        assert_eq!(
            reg.proof, None,
            "auth-seeded registration must have proof=None"
        );
    }

    // ── Invariant 9: resume auth uses registrations O(1) lookup ──────────────

    #[test]
    fn resume_auth_checks_registrations_not_valid_tokens() {
        let mut r = Registry::new();
        // Seed only via registrations (no valid_tokens entry).
        r.registrations.insert(
            "d".to_string(),
            Registration {
                token: "tok".to_string(),
                proof: None,
            },
        );
        // Should succeed based on registrations.contains_key only.
        assert!(r.handle_auth_resume("d", true, 0).is_ok());
        // Unknown daemonId → rejected.
        assert!(r.handle_auth_resume("unknown", true, 0).is_err());
    }

    // ── Invariant 10: resume does not overwrite registrationToken ─────────────

    #[test]
    fn resume_does_not_overwrite_registration_token() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 0).unwrap();

        let original_token = r.daemon_states.get("d").unwrap().registration_token.clone();

        // Simulate resume (reg_token = None).
        r.registrations.insert(
            "d".to_string(),
            Registration {
                token: "tok".to_string(),
                proof: None,
            },
        );
        r.handle_auth_resume("d", true, 1000).unwrap();

        assert_eq!(
            r.daemon_states.get("d").unwrap().registration_token,
            original_token,
            "resume must not overwrite registrationToken"
        );
    }

    // ── Invariant 11: attached ref-count decrement only when present ──────────

    #[test]
    fn detach_no_phantom_count() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 0).unwrap();

        let state = r.daemon_states.get_mut("d").unwrap();
        // Detach a sid that was never attached — must be a no-op.
        state.detach("nonexistent-sid");
        assert!(!state.attached.contains_key("nonexistent-sid"));

        // Attach once, detach once → key removed.
        state.attach("sid-a");
        state.detach("sid-a");
        assert!(
            !state.attached.contains_key("sid-a"),
            "key must be removed at zero"
        );

        // Attach twice, detach once → count=1.
        state.attach("sid-b");
        state.attach("sid-b");
        state.detach("sid-b");
        assert_eq!(state.attached.get("sid-b").copied(), Some(1));
    }

    // ── Invariant 13: stale-check two-phase ───────────────────────────────────

    #[test]
    fn stale_check_two_phase() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 0).unwrap();
        r.registrations.insert(
            "d".to_string(),
            Registration {
                token: "tok".to_string(),
                proof: None,
            },
        );

        // Phase 1: daemon goes stale after 90 s (91 s elapsed with last_seen=0).
        // The online→offline transition is reported in `newly_offline` (so the
        // WS layer can broadcast presence, mirroring relay-server.ts:1560) and
        // nothing is evicted yet.
        let r1 = r.check_stale_daemons(91_000, 90_000, 3_600_000);
        assert_eq!(
            r1.newly_offline,
            vec!["d".to_string()],
            "online→offline transition must be reported for presence broadcast"
        );
        assert!(
            r1.evicted.is_empty(),
            "should not be evicted yet — offline evict TTL not reached"
        );
        assert!(
            !r.daemon_states.get("d").unwrap().online,
            "should now be offline"
        );

        // INVARIANT (parity with relay-server.ts:1554-1560): Phase 1 must NOT
        // touch last_seen — it stays anchored at the daemon's last real traffic
        // (0 here, the auth time). Only daemon-own traffic refreshes it. So the
        // offline-eviction clock measures from 0, NOT from the stale-detection
        // time (91_000). A second sweep at the same instant re-reports nothing.
        assert_eq!(
            r.daemon_states.get("d").unwrap().last_seen,
            0,
            "Phase 1 must not reset last_seen — eviction clock stays anchored at last daemon traffic"
        );
        let r1b = r.check_stale_daemons(91_000, 90_000, 3_600_000);
        assert!(
            r1b.newly_offline.is_empty(),
            "already offline — no second transition"
        );

        // Just before the eviction TTL measured FROM 0 (not from 91_000): a
        // sweep at now = offline_evict_ms exactly must NOT evict (strict `>`),
        // proving the clock is anchored at last_seen=0. With the old buggy
        // last_seen=now_ms reset this instant would be well inside the window.
        let r_edge = r.check_stale_daemons(3_600_000, 90_000, 3_600_000);
        assert!(
            r_edge.evicted.is_empty(),
            "now - last_seen(0) == offline_evict_ms is not yet past the TTL"
        );
        assert!(
            r.daemon_states.contains_key("d"),
            "still present at the edge"
        );

        // Phase 2: offline evict TTL (1 h) reached at now=3_600_001 because
        // last_seen is still 0 (anchored). Under the old bug eviction would not
        // fire until 91_000 + 3_600_001.
        let r2 = r.check_stale_daemons(3_600_001, 90_000, 3_600_000);
        assert_eq!(
            r2.evicted,
            vec!["d".to_string()],
            "daemon must be evicted once now-last_seen(0) exceeds the TTL"
        );
        assert!(
            r2.newly_offline.is_empty(),
            "no new online→offline transition during the eviction sweep"
        );
        assert!(!r.daemon_states.contains_key("d"), "state must be gone");
        assert!(
            !r.registrations.contains_key("d"),
            "registration must be gone"
        );
        assert!(!r.valid_tokens.contains_key("tok"), "token must be gone");
    }

    // ── Invariant 15: sessions only mutated by daemon-role pub ────────────────

    #[test]
    fn sessions_only_mutated_by_daemon_pub() {
        let mut r = Registry::new();
        r.valid_tokens.insert("tok".to_string(), "d".to_string());
        r.handle_auth("d", "tok", true, 0).unwrap();

        // Frontend auth should NOT add sessions.
        r.upsert_daemon_state("d", false, None, 0);
        let sessions_before = r.daemon_states.get("d").unwrap().sessions.len();

        // daemon_pub adds a session.
        r.daemon_pub("d", "sid-x".into(), 1000);
        let sessions_after = r.daemon_states.get("d").unwrap().sessions.len();
        assert_eq!(sessions_after, sessions_before + 1);
    }
}
