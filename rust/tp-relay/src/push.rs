//! `PushService` orchestrator — WebSocket-priority delivery with dedup and
//! rate-limit guards, backed by [`crate::apns::ApnsClient`].
//!
//! Parity port of `packages/relay/src/push.ts` with deterministic-clock
//! injection for testability.
//!
//! ## Parity mapping
//!
//! | TS source | Rust equivalent |
//! |-----------|-----------------|
//! | `DEFAULT_RATE_LIMIT_PER_MINUTE = 5` (`push.ts:7`) | [`DEFAULT_RATE_LIMIT_PER_MINUTE`] |
//! | `DEFAULT_DEDUP_WINDOW_MS = 60_000` (`push.ts:8`) | [`DEFAULT_DEDUP_WINDOW_MS`] |
//! | `DEDUP_CLEANUP_INTERVAL_MS = 30_000` (`push.ts:9`) | [`DEDUP_CLEANUP_INTERVAL_MS`] |
//! | `RATE_LIMIT_WINDOW_MS = 60_000` (`push.ts:10`) | [`RATE_LIMIT_WINDOW_MS`] |
//! | `DeliveryResult` (`push.ts:12-18`) | [`DeliveryResult`] |
//! | `PushRequest` (`push.ts:20-37`) | [`PushRequest`] |
//! | `PushServiceOptions` (`push.ts:39-59`) | [`PushServiceConfig`] |
//! | `PushService.sendOrDeliver` (`push.ts:105-205`) | [`PushService::send_or_deliver`] |
//! | `PushService.cleanupDedup` (`push.ts:222-234`) | [`PushService::run_cleanup`] |
//! | `PushService.rateLimitEntryCount` (`push.ts:237-239`) | [`PushService::rate_limit_entry_count`] |
//! | `PushService.runCleanup` (`push.ts:242-244`) | [`PushService::run_cleanup`] |
//! | `PushService.dispose` (`push.ts:247-249`) | [`PushServiceHandle`] drop |
//!
//! ## `sendOrDeliver` precedence (parity with `push.ts:105-205`)
//!
//! 1. `isFrontendConnected` → [`DeliveryResult::Ws`] (skip push entirely).
//! 2. Dedup check — key `"<frontendId>:<sid>:<event>"`. If seen within the
//!    dedup window → [`DeliveryResult::Deduped`]. NOT recorded yet.
//! 3. Rate-limit check — key `"<daemonId>:<frontendId>"`. M14 fix: if an
//!    existing window has expired, reset count=0 and windowStart=now BEFORE
//!    checking. If count ≥ limit → [`DeliveryResult::RateLimited`]. NOT
//!    incremented yet.
//! 4. No APNs client → [`DeliveryResult::Error`].
//! 5. `apns.send(...)`. `!ok && deadToken` → [`DeliveryResult::DeadToken`];
//!    `!ok` → [`DeliveryResult::Error`].
//! 6. **Only on success**: record dedup timestamp + increment/create rate entry.
//!    → [`DeliveryResult::Push`].
//!    `catch`/err → [`DeliveryResult::Error`].
//!
//! ## Eviction / leak semantics (parity with `push.ts:222-234`)
//!
//! Dedup entries are evicted when `now - seenAt >= dedupWindow`.
//! Rate-limit entries are evicted when `now - windowStart >= rateLimitWindow`
//! **regardless of count** — the M14 leak fix. An expired window has no live
//! budget; the next push re-creates the entry. Evicting only on count==0 (the
//! old behaviour) leaked: a silent frontend that hit the limit kept its entry
//! forever because `sendOrDeliver` (which resets count) never ran again.
//!
//! ## Time injection
//!
//! All `now_ms` values are supplied by a [`Clock`] trait (`fn now_ms() → u64`).
//! Tests inject [`FakeClock`], which is a shared `Arc<AtomicU64>` that tests
//! advance manually. Production code uses [`SystemClock`], which wraps
//! `std::time::SystemTime::now()`. No `Instant`/`SystemTime` calls appear in
//! pure logic functions.
//!
//! ## Background cleanup
//!
//! [`PushService::start`] spawns a Tokio interval task (30-second period) that
//! calls `run_cleanup` on every tick. A [`PushServiceHandle`] is returned whose
//! `Drop` impl sends a shutdown signal to the task. Tests call
//! [`PushService::run_cleanup`] directly with a controlled clock instead of
//! relying on the background task.
//!
//! ## Security
//!
//! Device tokens and seal secrets never appear in log output. Only
//! `frontendId`/`daemonId` identifiers are logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::apns::{ApnsClient, ApnsDeliveryResult, ApnsPayload};

