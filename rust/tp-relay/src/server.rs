//! Async relay server — central shared state + synchronous routing decisions.
//!
//! This is the Step 4 WebSocket hot path. The architecture is the
//! **central-state / no-lock-across-await** model:
//!
//! 1. Every connection owns a bounded `mpsc::Sender<RelayServerMessage>` (its
//!    "outbox"). A dedicated write task drains the receiver into the socket.
//! 2. All shared mutable state (registry, recent-frame ring, daemon groups, the
//!    conn table) lives behind ONE `std::sync::Mutex<RelayCore>`.
//! 3. Inbound frames are routed **synchronously** under that lock: the lock is
//!    acquired, a routing decision produces a `Vec<Action>` (conn-id + message
//!    pairs, plus side effects like "close this conn"), and the lock is released
//!    **before** any `.await`. Delivery (`try_send` into each target outbox) is
//!    then performed without the lock held.
//!
//! The non-negotiable invariant: **the `RelayCore` mutex guard is never held
//! across an `.await`.** Every critical section in this file is a synchronous
//! block that returns owned data (`Vec<Action>`) and drops the guard at the end
//! of the block. See the module-level SELF-AUDIT note on each `lock()` site.
//!
//! Wire format is **plain-text JSON** (`Message::Text(serde_json::to_string)`),
//! matching `relay-server.ts:618` (`ws.send(JSON.stringify(msg))`). The relay
//! never length-prefixes the WS payload — the `tp_core` u32-frame codec is for
//! IPC only.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::messages::{Frame, KeyExchangeFrame, Pong, Presence, RelayErr, RelayServerMessage};
use crate::metrics::Metrics;
use crate::rate::{rate_per_client_from_env, rate_per_daemon_from_env, Limiter};
use crate::registry::Registry;
use crate::resume_token::ResumeTokenSigner;
use crate::ring::RecentFrames;
use tp_proto::relay_client::Role;

/// Default bounded-outbox capacity per connection. When the write task cannot
/// drain fast enough and the channel fills, `try_send` returns `Full` and the
/// connection is closed with code 1013 (mirrors the TS slow-consumer disconnect
/// at `relay-server.ts:611`, `bufferedAmount > backpressureBytes` → `close(1013)`).
pub const DEFAULT_OUTBOX_CAP: usize = 512;

/// Max subscriptions a single client may hold. Mirrors
/// `MAX_SUBSCRIPTIONS_PER_CLIENT` (`relay-server.ts`); enforced in
/// [`route_subscribe`].
pub const MAX_SUBSCRIPTIONS_PER_CLIENT: usize = 256;

/// Connection identifier. Assigned from a monotonic [`AtomicU64`] on upgrade.
pub type ConnId = u64;

/// Current epoch-ms (the relay clock). Uses `SystemTime`, not `chrono`.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

// ── Per-connection state held inside RelayCore ────────────────────────────────

/// The authenticated identity of a connection. `None` until `relay.auth` /
/// `relay.auth.resume` succeeds. Mirrors the `ConnectedClient` fields
/// (`relay-server.ts` `ConnectedClient`): role + daemonId + (frontend only)
/// frontendId + the per-socket subscription set.
#[derive(Debug, Clone)]
pub struct AuthState {
    /// `daemon` or `frontend`.
    pub role: Role,
    /// The daemon this connection belongs to (its group key).
    pub daemon_id: String,
    /// Present only for `role == Frontend`. Carried on forwarded frames.
    pub frontend_id: Option<String>,
    /// Per-socket subscription set (`ConnectedClient.subscriptions`). Routing
    /// fan-out only delivers a `relay.pub` to peers whose set contains the sid.
    pub subscriptions: HashSet<String>,
}

/// One connection's server-side handle: its outbox sender, per-client rate
/// limiter, the shared per-daemon-group limiter (set on auth), and auth state.
pub struct ConnHandle {
    /// Bounded outbox. The write task owns the matching receiver.
    pub outbox: mpsc::Sender<RelayServerMessage>,
    /// Out-of-band close signal `(code, reason)`. The conn's write task selects
    /// on this and emits a WS `Close` frame before terminating. Used by the
    /// backpressure path (1013) to force a slow consumer's socket shut even when
    /// its read loop is otherwise idle.
    pub close_tx: mpsc::Sender<(u16, String)>,
    /// Per-socket GCRA limiter (always present, even pre-auth — though pre-auth
    /// frames other than the handshake are not rate-checked, matching TS which
    /// only rate-checks once `clients.get(ws)` is set).
    pub client_limiter: Arc<Limiter>,
    /// Shared per-daemon-group limiter — `Some` once authenticated (cloned from
    /// the group entry). `None` while unauthenticated.
    pub group_limiter: Option<Arc<Limiter>>,
    /// `None` until authenticated.
    pub auth: Option<AuthState>,
    /// Number of frames received while unauthenticated. Incremented on every
    /// inbound frame before parse while `auth.is_none()`. The connection is
    /// closed with 1008 once this exceeds `SharedState::max_preauth_msgs`.
    /// Mirrors `relay-server.ts:742-754` pre-auth frame throttle.
    pub preauth_count: u32,
}