// ── Defaults (parity with push.ts:7-10) ─────────────────────────────────────

/// Default push-rate budget per window (`DEFAULT_RATE_LIMIT_PER_MINUTE`,
/// `push.ts:7`).
pub const DEFAULT_RATE_LIMIT_PER_MINUTE: u64 = 5;

/// Default dedup window in milliseconds (`DEFAULT_DEDUP_WINDOW_MS`, `push.ts:8`).
pub const DEFAULT_DEDUP_WINDOW_MS: u64 = 60_000;

/// Background cleanup interval in milliseconds (`DEDUP_CLEANUP_INTERVAL_MS`,
/// `push.ts:9`).
pub const DEDUP_CLEANUP_INTERVAL_MS: u64 = 30_000;

/// Rate-limit sliding window in milliseconds (`RATE_LIMIT_WINDOW_MS`,
/// `push.ts:10`).
pub const RATE_LIMIT_WINDOW_MS: u64 = 60_000;

// ── DeliveryResult ────────────────────────────────────────────────────────────

/// Outcome of a single [`PushService::send_or_deliver`] call.
///
/// Mirrors `DeliveryResult` (`push.ts:12-18`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryResult {
    /// Frontend WebSocket was connected; push skipped (`"ws"`).
    Ws,
    /// APNs push delivered successfully (`"push"`).
    Push,
    /// Per-frontend push budget exceeded within the rate-limit window (`"rate_limited"`).
    RateLimited,
    /// Request deduplicated within the dedup window (`"deduped"`).
    Deduped,
    /// Transient or configuration error (`"error"`).
    Error,
    /// APNs reported a dead token (`"dead_token"`); caller should evict it.
    DeadToken,
}

// ── PushRequest ───────────────────────────────────────────────────────────────

/// Data required for a single push-or-deliver decision.
///
/// Mirrors `PushRequest` (`push.ts:20-37`).
#[derive(Debug, Clone)]
pub struct PushRequest {
    /// Frontend ID (used as dedup key component and rate-limit key component).
    pub frontend_id: String,
    /// Daemon ID (used as rate-limit key component).
    pub daemon_id: String,
    /// Hex-encoded APNs device token.
    pub token: String,
    /// Push title.
    pub title: String,
    /// Push body.
    pub body: String,
    /// Whether the frontend's WebSocket is currently connected.
    pub is_frontend_connected: bool,
    /// Optional iOS interruption level forwarded to APNs.
    pub interruption_level: Option<String>,
    /// Optional data payload for dedup key (`sid`, `event`) and APNs forwarding.
    pub data: Option<PushData>,
}

/// Navigation/data payload attached to a push request.
///
/// Mirrors the `data` field in `PushRequest` (`push.ts:36`).
#[derive(Debug, Clone)]
pub struct PushData {
    pub sid: String,
    pub daemon_id: String,
    pub event: String,
}

// ── Clock trait ───────────────────────────────────────────────────────────────

/// Injectable clock — returns the current time as Unix epoch milliseconds.
///
/// Injected so the dedup/rate-limit math is fully deterministic in tests.
/// Production code uses [`SystemClock`]; tests use [`FakeClock`].
pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

/// Real system clock backed by `std::time::SystemTime`.
#[derive(Clone, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    #[allow(clippy::cast_possible_truncation)]
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

/// Fake clock for deterministic tests — wraps an `Arc<std::sync::atomic::AtomicU64>`
/// so multiple references see the same time.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct FakeClock(Arc<std::sync::atomic::AtomicU64>);

#[cfg(test)]
impl FakeClock {
    #[must_use]
    pub fn new(initial_ms: u64) -> Self {
        Self(Arc::new(std::sync::atomic::AtomicU64::new(initial_ms)))
    }

    /// Advance the clock by `delta` milliseconds.
    pub fn advance(&self, delta_ms: u64) {
        self.0
            .fetch_add(delta_ms, std::sync::atomic::Ordering::SeqCst);
    }

    /// Set the clock to an absolute value.
    pub fn set(&self, ms: u64) {
        self.0.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

// ── Internal state ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RateLimitEntry {
    count: u64,
    window_start: u64,
}

/// Inner state protected by a single `Mutex` — `send_or_deliver` holds it only
/// during the synchronous guard checks (not across the `await` on `apns.send`).
struct Inner {
    /// `"<frontendId>:<sid>:<event>"` → timestamp of first seen (ms).
    /// Mirrors `dedupSeen` (`push.ts:76`).
    dedup_seen: HashMap<String, u64>,
    /// `"<daemonId>:<frontendId>"` → rate-limit state.
    /// Mirrors `rateLimits` (`push.ts:73`).
    rate_limits: HashMap<String, RateLimitEntry>,
}

impl Inner {
    fn new() -> Self {
        Self {
            dedup_seen: HashMap::new(),
            rate_limits: HashMap::new(),
        }
    }
}

// ── PushServiceConfig ─────────────────────────────────────────────────────────

/// Configuration for [`PushService`].
///
/// Mirrors `PushServiceOptions` (`push.ts:39-59`).
pub struct PushServiceConfig {
    /// Max pushes per `rate_limit_window_ms` per `daemonId:frontendId` pair.
    pub rate_limit_per_minute: u64,
    /// Window in which duplicate `frontendId:sid:event` triples are suppressed.
    pub dedup_window_ms: u64,
    /// Duration of each rate-limit window in milliseconds.
    pub rate_limit_window_ms: u64,
    /// Optional APNs delivery client. `None` → push delivery returns `Error`.
    pub apns_client: Option<Arc<ApnsClient>>,
}

impl Default for PushServiceConfig {
    fn default() -> Self {
        Self {
            rate_limit_per_minute: DEFAULT_RATE_LIMIT_PER_MINUTE,
            dedup_window_ms: DEFAULT_DEDUP_WINDOW_MS,
            rate_limit_window_ms: RATE_LIMIT_WINDOW_MS,
            apns_client: None,
        }
    }
}

// ── PushServiceHandle ─────────────────────────────────────────────────────────

/// Handle returned by [`PushService::start`].
///
/// Dropping this handle signals the background cleanup task to shut down,
/// mirroring `PushService.dispose()` (`push.ts:247-249`).
pub struct PushServiceHandle {
    _shutdown_tx: oneshot::Sender<()>,
}

// ── PushService ───────────────────────────────────────────────────────────────

/// WebSocket-priority push orchestrator with dedup and rate-limit guards.
///
/// Mirrors `PushService` (`push.ts:66-249`).
pub struct PushService<C: Clock = SystemClock> {
    rate_limit_per_minute: u64,
    dedup_window_ms: u64,
    rate_limit_window_ms: u64,
    apns_client: Option<Arc<ApnsClient>>,
    clock: C,
    inner: Mutex<Inner>,
}

impl PushService<SystemClock> {
    /// Build a [`PushService`] with a real system clock.
    ///
    /// Mirrors `new PushService(options)` (`push.ts:80-103`).
    #[must_use]
    pub fn new(config: PushServiceConfig) -> Self {
        Self::with_clock(config, SystemClock)
    }