impl ConnHandle {
    pub(crate) fn new(
        outbox: mpsc::Sender<RelayServerMessage>,
        close_tx: mpsc::Sender<(u16, String)>,
        per_client_rate: u32,
    ) -> Self {
        Self {
            outbox,
            close_tx,
            client_limiter: Arc::new(Limiter::per_second(per_client_rate)),
            group_limiter: None,
            auth: None,
            preauth_count: 0,
        }
    }
}

// ── RelayCore: all shared mutable state ───────────────────────────────────────

/// All shared mutable relay state. Held behind a single `Mutex` in
/// [`SharedState`]. Routing decisions read/mutate this synchronously and emit a
/// `Vec<Action>`; the lock is released before any delivery `.await`.
pub struct RelayCore {
    /// Connection registry (daemon states, registrations, valid tokens).
    pub registry: Registry,
    /// Per-`"daemonId:sid"` recent-frame ring (replay cache).
    pub recent: RecentFrames,
    /// `daemonId → set of ConnIds in the group` (daemon + all its frontends).
    /// Mirrors `daemonGroups: Map<daemonId, Set<ws>>` (`relay-server.ts:245`).
    pub groups: HashMap<String, HashSet<ConnId>>,
    /// `ConnId → ConnHandle`.
    pub conns: HashMap<ConnId, ConnHandle>,
    /// Per-daemon-group GCRA limiters, keyed by `daemon_id`. Shared across the
    /// daemon socket and every frontend in its group.
    pub group_limiters: HashMap<String, Arc<Limiter>>,
    /// Resolved per-client rate (cells/sec).
    pub rate_per_client: u32,
    /// Resolved per-daemon-group rate (cells/sec).
    pub rate_per_daemon: u32,
}

impl RelayCore {
    pub(crate) fn new(
        recent: RecentFrames,
        rate_per_client: u32,
        rate_per_daemon: u32,
        max_registrations: usize,
    ) -> Self {
        Self {
            registry: Registry::with_max_registrations(max_registrations),
            recent,
            groups: HashMap::new(),
            conns: HashMap::new(),
            group_limiters: HashMap::new(),
            rate_per_client,
            rate_per_daemon,
        }
    }

    /// Fetch-or-create the shared group limiter for `daemon_id`.
    fn group_limiter_for(&mut self, daemon_id: &str) -> Arc<Limiter> {
        let rate = self.rate_per_daemon;
        Arc::clone(
            self.group_limiters
                .entry(daemon_id.to_string())
                .or_insert_with(|| Arc::new(Limiter::per_second(rate))),
        )
    }

    /// Add a connection to its daemon group (idempotent set insert).
    fn add_to_group(&mut self, daemon_id: &str, conn_id: ConnId) {
        self.groups
            .entry(daemon_id.to_string())
            .or_default()
            .insert(conn_id);
    }

    /// Remove a connection from its daemon group; drop the empty group.
    /// Mirrors `relay-server.ts:1266-1272`.
    ///
    /// When the group empties, also drop the shared `group_limiters` entry so it
    /// cannot orphan. This is the last-leaver cleanup that pairs with the
    /// frontends-still-attached retention in `stale_sweep` (conn.rs): if a daemon
    /// is evicted while frontends remain, its `daemon_states` entry is gone
    /// (`evict_daemon`), so the periodic sweep can never see that `daemon_id`
    /// again to remove the limiter — the last frontend to leave must do it here,
    /// or the limiter leaks permanently. Live `ConnHandle`s keep their own `Arc`
    /// clone, so dropping the map's strong ref is safe (no use-after-free).
    fn remove_from_group(&mut self, daemon_id: &str, conn_id: ConnId) {
        if let Some(group) = self.groups.get_mut(daemon_id) {
            group.remove(&conn_id);
            if group.is_empty() {
                self.groups.remove(daemon_id);
                self.group_limiters.remove(daemon_id);
            }
        }
    }
}

// ── Action: a routing decision's output ───────────────────────────────────────