    /// Build the service and spawn the 30-second background cleanup task.
    ///
    /// Returns the shared [`Arc<PushService>`] and a [`PushServiceHandle`]
    /// whose `Drop` cancels the cleanup task.
    ///
    /// Mirrors the `setInterval(cleanupDedup, DEDUP_CLEANUP_INTERVAL_MS)`
    /// (`push.ts:96-102`) + `unref()`.
    #[must_use]
    pub fn start(config: PushServiceConfig) -> (Arc<Self>, PushServiceHandle) {
        let svc = Arc::new(Self::new(config));
        let svc_weak = Arc::downgrade(&svc);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let interval_ms = DEDUP_CLEANUP_INTERVAL_MS;
            let mut shutdown = std::pin::pin!(shutdown_rx);
            loop {
                let tick = tokio::time::sleep(std::time::Duration::from_millis(interval_ms));
                tokio::select! {
                    _ = &mut shutdown => break,
                    () = tick => {
                        if let Some(svc) = svc_weak.upgrade() {
                            svc.run_cleanup();
                        } else {
                            break;
                        }
                    }
                }
            }
        });

        (
            svc,
            PushServiceHandle {
                _shutdown_tx: shutdown_tx,
            },
        )
    }
}

impl<C: Clock> PushService<C> {
    /// Build with an injected clock (for tests).
    #[must_use]
    pub fn with_clock(config: PushServiceConfig, clock: C) -> Self {
        Self {
            rate_limit_per_minute: config.rate_limit_per_minute,
            dedup_window_ms: config.dedup_window_ms,
            rate_limit_window_ms: config.rate_limit_window_ms,
            apns_client: config.apns_client,
            clock,
            inner: Mutex::new(Inner::new()),
        }
    }

    /// Attempt WebSocket delivery (no-op check) then APNs push, with dedup and
    /// rate-limiting guards.
    ///
    /// Exactly mirrors the `sendOrDeliver` precedence in `push.ts:105-205`.
    ///
    /// The `Mutex` is locked for the guard phase, released before `apns.send`,
    /// then re-locked to commit dedup+rate state only on success.
    ///
    /// # Panics
    ///
    /// Panics if the inner `Mutex` is poisoned (a previous thread panicked while
    /// holding the lock — should never happen in production).
    pub async fn send_or_deliver(&self, req: &PushRequest) -> DeliveryResult {
        let rate_limit_key = format!("{}:{}", req.daemon_id, req.frontend_id);

        // ── Step 1: WebSocket takes priority (`push.ts:119-122`) ────────────
        if req.is_frontend_connected {
            return DeliveryResult::Ws;
        }

        let now = self.clock.now_ms();

        // ── Steps 2-4: guard checks (lock, no await) ─────────────────────────
        {
            let mut inner = self.inner.lock().expect("PushService inner mutex poisoned");

            // Step 2: dedup check (`push.ts:127-134`). NOT recorded yet.
            if let Some(data) = &req.data {
                let dedup_key = format!("{}:{}:{}", req.frontend_id, data.sid, data.event);
                if let Some(&seen_at) = inner.dedup_seen.get(&dedup_key) {
                    if now.saturating_sub(seen_at) < self.dedup_window_ms {
                        return DeliveryResult::Deduped;
                    }
                }
            }

            // Step 3: rate-limit check (`push.ts:136-151`). M14 fix: reset
            // expired window BEFORE the count check. NOT incremented yet.
            if let Some(rl) = inner.rate_limits.get_mut(&rate_limit_key) {
                if now.saturating_sub(rl.window_start) >= self.rate_limit_window_ms {
                    // Window expired — reset to a fresh window (`push.ts:143-147`).
                    rl.count = 0;
                    rl.window_start = now;
                }
            }
            let over_limit = inner
                .rate_limits
                .get(&rate_limit_key)
                .is_some_and(|rl| rl.count >= self.rate_limit_per_minute);
            if over_limit {
                return DeliveryResult::RateLimited;
            }

            // Step 4: APNs client must be configured (`push.ts:153-158`).
            if self.apns_client.is_none() {
                return DeliveryResult::Error;
            }
        } // ← mutex released before await

        // ── Step 5: call APNs (`push.ts:161-183`) ─────────────────────────
        let apns_client = match &self.apns_client {
            Some(c) => Arc::clone(c),
            None => return DeliveryResult::Error,
        };

        let mut apns_data: Option<std::collections::HashMap<String, String>> = None;
        if let Some(data) = &req.data {
            let mut m = std::collections::HashMap::new();
            m.insert("sid".to_owned(), data.sid.clone());
            m.insert("daemonId".to_owned(), data.daemon_id.clone());
            m.insert("event".to_owned(), data.event.clone());
            apns_data = Some(m);
        }

        let payload = ApnsPayload {
            device_token: req.token.clone(),
            title: req.title.clone(),
            body: req.body.clone(),
            interruption_level: req.interruption_level.clone(),
            data: apns_data,
        };

        let apns_result = apns_client.send(&payload).await;

        match apns_result {
            ApnsDeliveryResult::Err {
                dead_token: true, ..
            } => {
                return DeliveryResult::DeadToken;
            }
            ApnsDeliveryResult::Err {
                dead_token: false, ..
            } => {
                return DeliveryResult::Error;
            }
            ApnsDeliveryResult::Ok => {}
        }

        // ── Step 6: commit dedup + rate-limit ONLY on success (`push.ts:186-198`)
        {
            let mut inner = self.inner.lock().expect("PushService inner mutex poisoned");
            let now2 = self.clock.now_ms();

            if let Some(data) = &req.data {
                let dedup_key = format!("{}:{}:{}", req.frontend_id, data.sid, data.event);
                inner.dedup_seen.insert(dedup_key, now2);
            }

            let rl = inner
                .rate_limits
                .entry(rate_limit_key)
                .or_insert(RateLimitEntry {
                    count: 0,
                    window_start: now2,
                });
            rl.count += 1;
        }

        DeliveryResult::Push
    }

    /// Run one cleanup pass — evict stale dedup entries and expired rate-limit
    /// windows.
    ///
    /// Mirrors `cleanupDedup` (`push.ts:222-234`) + `runCleanup` (`push.ts:242-244`).
    ///
    /// ## Eviction semantics
    ///
    /// - **Dedup**: entry evicted when `now - seenAt >= dedupWindow`.
    /// - **Rate-limit**: entry evicted when `now - windowStart >= rateLimitWindow`
    ///   **regardless of count** (M14 leak fix — `push.ts:228-233` comment).
    ///
    /// # Panics
    ///
    /// Panics if the inner `Mutex` is poisoned.
    pub fn run_cleanup(&self) {
        let now = self.clock.now_ms();
        let mut inner = self.inner.lock().expect("PushService inner mutex poisoned");

        inner
            .dedup_seen
            .retain(|_, &mut seen_at| now.saturating_sub(seen_at) < self.dedup_window_ms);

        inner
            .rate_limits
            .retain(|_, rl| now.saturating_sub(rl.window_start) < self.rate_limit_window_ms);
    }

    /// Number of live rate-limit entries (for leak tests).
    ///
    /// Mirrors `rateLimitEntryCount()` (`push.ts:237-239`).
    ///
    /// # Panics
    ///
    /// Panics if the inner `Mutex` is poisoned.
    #[must_use]
    pub fn rate_limit_entry_count(&self) -> usize {
        self.inner
            .lock()
            .expect("PushService inner mutex poisoned")
            .rate_limits
            .len()
    }