/// A single side effect produced by synchronous routing. Delivered after the
/// `RelayCore` lock is released — never inside the guard scope.
#[derive(Debug)]
pub enum Action {
    /// Send `msg` to the connection's outbox via `try_send`. On `Full`, the
    /// delivery layer marks the conn for a 1013 backpressure close.
    Send(ConnId, RelayServerMessage),
    /// Close `conn_id` with the given WS code + reason (e.g. 1013 backpressure,
    /// 1008 auth timeout). The delivery layer issues the close.
    Close(ConnId, u16, &'static str),
}

// ── SharedState handle ────────────────────────────────────────────────────────

/// Cloneable handle to the shared relay state. Wraps `Arc<Mutex<RelayCore>>`
/// plus the immutable singletons (resume signer, stale/idle/auth timeouts).
#[derive(Clone)]
pub struct SharedState {
    /// The one lock. **Never held across `.await`** — see module docs.
    pub core: Arc<Mutex<RelayCore>>,
    /// Resume-token issuer/verifier (immutable; internally keyed).
    pub signer: Arc<ResumeTokenSigner>,
    /// Stale-detection timeout (ms). Default 90 s.
    pub stale_timeout_ms: u64,
    /// Offline-eviction TTL (ms). Default 1 h.
    pub offline_evict_ms: u64,
    /// Monotonic conn-id source.
    next_conn_id: Arc<AtomicU64>,
    /// Bounded-outbox capacity per conn.
    pub outbox_cap: usize,
    /// Max inbound frame size (bytes). Inbound text frames larger than this are
    /// dropped + counted + the socket closed with 1009 ("Frame too large").
    pub max_frame_size: usize,
    /// Relay capacity counters (`/health` + `/metrics`). Held **outside** the
    /// `RelayCore` mutex (its own `Arc`) so HTTP handlers and emit sites read /
    /// write lock-free atomics without taking the routing lock.
    pub metrics: Arc<Metrics>,
    /// Process-start instant — `/health.uptime` + `relay_uptime_seconds` are
    /// `started_at.elapsed().as_secs()` (`Math.floor(process.uptime())` parity).
    pub started_at: Instant,
    /// APNs push orchestrator. `None` when APNs creds are absent from the env —
    /// the APNs (offline) leg of `relay.push` then becomes a clean no-op (the
    /// daemon's push is fire-and-forget, so silence is the correct unconfigured
    /// behaviour). The in-band leg is independent of this: a connected frontend
    /// still receives `relay.notification` (conn.rs `handle_push` None arm —
    /// TS parity, push.ts step 1 "ws" needs no APNs).
    /// Wrapped in `Arc` (not `PushService` directly) so `#[derive(Clone)]` on
    /// `SharedState` holds — `PushService` is not `Clone`, but `Arc` is.
    pub push_service: Option<Arc<crate::push::PushService>>,
    /// Max number of frames allowed from an unauthenticated connection before it
    /// is closed with 1008. Mirrors `relay-server.ts:742-754`.
    /// Override via `TP_RELAY_MAX_PREAUTH_MSGS` (default 30).
    pub max_preauth_msgs: u32,
}

/// Default stale-detection timeout (ms). Mirrors `STALE_TIMEOUT_MS` (90 s).
pub const DEFAULT_STALE_TIMEOUT_MS: u64 = 90_000;
/// Default offline-eviction TTL (ms). Mirrors `OFFLINE_EVICT_AFTER_MS` (1 h).
pub const DEFAULT_OFFLINE_EVICT_MS: u64 = 3_600_000;
/// Stale-check sweep interval (ms). Mirrors `STALE_CHECK_INTERVAL_MS` (30 s).
pub const STALE_CHECK_INTERVAL_MS: u64 = 30_000;
/// Idle-timeout (s). Mirrors `WS_IDLE_TIMEOUT_S` (90 s). The conn read loop
/// resets an `Interval` on every inbound frame; firing closes the socket.
pub const WS_IDLE_TIMEOUT_S: u64 = 90;
/// Default maximum pre-auth frames per connection. Mirrors
/// `relay-server.ts:742-754` (`unauthFrameCount > MAX_UNAUTH_FRAMES`).
pub const DEFAULT_MAX_PREAUTH_MSGS: u32 = 30;

/// Read `TP_RELAY_MAX_PREAUTH_MSGS`, falling back to [`DEFAULT_MAX_PREAUTH_MSGS`].
#[must_use]
pub fn max_preauth_msgs_from_env() -> u32 {
    std::env::var("TP_RELAY_MAX_PREAUTH_MSGS")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(DEFAULT_MAX_PREAUTH_MSGS)
}

impl SharedState {
    /// Construct from the environment (rate limits, cache size, resume secret).
    #[must_use]
    pub fn from_env() -> Self {
        let recent = RecentFrames::from_env();
        let rate_per_client = rate_per_client_from_env();
        let rate_per_daemon = rate_per_daemon_from_env();
        let max_registrations = Registry::max_registrations_from_env();
        Self {
            core: Arc::new(Mutex::new(RelayCore::new(
                recent,
                rate_per_client,
                rate_per_daemon,
                max_registrations,
            ))),
            signer: Arc::new(ResumeTokenSigner::from_env()),
            stale_timeout_ms: DEFAULT_STALE_TIMEOUT_MS,
            offline_evict_ms: DEFAULT_OFFLINE_EVICT_MS,
            next_conn_id: Arc::new(AtomicU64::new(1)),
            outbox_cap: DEFAULT_OUTBOX_CAP,
            max_frame_size: crate::conn::max_frame_size_from_env(),
            metrics: Arc::new(Metrics::new()),
            started_at: Instant::now(),
            push_service: build_push_service_from_env(),
            max_preauth_msgs: max_preauth_msgs_from_env(),
        }
    }

    /// Test/explicit constructor.
    #[must_use]
    pub fn with_signer(signer: ResumeTokenSigner) -> Self {
        let mut s = Self::from_env();
        s.signer = Arc::new(signer);
        s
    }

    /// Test/explicit constructor with an overridden max inbound frame size. Used
    /// to exercise the oversize guard without depending on a process-global env.
    #[must_use]
    pub fn from_env_with_max_frame_size(max_frame_size: usize) -> Self {
        let mut s = Self::from_env();
        s.max_frame_size = max_frame_size;
        s
    }

    /// Allocate a fresh monotonic [`ConnId`].
    #[must_use]
    pub fn alloc_conn_id(&self) -> ConnId {
        self.next_conn_id.fetch_add(1, Ordering::Relaxed)
    }
}

/// Assemble the APNs-backed [`PushService`] from the environment, or return
/// `None` when the relay has not been given APNs credentials.
///
/// Returns `None` (→ `relay.push` becomes a clean no-op) whenever ANY of the
/// four required vars is unset or empty: `APNS_KEY` (P-256 `.p8` path OR inline
/// PEM), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`. `APNS_ENV`
/// (`sandbox`|`prod`) selects the host; `APNS_MAX_RETRIES` / `APNS_RETRY_BASE_MS`
/// are read inside [`ApnsClientConfig::from_env`].
///
/// Built via [`PushService::new`] (NOT `start`) — `new` skips the 30 s eviction
/// task, so there is no `PushServiceHandle` whose `Drop` would cancel cleanup.
/// The dedup/rate maps stay correct; they simply do not time-evict, an
/// acceptable memory-bound tradeoff for a relay that already bounds connections.
fn build_push_service_from_env() -> Option<Arc<crate::push::PushService>> {
    use crate::apns::{
        resolve_apns_host, ApnsClient, ApnsClientConfig, ReqwestTransport, TokioSleeper,
    };
    use crate::apns_jwt::{ApnsKey, ApnsSigner};
    use crate::push::{PushService, PushServiceConfig};
    use std::env::var;
    use std::path::{Path, PathBuf};

    let nonempty = |k: &str| var(k).ok().filter(|s| !s.is_empty());
    let (Some(key), Some(key_id), Some(team_id), Some(bundle_id)) = (
        nonempty("APNS_KEY"),
        nonempty("APNS_KEY_ID"),
        nonempty("APNS_TEAM_ID"),
        nonempty("APNS_BUNDLE_ID"),
    ) else {
        return None;
    };

    // `.p8` file path vs inline PEM — pick by whether APNS_KEY names a file.
    let apns_key = if Path::new(&key).is_file() {
        ApnsKey::Path(PathBuf::from(&key))
    } else {
        ApnsKey::Pem(key)
    };
    let signer = ApnsSigner::new(apns_key, key_id, team_id);

    let host = resolve_apns_host(var("APNS_ENV").ok().as_deref()).to_string();
    let client_config = ApnsClientConfig::from_env(host, bundle_id);
    let apns_client = ApnsClient::new(
        client_config,
        signer,
        Box::new(ReqwestTransport::new()),
        Box::new(TokioSleeper),
    );

    let cfg = PushServiceConfig {
        apns_client: Some(Arc::new(apns_client)),
        ..PushServiceConfig::default()
    };
    Some(Arc::new(PushService::new(cfg)))
}

// ── Synchronous routing (the no-lock-across-await core) ────────────────────────
//
// Every fn below takes `&mut RelayCore` (i.e. runs UNDER the lock) and returns a
// `Vec<Action>` of owned messages. None of them `.await` — they are pure
// synchronous decision functions. The caller (conn.rs) acquires the lock, calls
// one of these, drops the lock, then delivers the actions.

/// Route a successfully-parsed-and-authenticated `relay.pub`.
///
/// `client` is the SENDER's auth state. Mirrors `handlePublish`
/// (`relay-server.ts:1093-1165`):
/// 1. role=daemon only: `registry.daemon_pub` (adds session + refreshes lastSeen).
/// 2. ALWAYS cache the frame keyed `"daemonId:sid"` (frontend frames carry fid).
/// 3. Forward `relay.frame` to every group peer whose subscriptions contain sid,
///    except the sender.
#[must_use]
pub fn route_publish(
    core: &mut RelayCore,
    sender_id: ConnId,
    client: &AuthState,
    sid: &str,
    ct: &str,
    seq: u64,
    now: u64,
) -> Vec<Action> {
    let daemon_id = client.daemon_id.clone();
    let is_daemon = client.role == Role::Daemon;

    // (1) Daemon-role session tracking + lastSeen refresh (daemon traffic only).
    if is_daemon {
        core.registry.daemon_pub(&daemon_id, sid.to_string(), now);
    }

    // (2) Cache the frame (Arc, shared on fan-out). Frontend frames carry fid.
    let frame = Arc::new(Frame {
        sid: sid.to_string(),
        ct: ct.to_string(),
        seq,
        from: client.role,
        frontend_id: if is_daemon {
            None
        } else {
            client.frontend_id.clone()
        },
    });
    core.recent.push(&daemon_id, Arc::clone(&frame));

    // (3) Fan out to sid-subscribers in the group, except the sender.
    let mut actions = Vec::new();
    let Some(group) = core.groups.get(&daemon_id) else {
        return actions; // group gone → silent (frame still cached)
    };
    // Collect target ids first (cannot borrow conns while iterating groups).
    let targets: Vec<ConnId> = group
        .iter()
        .copied()
        .filter(|&peer_id| peer_id != sender_id)
        .filter(|peer_id| {
            core.conns
                .get(peer_id)
                .and_then(|h| h.auth.as_ref())
                .is_some_and(|a| a.subscriptions.contains(sid))
        })
        .collect();
    for peer_id in targets {
        actions.push(Action::Send(
            peer_id,
            RelayServerMessage::Frame(frame_payload(&frame)),
        ));
    }
    actions
}

/// Build a `Frame` wire payload from a cached `Arc<Frame>`. The frontend arm
/// carries `frontendId`; the daemon arm omits it (mirrors `frameFromCache`,
/// `relay-server.ts:1074-1091`).
fn frame_payload(frame: &Frame) -> Frame {
    Frame {
        sid: frame.sid.clone(),
        ct: frame.ct.clone(),
        seq: frame.seq,
        from: frame.from,
        frontend_id: if frame.from == Role::Daemon {
            None
        } else {
            frame.frontend_id.clone()
        },
    }
}

/// Route a `relay.kx` — forward `relay.kx.frame` to every OPPOSITE-role peer in
/// the group (no sid, no subscription filter), except the sender. Mirrors
/// `handleKeyExchange` (`relay-server.ts:1038-1070`).
#[must_use]
pub fn route_key_exchange(
    core: &mut RelayCore,
    sender_id: ConnId,
    client: &AuthState,
    ct: &str,
) -> Vec<Action> {
    let mut actions = Vec::new();
    let Some(group) = core.groups.get(&client.daemon_id) else {
        return actions;
    };
    let sender_role = client.role;
    let targets: Vec<ConnId> = group
        .iter()
        .copied()
        .filter(|&peer_id| peer_id != sender_id)
        .filter(|peer_id| {
            core.conns
                .get(peer_id)
                .and_then(|h| h.auth.as_ref())
                .is_some_and(|a| a.role != sender_role)
        })
        .collect();
    for peer_id in targets {
        actions.push(Action::Send(
            peer_id,
            RelayServerMessage::KeyExchangeFrame(KeyExchangeFrame {
                ct: ct.to_string(),
                from: sender_role,
            }),
        ));
    }
    actions
}

/// Route a `relay.sub`. Adds the sid to the sender's subscription set; for
/// frontend role, increments the daemon-state `attached` ref-count; then, if
/// `after` is `Some`, replays cached frames with `seq > after` to the sender.
/// Mirrors `handleSubscribe` (`relay-server.ts:1167-1210`).
#[must_use]
pub fn route_subscribe(
    core: &mut RelayCore,
    sender_id: ConnId,
    sid: &str,
    after: Option<u64>,
) -> Vec<Action> {
    // Snapshot the sender's identity + current sub count.
    let Some((role, daemon_id, sub_count)) = core.conns.get(&sender_id).and_then(|h| {
        h.auth
            .as_ref()
            .map(|a| (a.role, a.daemon_id.clone(), a.subscriptions.len()))
    }) else {
        return Vec::new(); // unauthenticated → NOT_AUTHENTICATED handled by caller
    };

    // Enforce the per-client subscription cap (relay-server.ts:1181).
    if sub_count >= MAX_SUBSCRIPTIONS_PER_CLIENT {
        return vec![Action::Send(
            sender_id,
            RelayServerMessage::Err(RelayErr {
                e: "TOO_MANY_SUBS".to_string(),
                m: Some(format!(
                    "Max {MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per client"
                )),
            }),
        )];
    }

    // Add to the sender's subscription set. Only call attach() on a FRESH insert
    // (bool return of HashSet::insert) to keep attach/detach ref-counts 1:1.
    let freshly_inserted = if let Some(handle) = core.conns.get_mut(&sender_id) {
        if let Some(auth) = handle.auth.as_mut() {
            auth.subscriptions.insert(sid.to_string())
        } else {
            false
        }
    } else {
        false
    };

    // Frontend role: bump the attached ref-count (registry attach) — only when
    // the subscription was newly added (not a duplicate relay.sub).
    if role == Role::Frontend && freshly_inserted {
        if let Some(state) = core.registry.daemon_states.get_mut(&daemon_id) {
            state.attach(sid);
        }
    }

    // Replay cached frames newer than `after` to the subscriber only.
    let mut actions = Vec::new();
    if let Some(after) = after {
        for cached in core.recent.replay_after(&daemon_id, sid, after) {
            actions.push(Action::Send(
                sender_id,
                RelayServerMessage::Frame(frame_payload(&cached)),
            ));
        }
    }
    actions
}

/// Route a `relay.unsub`. Removes the sid from the sender's set; for frontend
/// role, decrements the attached ref-count (only when present). Mirrors
/// `handleUnsubscribe` (`relay-server.ts:1212-1233`). Emits no wire output.
pub fn route_unsubscribe(core: &mut RelayCore, sender_id: ConnId, sid: &str) {
    let Some((role, daemon_id)) = core
        .conns
        .get(&sender_id)
        .and_then(|h| h.auth.as_ref().map(|a| (a.role, a.daemon_id.clone())))
    else {
        return;
    };
    if let Some(handle) = core.conns.get_mut(&sender_id) {
        if let Some(auth) = handle.auth.as_mut() {
            auth.subscriptions.remove(sid);
        }
    }
    if role == Role::Frontend {
        if let Some(state) = core.registry.daemon_states.get_mut(&daemon_id) {
            state.detach(sid);
        }
    }
}

/// Route a `relay.ping` from an AUTHENTICATED client → `relay.pong { ts }`.
/// For daemon role, also refreshes lastSeen. Mirrors `handlePing`
/// (`relay-server.ts:1321-1341`). The caller guarantees the conn is authed (an
/// unauthenticated ping gets no pong and no rate check — `relay-server.ts:1331`).
#[must_use]
pub fn route_ping(
    core: &mut RelayCore,
    sender_id: ConnId,
    client: &AuthState,
    ts: Option<f64>,
    now: u64,
) -> Vec<Action> {
    if client.role == Role::Daemon {
        core.registry.daemon_ping(&client.daemon_id, now);
    }
    vec![Action::Send(
        sender_id,
        RelayServerMessage::Pong(Pong { ts }),
    )]
}

/// Build presence actions for a daemon group: send `relay.presence` to every
/// FRONTEND in the group. Per ADR §A1.4 the `sessions` list is **empty** (the
/// app discards it). Mirrors `broadcastPresence` (`relay-server.ts:1598-1619`)
/// with the empty-sessions redesign.
#[must_use]
pub fn presence_actions(core: &RelayCore, daemon_id: &str) -> Vec<Action> {
    let Some(state) = core.registry.daemon_states.get(daemon_id) else {
        return Vec::new();
    };
    #[allow(clippy::cast_precision_loss)]
    let presence = RelayServerMessage::Presence(Presence {
        daemon_id: daemon_id.to_string(),
        online: state.online,
        sessions: Vec::new(), // ADR §A1.4: emit EMPTY, app discards it anyway
        last_seen: state.last_seen as f64,
    });
    let Some(group) = core.groups.get(daemon_id) else {
        return Vec::new();
    };
    group
        .iter()
        .copied()
        .filter(|peer_id| {
            core.conns
                .get(peer_id)
                .and_then(|h| h.auth.as_ref())
                .is_some_and(|a| a.role == Role::Frontend)
        })
        .map(|peer_id| Action::Send(peer_id, presence.clone()))
        .collect()
}

/// Register an authenticated connection into the conn-level + group-level state:
/// set `auth`, add to the daemon group, attach the shared group limiter. Called
/// by the conn layer after a handshake handler returns `AuthOk`. Mirrors
/// `registerClient` + `upsertDaemonState`'s group/limiter wiring
/// (`relay-server.ts:963-969`). The registry-state mutation itself already
/// happened inside the handshake handler.
pub fn register_authed_conn(core: &mut RelayCore, conn_id: ConnId, auth: AuthState) {
    let daemon_id = auth.daemon_id.clone();
    let group_limiter = core.group_limiter_for(&daemon_id);
    core.add_to_group(&daemon_id, conn_id);
    if let Some(handle) = core.conns.get_mut(&conn_id) {
        handle.auth = Some(auth);
        handle.group_limiter = Some(group_limiter);
    }
}

/// Tear down a connection on close. Returns the `daemon_id` if a presence
/// broadcast is required (daemon-role disconnect). Mirrors `handleClose`
/// (`relay-server.ts:1235-1285`): release attached counts for every sub, remove
/// from group, and for daemon role mark offline + signal presence.
#[must_use]
pub fn handle_close(core: &mut RelayCore, conn_id: ConnId, now: u64) -> Option<String> {
    let handle = core.conns.remove(&conn_id)?;
    let auth = handle.auth?; // never authenticated → nothing to tear down

    // Release attached ref-counts for every subscription (frontend role).
    if auth.role == Role::Frontend {
        let subs: Vec<String> = auth.subscriptions.iter().cloned().collect();
        core.registry.frontend_disconnect(&auth.daemon_id, &subs);
    }

    core.remove_from_group(&auth.daemon_id, conn_id);

    if auth.role == Role::Daemon {
        core.registry.daemon_disconnect(&auth.daemon_id, now);
        return Some(auth.daemon_id);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ring::RecentFrames;

    fn test_core() -> RelayCore {
        use crate::registry::DEFAULT_MAX_REGISTRATIONS;
        RelayCore::new(
            RecentFrames::with_cache_size(10),
            500,
            5000,
            DEFAULT_MAX_REGISTRATIONS,
        )
    }

    /// Insert a conn with a dummy outbox (capacity large enough not to fill in
    /// these synchronous-routing tests) and optionally an auth state.
    fn insert_conn(core: &mut RelayCore, id: ConnId, auth: Option<AuthState>) {
        let (tx, rx) = mpsc::channel(64);
        let (close_tx, close_rx) = mpsc::channel(4);
        let mut handle = ConnHandle::new(tx, close_tx, 500);
        handle.auth = auth;
        core.conns.insert(id, handle);
        // Leak the receivers so the channels stay open for the test duration.
        std::mem::forget(rx);
        std::mem::forget(close_rx);
    }

    fn frontend_auth(daemon: &str, fid: &str) -> AuthState {
        AuthState {
            role: Role::Frontend,
            daemon_id: daemon.to_string(),
            frontend_id: Some(fid.to_string()),
            subscriptions: HashSet::new(),
        }
    }

    fn daemon_auth(daemon: &str) -> AuthState {
        AuthState {
            role: Role::Daemon,
            daemon_id: daemon.to_string(),
            frontend_id: None,
            subscriptions: HashSet::new(),
        }
    }

    #[test]
    fn publish_fans_out_to_subscribers_except_sender() {
        let mut core = test_core();
        // daemon = conn 1 (sender), two frontends = conn 2 (subscribed), 3 (not).
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        let mut fe2 = frontend_auth("d", "f2");
        fe2.subscriptions.insert("s1".to_string());
        insert_conn(&mut core, 2, Some(fe2));
        insert_conn(&mut core, 3, Some(frontend_auth("d", "f3")));
        register_into_group(&mut core, &[1, 2, 3], "d");
        // Seed daemon registry state so daemon_pub has somewhere to land.
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();

        let actions = route_publish(&mut core, 1, &daemon_auth("d"), "s1", "ct", 1, 100);
        // Only conn 2 (subscribed, not sender) receives.
        let targets: Vec<ConnId> = actions
            .iter()
            .filter_map(|a| match a {
                Action::Send(id, RelayServerMessage::Frame(_)) => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(targets, vec![2]);
    }

    #[test]
    fn publish_daemon_role_tracks_session_and_lastseen() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        register_into_group(&mut core, &[1], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();

        let _ = route_publish(&mut core, 1, &daemon_auth("d"), "s1", "ct", 1, 555);
        let state = core.registry.daemon_states.get("d").unwrap();
        assert!(state.sessions.contains("s1"), "daemon pub tracks session");
        assert_eq!(state.last_seen, 555, "daemon pub refreshes lastSeen");
    }

    #[test]
    fn publish_frontend_role_does_not_track_session_or_lastseen() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[1, 2], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 100).unwrap();
        let before = core.registry.daemon_states.get("d").unwrap().last_seen;

        let _ = route_publish(&mut core, 2, &frontend_auth("d", "f"), "s1", "ct", 1, 9999);
        let state = core.registry.daemon_states.get("d").unwrap();
        assert!(
            !state.sessions.contains("s1"),
            "frontend pub must NOT add a session"
        );
        assert_eq!(
            state.last_seen, before,
            "frontend pub must NOT refresh lastSeen"
        );
    }

    #[test]
    fn publish_always_caches_even_with_no_subscribers() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        register_into_group(&mut core, &[1], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();

        let actions = route_publish(&mut core, 1, &daemon_auth("d"), "s1", "ct", 7, 1);
        assert!(actions.is_empty(), "no subscribers → no sends");
        // But the frame is cached and replayable.
        let replay = core.recent.replay_after("d", "s1", 0);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, 7);
    }

    #[test]
    fn key_exchange_targets_opposite_role_only() {
        let mut core = test_core();
        // daemon=1 (sender), frontend=2 (opposite → receives), daemon=3 (same → not).
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        insert_conn(&mut core, 3, Some(daemon_auth("d")));
        register_into_group(&mut core, &[1, 2, 3], "d");

        let actions = route_key_exchange(&mut core, 1, &daemon_auth("d"), "kx-ct");
        let targets: Vec<ConnId> = actions
            .iter()
            .filter_map(|a| match a {
                Action::Send(id, RelayServerMessage::KeyExchangeFrame(f)) => {
                    assert_eq!(f.from, Role::Daemon);
                    assert_eq!(f.ct, "kx-ct");
                    Some(*id)
                }
                _ => None,
            })
            .collect();
        assert_eq!(targets, vec![2], "only the opposite-role frontend");
    }

    #[test]
    fn subscribe_attaches_and_replays_after_cursor() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[1, 2], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();

        // Daemon caches 3 frames.
        for seq in 1..=3 {
            let _ = route_publish(&mut core, 1, &daemon_auth("d"), "s1", "ct", seq, 1);
        }

        // Frontend subscribes with after=1 → replays seq 2,3.
        let actions = route_subscribe(&mut core, 2, "s1", Some(1));
        let seqs: Vec<u64> = actions
            .iter()
            .filter_map(|a| match a {
                Action::Send(2, RelayServerMessage::Frame(f)) => Some(f.seq),
                _ => None,
            })
            .collect();
        assert_eq!(seqs, vec![2, 3]);
        // attached ref-count bumped.
        assert_eq!(
            core.registry
                .daemon_states
                .get("d")
                .unwrap()
                .attached
                .get("s1")
                .copied(),
            Some(1)
        );
        // subscription recorded on the conn.
        assert!(core.conns[&2]
            .auth
            .as_ref()
            .unwrap()
            .subscriptions
            .contains("s1"));
    }