    /// Number of live dedup entries (for tests).
    ///
    /// # Panics
    ///
    /// Panics if the inner `Mutex` is poisoned.
    #[must_use]
    pub fn dedup_entry_count(&self) -> usize {
        self.inner
            .lock()
            .expect("PushService inner mutex poisoned")
            .dedup_seen
            .len()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apns::{ApnsClientConfig, TransportDyn, TransportRequest, TransportResponse};
    use crate::apns_jwt::ApnsSigner;
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePrivateKey;
    use std::sync::Mutex as StdMutex;

    // ── FakeApnsTransport ─────────────────────────────────────────────────────

    /// A fake APNs transport that returns a pre-programmed sequence of responses.
    struct FakeApnsTransport {
        responses: StdMutex<Vec<TransportResponse>>,
    }

    impl FakeApnsTransport {
        fn new(responses: Vec<TransportResponse>) -> Self {
            Self {
                responses: StdMutex::new(responses),
            }
        }
    }

    impl TransportDyn for FakeApnsTransport {
        fn post_dyn(
            &self,
            _req: TransportRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<TransportResponse, String>> + Send>,
        > {
            let resp = {
                let mut q = self.responses.lock().unwrap();
                if q.len() > 1 {
                    q.remove(0)
                } else {
                    q[0].clone()
                }
            };
            Box::pin(async move { Ok(resp) })
        }
    }

    fn ok_transport() -> Box<dyn TransportDyn> {
        Box::new(FakeApnsTransport::new(vec![TransportResponse {
            status: 200,
            retry_after: None,
            body: vec![],
        }]))
    }

    fn dead_token_transport() -> Box<dyn TransportDyn> {
        Box::new(FakeApnsTransport::new(vec![TransportResponse {
            status: 400,
            retry_after: None,
            body: serde_json::to_vec(&serde_json::json!({ "reason": "BadDeviceToken" })).unwrap(),
        }]))
    }

    fn error_transport() -> Box<dyn TransportDyn> {
        Box::new(FakeApnsTransport::new(vec![TransportResponse {
            status: 500,
            retry_after: None,
            body: serde_json::to_vec(&serde_json::json!({ "reason": "ServiceUnavailable" }))
                .unwrap(),
        }]))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn throwaway_pem() -> String {
        let sk = SigningKey::random(&mut rand_core::OsRng);
        sk.to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .expect("p256 to_pkcs8_pem")
            .to_string()
    }

    fn make_signer() -> ApnsSigner {
        ApnsSigner::new(
            crate::apns_jwt::ApnsKey::Pem(throwaway_pem()),
            "KID123".into(),
            "TEAM456".into(),
        )
    }

    fn make_apns_client(transport: Box<dyn TransportDyn>) -> Arc<ApnsClient> {
        Arc::new(ApnsClient::new(
            ApnsClientConfig {
                host: "api.push.apple.com".into(),
                bundle_id: "dev.tpmt.teleprompter".into(),
                max_retries: 0, // no retries in tests — faster
                retry_base_ms: 1,
            },
            make_signer(),
            transport,
            Box::new(crate::apns::tests::NoopSleeper::new()),
        ))
    }

    fn make_service(clock: FakeClock, apns: Option<Arc<ApnsClient>>) -> PushService<FakeClock> {
        PushService::with_clock(
            PushServiceConfig {
                rate_limit_per_minute: DEFAULT_RATE_LIMIT_PER_MINUTE,
                dedup_window_ms: DEFAULT_DEDUP_WINDOW_MS,
                rate_limit_window_ms: RATE_LIMIT_WINDOW_MS,
                apns_client: apns,
            },
            clock,
        )
    }

    fn base_req() -> PushRequest {
        PushRequest {
            frontend_id: "fe-1".into(),
            daemon_id: "daemon-1".into(),
            token: "deadbeef".into(),
            title: "Hello".into(),
            body: "World".into(),
            is_frontend_connected: false,
            interruption_level: None,
            data: Some(PushData {
                sid: "sess-abc".into(),
                daemon_id: "daemon-1".into(),
                event: "tool_result".into(),
            }),
        }
    }

    // ── Test 1: WS-priority returns Ws without calling APNs ──────────────────

    #[tokio::test]
    async fn ws_priority_skips_apns() {
        // Even with a valid APNs client, a connected frontend returns Ws.
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock, Some(make_apns_client(ok_transport())));
        let mut req = base_req();
        req.is_frontend_connected = true;
        let result = svc.send_or_deliver(&req).await;
        assert_eq!(
            result,
            DeliveryResult::Ws,
            "connected frontend must return Ws"
        );
    }

    // ── Test 2: dedup within window → Deduped only after a successful push ────

    #[tokio::test]
    async fn dedup_only_after_successful_push() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock.clone(), Some(make_apns_client(ok_transport())));
        let req = base_req();

        // First send → Push.
        let r1 = svc.send_or_deliver(&req).await;
        assert_eq!(r1, DeliveryResult::Push, "first send must be Push");

        // Same key within window → Deduped.
        let r2 = svc.send_or_deliver(&req).await;
        assert_eq!(
            r2,
            DeliveryResult::Deduped,
            "duplicate within window must be Deduped"
        );
    }