    #[test]
    fn subscribe_without_after_does_not_replay() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[1, 2], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();
        let _ = route_publish(&mut core, 1, &daemon_auth("d"), "s1", "ct", 1, 1);

        let actions = route_subscribe(&mut core, 2, "s1", None);
        assert!(actions.is_empty(), "no `after` → no replay");
    }

    #[test]
    fn unsubscribe_detaches() {
        let mut core = test_core();
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[2], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();
        let _ = route_subscribe(&mut core, 2, "s1", None);
        assert!(core
            .registry
            .daemon_states
            .get("d")
            .unwrap()
            .attached
            .contains_key("s1"));

        route_unsubscribe(&mut core, 2, "s1");
        assert!(
            !core
                .registry
                .daemon_states
                .get("d")
                .unwrap()
                .attached
                .contains_key("s1"),
            "detach removes the key at zero"
        );
        assert!(!core.conns[&2]
            .auth
            .as_ref()
            .unwrap()
            .subscriptions
            .contains("s1"));
    }

    #[test]
    fn ping_daemon_refreshes_lastseen_and_pongs() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        register_into_group(&mut core, &[1], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();

        let actions = route_ping(&mut core, 1, &daemon_auth("d"), Some(42.0), 777);
        assert!(matches!(
            actions.as_slice(),
            [Action::Send(1, RelayServerMessage::Pong(Pong { ts: Some(t) }))] if (*t - 42.0).abs() < f64::EPSILON
        ));
        assert_eq!(core.registry.daemon_states.get("d").unwrap().last_seen, 777);
    }

    #[test]
    fn presence_targets_frontends_only_with_empty_sessions() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[1, 2], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();
        // Add a session — presence must STILL emit empty.
        core.registry.daemon_pub("d", "s1".into(), 0);

        let actions = presence_actions(&core, "d");
        assert_eq!(actions.len(), 1, "only the frontend receives presence");
        match &actions[0] {
            Action::Send(2, RelayServerMessage::Presence(p)) => {
                assert!(p.online);
                assert!(
                    p.sessions.is_empty(),
                    "ADR §A1.4: sessions must be empty even when daemon has sessions"
                );
            }
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn handle_close_daemon_marks_offline_and_returns_id() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        register_into_group(&mut core, &[1], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();
        assert!(core.registry.daemon_states.get("d").unwrap().online);

        let presence_daemon = handle_close(&mut core, 1, 2000);
        assert_eq!(presence_daemon.as_deref(), Some("d"));
        assert!(!core.registry.daemon_states.get("d").unwrap().online);
        assert!(!core.conns.contains_key(&1), "conn removed");
        assert!(!core.groups.contains_key("d"), "empty group removed");
    }

    #[test]
    fn last_group_member_close_drops_the_group_limiter() {
        // Last-leaver cleanup: once a daemon group has no connections left, the
        // shared `group_limiters` entry must be dropped too — otherwise it can
        // orphan permanently when the daemon was already evicted from the
        // registry (the periodic sweep can never see that daemon_id again).
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[1, 2], "d");
        assert!(core.group_limiters.contains_key("d"), "limiter created");

        // First member leaves — group still non-empty, limiter retained.
        let _ = handle_close(&mut core, 1, 1000);
        assert!(
            core.group_limiters.contains_key("d"),
            "limiter retained while a frontend remains"
        );

        // Last member leaves — group empties, limiter must be dropped.
        let _ = handle_close(&mut core, 2, 1001);
        assert!(!core.groups.contains_key("d"), "empty group removed");
        assert!(
            !core.group_limiters.contains_key("d"),
            "limiter dropped with the last group member (no permanent leak)"
        );
    }

    // The budget-doubling guard (eviction must RETAIN the group limiter while
    // frontends remain, so a re-registering daemon reuses the same `Arc` rather
    // than minting a second one) is exercised end-to-end through the real
    // `stale_sweep` eviction path in `conn.rs`'s test module
    // (`eviction_retains_group_limiter_while_a_frontend_remains`), where
    // `stale_sweep` is callable against a `SharedState`. A server.rs-level
    // version that hand-simulates the eviction step is not fix-sensitive (the
    // simulated conditional passes regardless of the real conn.rs source).

    #[test]
    fn handle_close_frontend_releases_attached() {
        let mut core = test_core();
        insert_conn(&mut core, 1, Some(daemon_auth("d")));
        insert_conn(&mut core, 2, Some(frontend_auth("d", "f")));
        register_into_group(&mut core, &[1, 2], "d");
        core.registry.valid_tokens.insert("tk".into(), "d".into());
        core.registry.handle_auth("d", "tk", true, 0).unwrap();
        let _ = route_subscribe(&mut core, 2, "s1", None);
        assert!(core
            .registry
            .daemon_states
            .get("d")
            .unwrap()
            .attached
            .contains_key("s1"));

        let presence_daemon = handle_close(&mut core, 2, 3000);
        assert!(presence_daemon.is_none(), "frontend close → no presence");
        assert!(
            !core
                .registry
                .daemon_states
                .get("d")
                .unwrap()
                .attached
                .contains_key("s1"),
            "attached ref-count released on frontend close"
        );
    }

    /// Helper: register a set of already-inserted conns into a daemon group with
    /// the shared group limiter wired (the auth state is left as-is).
    fn register_into_group(core: &mut RelayCore, ids: &[ConnId], daemon_id: &str) {
        for &id in ids {
            let group_limiter = core.group_limiter_for(daemon_id);
            core.add_to_group(daemon_id, id);
            if let Some(handle) = core.conns.get_mut(&id) {
                handle.group_limiter = Some(group_limiter);
            }
        }
    }
}