    // ── Test 3: no dedup if first push failed ─────────────────────────────────

    #[tokio::test]
    async fn no_dedup_after_failed_push() {
        let clock = FakeClock::new(1_000_000);
        // Service with APNs client that always errors.
        let svc = make_service(clock, Some(make_apns_client(error_transport())));
        let req = base_req();

        let r1 = svc.send_or_deliver(&req).await;
        assert_eq!(
            r1,
            DeliveryResult::Error,
            "error transport must return Error"
        );

        // No dedup recorded — next send must NOT be Deduped.
        let r2 = svc.send_or_deliver(&req).await;
        assert_ne!(
            r2,
            DeliveryResult::Deduped,
            "failed push must not record dedup"
        );
    }

    // ── Test 4: rate-limit at 6th in a window → RateLimited ──────────────────

    #[tokio::test]
    async fn rate_limit_at_sixth_in_window() {
        let clock = FakeClock::new(1_000_000);
        // Use a fresh daemon/frontend pair to avoid dedup interference.
        let svc = make_service(clock.clone(), Some(make_apns_client(ok_transport())));

        // Build a request with distinct events so dedup doesn't fire.
        let make_req = |event: &str| PushRequest {
            frontend_id: "fe-rl".into(),
            daemon_id: "daemon-rl".into(),
            token: "tok".into(),
            title: "T".into(),
            body: "B".into(),
            is_frontend_connected: false,
            interruption_level: None,
            data: Some(PushData {
                sid: "s1".into(),
                daemon_id: "daemon-rl".into(),
                event: event.to_owned(),
            }),
        };

        // Each send uses a different event string so dedup never fires.
        // First 5 must succeed.
        for i in 0..DEFAULT_RATE_LIMIT_PER_MINUTE {
            let r = svc.send_or_deliver(&make_req(&format!("ev-{i}"))).await;
            assert_eq!(r, DeliveryResult::Push, "send {i} must be Push");
        }

        // 6th send → RateLimited.
        let r = svc.send_or_deliver(&make_req("ev-5")).await;
        assert_eq!(
            r,
            DeliveryResult::RateLimited,
            "6th send must be RateLimited"
        );
    }

    // ── Test 5: expired window resets ────────────────────────────────────────

    #[tokio::test]
    async fn rate_limit_window_resets_after_expiry() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock.clone(), Some(make_apns_client(ok_transport())));

        let make_req = |event: &str| PushRequest {
            frontend_id: "fe-reset".into(),
            daemon_id: "daemon-reset".into(),
            token: "tok".into(),
            title: "T".into(),
            body: "B".into(),
            is_frontend_connected: false,
            interruption_level: None,
            data: Some(PushData {
                sid: "s1".into(),
                daemon_id: "daemon-reset".into(),
                event: event.to_owned(),
            }),
        };

        // Fill up the window.
        for i in 0..DEFAULT_RATE_LIMIT_PER_MINUTE {
            let r = svc.send_or_deliver(&make_req(&format!("fill-{i}"))).await;
            assert_eq!(r, DeliveryResult::Push);
        }
        // 6th → RateLimited.
        let r = svc.send_or_deliver(&make_req("over")).await;
        assert_eq!(r, DeliveryResult::RateLimited);

        // Advance clock past the window → next send starts a fresh window.
        clock.advance(RATE_LIMIT_WINDOW_MS + 1);

        let r2 = svc.send_or_deliver(&make_req("after-reset")).await;
        assert_eq!(
            r2,
            DeliveryResult::Push,
            "after window expiry, push must succeed"
        );
    }

    // ── Test 6: dead token from APNs → DeadToken ──────────────────────────────

    #[tokio::test]
    async fn dead_token_from_apns_returns_dead_token() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock, Some(make_apns_client(dead_token_transport())));
        let result = svc.send_or_deliver(&base_req()).await;
        assert_eq!(result, DeliveryResult::DeadToken);
    }

    // ── Test 7: APNs error → Error ────────────────────────────────────────────

    #[tokio::test]
    async fn apns_error_returns_error() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock, Some(make_apns_client(error_transport())));
        let result = svc.send_or_deliver(&base_req()).await;
        assert_eq!(result, DeliveryResult::Error);
    }

    // ── Test 8: no APNs client → Error ───────────────────────────────────────

    #[tokio::test]
    async fn no_apns_client_returns_error() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock, None);
        let result = svc.send_or_deliver(&base_req()).await;
        assert_eq!(result, DeliveryResult::Error);
    }

    // ── Test 9: LEAK — expired rate-limit entry evicted by cleanup ────────────
    //
    // A frontend that hits the rate limit and then goes silent must have its
    // entry evicted on window-expiry cleanup.  Evicting only on count==0 (old
    // behaviour) would leak because sendOrDeliver is never called again for a
    // silent frontend.  Parity with `push.ts:228-233`.

    #[tokio::test]
    async fn leak_free_eviction_on_window_expiry() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock.clone(), Some(make_apns_client(ok_transport())));

        let make_req = |event: &str| PushRequest {
            frontend_id: "fe-leak".into(),
            daemon_id: "daemon-leak".into(),
            token: "tok".into(),
            title: "T".into(),
            body: "B".into(),
            is_frontend_connected: false,
            interruption_level: None,
            data: Some(PushData {
                sid: "s1".into(),
                daemon_id: "daemon-leak".into(),
                event: event.to_owned(),
            }),
        };

        // Exhaust the rate limit.
        for i in 0..DEFAULT_RATE_LIMIT_PER_MINUTE {
            let r = svc.send_or_deliver(&make_req(&format!("ev-{i}"))).await;
            assert_eq!(r, DeliveryResult::Push);
        }
        // Confirm entry exists.
        assert_eq!(
            svc.rate_limit_entry_count(),
            1,
            "entry must exist after pushes"
        );

        // Frontend goes silent — no more sends.  Advance past window.
        clock.advance(RATE_LIMIT_WINDOW_MS + 1);

        // Cleanup pass should evict the expired entry.
        svc.run_cleanup();
        assert_eq!(
            svc.rate_limit_entry_count(),
            0,
            "expired entry must be evicted by cleanup"
        );
    }

    // ── Test 10: dedup entry evicted after dedup window ───────────────────────

    #[tokio::test]
    async fn dedup_entry_evicted_after_window() {
        let clock = FakeClock::new(1_000_000);
        let svc = make_service(clock.clone(), Some(make_apns_client(ok_transport())));
        let req = base_req();

        // First send records dedup entry.
        let r = svc.send_or_deliver(&req).await;
        assert_eq!(r, DeliveryResult::Push);
        assert_eq!(svc.dedup_entry_count(), 1);

        // Advance past dedup window and run cleanup.
        clock.advance(DEFAULT_DEDUP_WINDOW_MS + 1);
        svc.run_cleanup();
        assert_eq!(
            svc.dedup_entry_count(),
            0,
            "dedup entry must be evicted after window"
        );

        // Now same key is accepted again.
        let r2 = svc.send_or_deliver(&req).await;
        assert_eq!(
            r2,
            DeliveryResult::Push,
            "after dedup eviction, push must succeed again"
        );
    }
}
