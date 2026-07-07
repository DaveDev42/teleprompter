//! Daemon-side Relay client (v2) — tokio port of
//! `packages/daemon/src/transport/relay-client.ts` (1208 lines).
//!
//! Connects to a Relay server with self-registration, authenticates,
//! performs in-band key exchange with frontends, and manages per-frontend
//! E2EE session keys for N:N multiplexing. Full state machine:
//! self-register → auth → in-band ECDH kx with frontends → per-frontend
//! session keys → N:N encrypted pub/sub → reconnect/resume.
//!
//! ## Reused (not reimplemented) building blocks
//!
//! - `tp_relay::{RelayServerMessage, parse_relay_server_message}` — the
//!   inbound (relay→client) message parser already exists fully-implemented
//!   in `tp-relay` (byte-exact port of `relay-server-guard.ts`); reused here
//!   as a dependency rather than re-derived.
//! - `tp_proto::relay_client::{RelayClientMessage, Role, Platform,
//!   InterruptionLevel, PushData}` — outbound (client→relay) message
//!   construction (byte-exact port of `relay-client-guard.ts`'s companion
//!   serializer surface).
//! - `tp_proto::control::{ControlMessage, UnpairReason, parse_control_message}`
//!   and `tp_proto::label::Label` (+ decoders) — the `__control__` sid E2EE
//!   control-plane payloads (`control.unpair` / `control.rename`).
//! - `tp_core::crypto::{derive_kx_key, seal, open, kx_server_session_keys,
//!   derive_pairing_confirmation_tag}` — all AEAD/KDF/ECDH primitives.
//!
//! Local additions (nothing byte-exact reusable exists in the workspace):
//! - a small base64 (STANDARD, padded) helper for the kx envelope's raw
//!   (non-AEAD) public-key field, mirroring `toBase64`/`fromBase64`
//!   (`packages/protocol/src/crypto.ts:476-484`);
//! - a small canonical-UUID→16-bytes parser mirroring `parseUuid16`
//!   (`packages/protocol/src/pairing.ts:178-188`) — `tp_core::pairing`'s own
//!   `parse_uuid_16` is a private (non-`pub`) helper, so this crate carries
//!   its own copy rather than widening tp-core's public surface for this
//!   increment;
//! - local string constants for the `control.unpair` / `control.rename` /
//!   `__control__` discriminants — `tp-proto` has no named constants for
//!   these (they are inline literal match-arm patterns in
//!   `parse_control_message`).
//!
//! ## The 9 load-bearing properties preserved from the Bun implementation
//!
//! Each of these has a `relay-client.test.ts` regression test on the TS side;
//! this port must reproduce every one byte-for-byte / behavior-for-behavior:
//!
//! 1. [`compute_reconnect_plan`] — pure exported fn, dead-pairing throttle.
//! 2. [`next_peerless_reconnects`] — throttle counter accounting, gated on
//!    the PER-CONNECTION `had_peer_this_connection` flag, NOT `peers.len()`
//!    (the peer map survives reconnects for the resume fast-path).
//! 3. Resume fast-path (`relay.auth.resume` cached token) with graceful
//!    fallback to full register+auth on `relay.auth.err`.
//! 4. `handle_kx_frame` — full guard/derive/persist/broadcast sequence.
//! 5. `send()` returns a REAL transmitted-bool; `broadcast_encrypted` is
//!    per-peer best-effort (one peer's failure never aborts the fan-out).
//! 6. Dispose-race guards (`connect`, `start_ping` re-check `disposed`;
//!    `schedule_reconnect`'s spawned retry always reschedules on failure).
//! 7. `handle_frame` — frontendId-keyed O(1) lookup first, then per-peer
//!    fallback, each decrypt attempt individually contained.
//! 8. `relay.err` handling (`PUSH_UNSEAL_FAILED` / `PUSH_TOKEN_DEAD` /
//!    `RATE_LIMITED` / generic).
//! 9. Public API surface increment 4 will call — method names below match
//!    the TS class 1:1 in snake_case.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64_STANDARD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use tp_core::crypto::{
    derive_kx_key, derive_pairing_confirmation_tag, kx_server_session_keys, open, seal, KxKeyPair,
    SessionKeys,
};
use tp_core::error::{Result as TpResult, TpError};
use tp_proto::control::{parse_control_message, ControlMessage, UnpairReason};
use tp_proto::label::Label;
use tp_proto::relay_client::{InterruptionLevel, Platform, PushData, RelayClientMessage, Role};
use tp_relay::{parse_relay_server_message, RelayServerMessage};

/// The live WebSocket type — a TCP (optionally TLS-wrapped) stream framed as
/// tungstenite messages. Same alias tp-relay's own test client uses.
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

// ── Reconnect / throttle constants (relay-client.ts:46-78) ─────────────────

const RECONNECT_BASE_MS: u64 = 1000;
const RECONNECT_MAX_MS: u64 = 30_000;
/// `Math.ceil(Math.log2(RECONNECT_MAX_MS / RECONNECT_BASE_MS))` = `ceil(log2(30))` = 5.
const MAX_RECONNECT_ATTEMPT: u32 = 5;
const PEERLESS_RECONNECT_THRESHOLD: u32 = 3;
const PEERLESS_RECONNECT_MS: u64 = 30 * 60_000;
const PING_INTERVAL_MS: u64 = 30_000;

/// The `__control__` virtual sid that E2EE control-plane frames (unpair/
/// rename) ride on top of the existing encrypted data channel. Mirrors
/// `RELAY_CHANNEL_CONTROL` (`packages/protocol/src/types/control.ts`) — no
/// named Rust constant exists in `tp-proto` (the string is an inline literal
/// in `parse_control_message`'s match), so this crate carries its own copy.
const RELAY_CHANNEL_CONTROL: &str = "__control__";
/// `control.unpair` discriminant — mirrors `CONTROL_UNPAIR`.
const CONTROL_UNPAIR: &str = "control.unpair";
/// `control.rename` discriminant — mirrors `CONTROL_RENAME`.
const CONTROL_RENAME: &str = "control.rename";
/// `WS_PROTOCOL_VERSION` (`packages/protocol/src/compat.ts:56`) — advertised
/// by both peers in the kx payload `v`. v3 = PCT + QR v4.
const WS_PROTOCOL_VERSION: f64 = 3.0;

/// Current epoch milliseconds, `f64` (matches JS `Date.now()`'s type on the
/// wire — every timestamp field in the protocol is a JSON number). The
/// `u128 → f64` cast loses precision only past ~2^52 ms since the epoch
/// (year ~145,000 AD), so this is exact for any real timestamp — the same
/// precision envelope JS `Date.now()` itself has (an IEEE-754 double).
#[allow(clippy::cast_precision_loss)]
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `toBase64` (`packages/protocol/src/crypto.ts:476-479`) — standard
/// (padded) base64. Used only for the kx envelope's raw (non-AEAD)
/// public-key field; the AEAD `seal`/`open` helpers encode/decode their own
/// base64 internally and do not expose it.
fn to_base64(bytes: &[u8]) -> String {
    B64_STANDARD.encode(bytes)
}

/// `fromBase64` (`packages/protocol/src/crypto.ts:481-484`) — inverse of
/// [`to_base64`].
fn from_base64(s: &str) -> Option<Vec<u8>> {
    B64_STANDARD.decode(s).ok()
}

/// `parseUuid16` (`packages/protocol/src/pairing.ts:178-188`) — parse a
/// canonical UUID string (`8-4-4-4-12`, hyphens optional) into 16 raw bytes.
/// `tp_core::pairing::parse_uuid_16` is a private helper in that crate, so
/// this is a local byte-exact twin rather than a cross-crate reuse.
fn parse_uuid_16(s: &str) -> Option<[u8; 16]> {
    let hex_only: String = s.chars().filter(|c| *c != '-').collect();
    if hex_only.len() != 32 || !hex_only.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&hex_only[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

// ── Pure reconnect-delay policy (relay-client.ts:80-127) ───────────────────

/// Result of [`compute_reconnect_plan`] — mirrors the TS `{ delay, nextAttempt }`
/// return shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPlan {
    pub delay_ms: u64,
    pub next_attempt: u32,
}

/// Pure reconnect-delay policy, extracted so the dead-pairing throttle can be
/// unit-tested without standing up a relay or faking WebSocket internals.
///
/// - `peerless_reconnects >= PEERLESS_RECONNECT_THRESHOLD` → the pairing has
///   reconnected this many times with no frontend ever joining: it is
///   treated as dead and throttled to `PEERLESS_RECONNECT_MS` (30 min), so a
///   pile of dead pairings cannot storm the relay. `attempt` is left
///   UNCHANGED — a recovered pairing resumes fast backoff from where it left
///   off, not from 0.
/// - Otherwise → standard exponential backoff `RECONNECT_BASE_MS * 2^attempt`,
///   capped at `RECONNECT_MAX_MS`.
///
/// Byte-exact port of `computeReconnectPlan` (relay-client.ts:95-105).
#[must_use]
pub fn compute_reconnect_plan(attempt: u32, peerless_reconnects: u32) -> ReconnectPlan {
    if peerless_reconnects >= PEERLESS_RECONNECT_THRESHOLD {
        return ReconnectPlan {
            delay_ms: PEERLESS_RECONNECT_MS,
            next_attempt: attempt,
        };
    }
    // `RECONNECT_BASE_MS * 2^attempt`, saturating rather than overflowing for
    // large attempt values (the TS `2 ** attempt` produces `Infinity`, which
    // `Math.min` then clamps to RECONNECT_MAX_MS — checked_mul + unwrap_or
    // reproduces the same clamped-to-max outcome without float args).
    let scaled = 2u64
        .checked_pow(attempt)
        .and_then(|p| p.checked_mul(RECONNECT_BASE_MS))
        .unwrap_or(RECONNECT_MAX_MS);
    let delay_ms = scaled.min(RECONNECT_MAX_MS);
    let next_attempt = (attempt + 1).min(MAX_RECONNECT_ATTEMPT);
    ReconnectPlan {
        delay_ms,
        next_attempt,
    }
}

/// Pure accounting for the dead-pairing throttle counter, extracted so its
/// (previously buggy) gating can be unit-tested without faking WebSocket
/// lifecycles.
///
/// `had_peer` means "a frontend completed key exchange during the
/// connection that just ended". When it did, the pairing is alive and the
/// counter resets to 0; otherwise the just-ended connection saw no peer and
/// the counter ticks.
///
/// The critical subtlety this guards against: the peer map is PRESERVED
/// across reconnects (resume fast-path), so gating on peer-map size would
/// keep the counter pinned at 0 forever after the first kx and silently
/// defeat the throttle for any pairing that ever had a live frontend (the
/// 9-pairing → 3113 re-auth incident). The signal MUST be per-connection,
/// not map size.
///
/// Byte-exact port of `nextPeerlessReconnects` (relay-client.ts:122-127).
#[must_use]
pub fn next_peerless_reconnects(current: u32, had_peer: bool) -> u32 {
    if had_peer {
        0
    } else {
        current + 1
    }
}

// ── Per-frontend peer state (relay-client.ts:129-151) ───────────────────────

/// A frontend that has completed key exchange with this daemon.
struct FrontendPeer {
    /// The frontend's raw X25519 public key, kept alongside the derived
    /// session keys for parity with the TS `FrontendPeer.publicKey` field
    /// (relay-client.ts:129-151) — not read after storage today (the
    /// `onPeerConfirmed` callback receives the frontend pubkey directly at
    /// the kx call site instead of from this map), but retained rather than
    /// dropped so a future re-broadcast/diagnostic surface does not need to
    /// re-plumb it through `handle_kx_frame`.
    #[allow(dead_code)]
    public_key: [u8; 32],
    session_keys: SessionKeys,
    /// The frontend's advertised WS protocol version (`data.v`, defaults to 1
    /// when absent). Retained for future version-gating; no longer used to
    /// gate `ControlRename` emission (the Label union is always sent).
    #[allow(dead_code)]
    protocol_version: f64,
    /// Pairing Confirmation Tag for this frontend's ECDH session, derived
    /// locally right after key agreement. Absent when the pairing has no
    /// `pairing_id` yet or derivation failed.
    pct: Option<[u8; 32]>,
    /// `pct` pre-encoded as base64 for the (sync) hello builders.
    pct_b64: Option<String>,
}

// ── Config / events (relay-client.ts:153-249) ───────────────────────────────

/// Mirrors `RelayClientConfig` (relay-client.ts:153-175).
pub struct RelayClientConfig {
    /// Relay server URL (e.g. `wss://relay.example.com`).
    pub relay_url: String,
    pub daemon_id: String,
    /// Relay auth token (derived from pairing secret).
    pub token: String,
    /// Registration proof for relay self-registration.
    pub registration_proof: String,
    /// Daemon key pair for E2EE.
    pub key_pair: KxKeyPair,
    /// Raw pairing secret (for kx envelope encryption).
    pub pairing_secret: Vec<u8>,
    /// Human-readable label for this pairing as a tagged union.
    pub label: Option<Label>,
    /// Stable pairing UUID (QR v4) as a canonical string. `""` = unknown
    /// (legacy pairing whose async backfill hasn't landed) — PCT derivation
    /// is skipped, nothing else changes.
    pub pairing_id: String,
    /// Daemon display hostname bound into the PCT. `""` for legacy pairings.
    pub hostname: String,
}

/// Reason surfaced with [`RelayClientEvents::on_relay_throttled`]. Only one
/// variant exists today (`RATE_LIMITED`); an enum leaves room to add more
/// without a wire/behavior change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThrottleReason {
    RateLimited,
}

/// `onInput` callback: `(kind, sid, data, frontend_id)`.
pub type OnInputFn = Arc<dyn Fn(InputKind, &str, &str, &str) + Send + Sync>;
/// `onControlMessage` callback: the raw parsed session-control JSON value
/// (mirrors TS `RelayControlMessage`, which this increment does not
/// re-derive — the dispatcher (increment 4) owns interpreting it) plus the
/// owning `frontend_id`.
pub type OnControlMessageFn = Arc<dyn Fn(&Value, &str) + Send + Sync>;
pub type OnConnectedFn = Arc<dyn Fn() + Send + Sync>;
/// `onDisconnected` callback: `(code, reason)`, both optional (mirrors the
/// TS `CloseEvent`-shaped `info?: {code?, reason?}`).
pub type OnDisconnectedFn = Arc<dyn Fn(Option<u16>, Option<&str>) + Send + Sync>;
pub type OnRelayThrottledFn = Arc<dyn Fn(ThrottleReason, Option<&str>) + Send + Sync>;
/// `onPresence` callback: `(online, sessions)`.
pub type OnPresenceFn = Arc<dyn Fn(bool, &[String]) + Send + Sync>;
pub type OnFrontendJoinedFn = Arc<dyn Fn(&str) + Send + Sync>;
/// `onPeerConfirmed` callback: `(frontend_id, pct, frontend_pk)`.
pub type OnPeerConfirmedFn = Arc<dyn Fn(&str, &[u8; 32], &[u8; 32]) + Send + Sync>;
/// `onPushTokenSealed` callback: `(frontend_id, sealed, platform)`.
pub type OnPushTokenSealedFn = Arc<dyn Fn(&str, &str, Platform) + Send + Sync>;
pub type OnPushUnsealFailedFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type OnPushTokenDeadFn = Arc<dyn Fn(&str) + Send + Sync>;
/// `onUnpair` callback: `(frontend_id, reason)`.
pub type OnUnpairFn = Arc<dyn Fn(&str, UnpairReason) + Send + Sync>;
/// `onRename` callback: `(frontend_id, label)`.
pub type OnRenameFn = Arc<dyn Fn(&str, &Label) + Send + Sync>;

/// Which chat-plane channel an inbound input frame targets. Mirrors the TS
/// `"chat" | "term"` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Chat,
    Term,
}

/// The owner-supplied callbacks. Mirrors `RelayClientEvents`
/// (relay-client.ts:177-249). Every field is optional, matching the TS
/// `?:` callbacks — `None` is a no-op, exactly like an unset TS handler.
#[derive(Default)]
pub struct RelayClientEvents {
    pub on_input: Option<OnInputFn>,
    pub on_control_message: Option<OnControlMessageFn>,
    pub on_connected: Option<OnConnectedFn>,
    pub on_disconnected: Option<OnDisconnectedFn>,
    pub on_relay_throttled: Option<OnRelayThrottledFn>,
    pub on_presence: Option<OnPresenceFn>,
    pub on_frontend_joined: Option<OnFrontendJoinedFn>,
    pub on_peer_confirmed: Option<OnPeerConfirmedFn>,
    pub on_push_token_sealed: Option<OnPushTokenSealedFn>,
    pub on_push_unseal_failed: Option<OnPushUnsealFailedFn>,
    pub on_push_token_dead: Option<OnPushTokenDeadFn>,
    /// `onUnpair` (relay-client.ts:302-304) — settable field, not
    /// constructor-supplied, on the TS class; modeled the same way here via
    /// `Option` so the dispatcher can wire it up after construction if
    /// needed, but a constructor-time value works identically.
    pub on_unpair: Option<OnUnpairFn>,
    pub on_rename: Option<OnRenameFn>,
}

// ── The client ───────────────────────────────────────────────────────────

/// Shared, lockable connection state. A `Mutex` (not `RwLock`) because
/// almost every access needs to both read and mutate (e.g. `send` needs a
/// live sink to write to and may need to tear it down on error).
struct ConnState {
    /// The outbound write half, present only while a socket is open.
    /// Wrapped separately from the read loop so `send()` can be called from
    /// any task without contending with the read loop's `next()`.
    ws_tx: Option<mpsc::Sender<Message>>,
    authenticated: bool,
    disposed: bool,
    reconnect_attempt: u32,
    peerless_reconnects: u32,
    had_peer_this_connection: bool,
    resume_token: Option<String>,
    resume_expires_at: f64,
    resuming: bool,
    subscribed_sessions: std::collections::HashSet<String>,
    /// Generation counter — bumped on every `cleanup()`. The read-loop task
    /// captures its generation at spawn time and stops touching shared state
    /// once it observes a newer generation, so a stale task from a
    /// superseded connection cannot clobber a fresher one's state (mirrors
    /// the `ws.onopen`/`onmessage`/`onclose` handlers being nulled out in
    /// the TS `cleanup()`).
    generation: u64,
}

impl ConnState {
    fn new() -> Self {
        ConnState {
            ws_tx: None,
            authenticated: false,
            disposed: false,
            reconnect_attempt: 0,
            peerless_reconnects: 0,
            had_peer_this_connection: false,
            resume_token: None,
            resume_expires_at: 0.0,
            resuming: false,
            subscribed_sessions: std::collections::HashSet::new(),
            generation: 0,
        }
    }
}

/// The daemon-side relay client. Mirrors the `RelayClient` class
/// (relay-client.ts:251-1208).
pub struct RelayClient {
    config: RelayClientConfig,
    events: RelayClientEvents,
    /// Per-frontend E2EE peers. `tokio::sync::Mutex` (not `std::sync::Mutex`)
    /// because peer lookups happen inside `async` decrypt/dispatch paths that
    /// hold the guard across `.await`-free critical sections only — using the
    /// async mutex keeps this call-site-agnostic without auditing every
    /// holder for await-points.
    peers: Mutex<HashMap<String, FrontendPeer>>,
    /// Symmetric key for key-exchange envelopes (from pairing secret).
    kx_key: Mutex<Option<[u8; 32]>>,
    state: Mutex<ConnState>,
    /// Background task handles (read loop, ping timer, reconnect timer) so
    /// `cleanup()`/`dispose()` can abort them deterministically instead of
    /// relying on drop-cancellation ordering.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl RelayClient {
    #[must_use]
    pub fn new(config: RelayClientConfig, events: RelayClientEvents) -> Arc<Self> {
        Arc::new(RelayClient {
            config,
            events,
            peers: Mutex::new(HashMap::new()),
            kx_key: Mutex::new(None),
            state: Mutex::new(ConnState::new()),
            tasks: Mutex::new(Vec::new()),
        })
    }

    /// Connect to the relay. Mirrors `connect()` (relay-client.ts:315-398).
    pub async fn connect(self: &Arc<Self>) {
        if self.state.lock().await.disposed {
            return;
        }

        // Derive kx key from pairing secret (for key exchange envelopes).
        {
            let mut kx = self.kx_key.lock().await;
            if kx.is_none() {
                *kx = Some(derive_kx_key(&self.config.pairing_secret));
            }
        }

        // Re-check disposed after the (conceptual) await window above: a
        // cancel()/dispose() racing the kx-key derivation must not leave a
        // phantom socket that nobody owns. `derive_kx_key` is actually
        // synchronous in Rust (no sodium-init await like the TS libsodium
        // binding), but the re-check is kept for parity with the TS
        // dispose-race guard and because a future async KDF swap must not
        // silently drop this protection.
        if self.state.lock().await.disposed {
            return;
        }

        self.cleanup().await;

        let generation = {
            let mut st = self.state.lock().await;
            st.generation += 1;
            st.generation
        };

        let connect_result = connect_async(&self.config.relay_url).await;
        let ws = match connect_result {
            Ok((ws, _resp)) => ws,
            Err(err) => {
                eprintln!("[RelayClient] connect failed: {err}");
                self.schedule_reconnect();
                return;
            }
        };

        // Re-check disposed/generation after the connect await: dispose()
        // (or a newer connect()) may have raced us while the TCP/TLS
        // handshake was in flight.
        {
            let st = self.state.lock().await;
            if st.disposed || st.generation != generation {
                return;
            }
        }

        let (mut ws_tx_half, ws_rx_half) = ws.split();
        let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);

        {
            let mut st = self.state.lock().await;
            st.ws_tx = Some(out_tx);
        }

        // Writer task: drain the outbound channel to the socket.
        let this_writer = Arc::clone(self);
        let writer_task = tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if ws_tx_half.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = this_writer;
        });

        // Reader task: the read loop drives onopen/onmessage/onclose
        // equivalents.
        let this_reader = Arc::clone(self);
        let reader_task = tokio::spawn(async move {
            this_reader.run_read_loop(ws_rx_half, generation).await;
        });

        {
            let mut tasks = self.tasks.lock().await;
            tasks.push(writer_task);
            tasks.push(reader_task);
        }

        // "onopen": reset attempt counter and send the register/resume frame.
        self.state.lock().await.reconnect_attempt = 0;
        self.on_open().await;
    }

    /// Mirrors the `ws.onopen` handler (relay-client.ts:336-358).
    async fn on_open(self: &Arc<Self>) {
        let (resume_token, should_resume) = {
            let st = self.state.lock().await;
            let should = st
                .resume_token
                .as_ref()
                .is_some_and(|_| now_ms() < st.resume_expires_at);
            (st.resume_token.clone(), should)
        };

        if should_resume {
            if let Some(token) = resume_token {
                self.state.lock().await.resuming = true;
                // Fire-and-forget: a failed send here means the socket is
                // already gone, which the read loop's own close handling
                // will discover and reconnect from — mirrors the TS
                // `this.send(...)` call (return type `void`, not checked).
                let _ = self
                    .send(RelayClientMessage::AuthResume { token, v: 2.0 })
                    .await;
                return;
            }
        }

        let _ = self
            .send(RelayClientMessage::Register {
                daemon_id: self.config.daemon_id.clone(),
                proof: self.config.registration_proof.clone(),
                token: self.config.token.clone(),
                v: 2.0,
            })
            .await;
    }

    /// The read loop: one iteration per inbound WS message, plus the ping
    /// timer's own send (spawned from here after auth.ok, per `startPing`).
    /// Mirrors `ws.onmessage`/`ws.onclose`/`ws.onerror`
    /// (relay-client.ts:360-397).
    async fn run_read_loop(self: Arc<Self>, mut ws_rx: WsReadHalf, generation: u64) {
        loop {
            let next = ws_rx.next().await;
            // Stale-generation guard: a superseded connection's read loop
            // must stop touching shared state the moment a newer connect()
            // has taken over (mirrors `cleanup()` nulling out the old
            // socket's handlers).
            if self.state.lock().await.generation != generation {
                return;
            }
            match next {
                Some(Ok(Message::Text(text))) => {
                    let parsed: Result<Value, _> = serde_json::from_str(text.as_str());
                    let Ok(parsed) = parsed else {
                        continue; // ignore malformed JSON
                    };
                    let Some(msg) = parse_relay_server_message(&parsed) else {
                        eprintln!("[RelayClient] dropped malformed relay frame");
                        continue;
                    };
                    self.handle_message(msg).await;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    self.on_close(generation).await;
                    return;
                }
                Some(Ok(_)) => {
                    // Non-text frame (ping/pong/binary) — no-op, matches the
                    // TS `typeof event.data !== "string"` early return.
                }
            }
        }
    }

    /// Mirrors `ws.onclose` (relay-client.ts:379-393).
    async fn on_close(self: &Arc<Self>, generation: u64) {
        {
            let mut st = self.state.lock().await;
            if st.generation != generation {
                return;
            }
            st.authenticated = false;
        }
        if let Some(cb) = &self.events.on_disconnected {
            cb(None, None);
        }
        self.schedule_reconnect();
    }

    // ── Message dispatch (relay-client.ts:400-572) ──────────────────────

    async fn handle_message(self: &Arc<Self>, msg: RelayServerMessage) {
        match msg {
            RelayServerMessage::RegisterOk(_) => {
                let _ = self
                    .send(RelayClientMessage::Auth {
                        role: Role::Daemon,
                        daemon_id: self.config.daemon_id.clone(),
                        token: self.config.token.clone(),
                        v: 2.0,
                        frontend_id: None,
                    })
                    .await;
            }
            RelayServerMessage::RegisterErr(e) => {
                eprintln!("[RelayClient] registration failed: {}", e.e);
                self.close_socket().await;
            }
            RelayServerMessage::AuthOk(ok) => {
                self.handle_auth_ok(ok).await;
            }
            RelayServerMessage::AuthErr(e) => {
                let resuming = self.state.lock().await.resuming;
                if resuming {
                    let mut st = self.state.lock().await;
                    st.resuming = false;
                    st.resume_token = None;
                    st.resume_expires_at = 0.0;
                    drop(st);
                    eprintln!(
                        "[RelayClient] resume rejected ({}); falling back to full auth",
                        e.e
                    );
                    self.close_socket().await;
                    return;
                }
                eprintln!("[RelayClient] auth failed: {}", e.e);
                self.close_socket().await;
            }
            RelayServerMessage::KeyExchangeFrame(frame) => {
                self.handle_kx_frame(frame).await;
            }
            RelayServerMessage::Frame(frame) => {
                self.handle_frame(frame).await;
            }
            RelayServerMessage::Presence(p) => {
                if let Some(cb) = &self.events.on_presence {
                    cb(p.online, &p.sessions);
                }
            }
            // `Pong` needs no response, and `Notification` targets
            // frontends (not the daemon) — both intentional no-ops here,
            // combined into one arm (matches clippy's identical-body merge;
            // the TS switch's `default: never` exhaustiveness guard is
            // preserved by the match staying otherwise variant-by-variant).
            RelayServerMessage::Pong(_) | RelayServerMessage::Notification(_) => {}
            RelayServerMessage::Err(e) => {
                self.handle_relay_err(&e).await;
            }
            RelayServerMessage::PushToken(pt) => {
                if let Some(cb) = &self.events.on_push_token_sealed {
                    cb(&pt.frontend_id, &pt.sealed, pt.platform);
                }
            }
        }
    }

    async fn handle_auth_ok(self: &Arc<Self>, ok: tp_relay::AuthOk) {
        let resumed = {
            let mut st = self.state.lock().await;
            st.authenticated = true;
            if let (Some(token), Some(expires)) = (&ok.resume_token, ok.resume_expires_at) {
                st.resume_token = Some(token.clone());
                st.resume_expires_at = expires;
            }
            st.resuming = false;
            ok.resumed.unwrap_or(false)
        };

        if let Some(cb) = &self.events.on_connected {
            cb();
        }

        // Re-subscribe to all sessions.
        let subs: Vec<String> = self
            .state
            .lock()
            .await
            .subscribed_sessions
            .iter()
            .cloned()
            .collect();
        for sid in subs {
            let _ = self
                .send(RelayClientMessage::Subscribe { sid, after: None })
                .await;
        }

        // Broadcast the daemon's public key for key exchange, unless we
        // resumed AND already have peers (keypair is stable across
        // reconnects — existing peers' sessionKeys are still valid).
        let peer_count = self.peers.lock().await.len();
        if !(resumed && peer_count > 0) {
            self.broadcast_daemon_public_key().await;
        }

        self.start_ping();
        eprintln!(
            "[RelayClient] {} to relay",
            if resumed { "resumed" } else { "authenticated" }
        );
    }

    async fn handle_relay_err(self: &Arc<Self>, e: &tp_relay::RelayErr) {
        match e.e.as_str() {
            "PUSH_UNSEAL_FAILED" => {
                // The relay.err frame does not carry frontendId in this
                // struct today (see tp-relay/src/messages.rs RelayErr — only
                // `e`/`m`); when it does not, fall back to the self-heal-on-
                // reconnect behavior, matching the TS "legacy relay" branch.
                eprintln!(
                    "[RelayClient] relay reported PUSH_UNSEAL_FAILED — no eviction (no frontendId on this frame); app re-registers on next relay reconnect. relay: {}",
                    e.m.as_deref().unwrap_or("(no detail)")
                );
            }
            "PUSH_TOKEN_DEAD" => {
                eprintln!(
                    "[RelayClient] relay reported PUSH_TOKEN_DEAD — no eviction (no frontendId on this frame); app re-registers on next relay reconnect. relay: {}",
                    e.m.as_deref().unwrap_or("(no detail)")
                );
            }
            "RATE_LIMITED" => {
                eprintln!(
                    "[RelayClient] relay throttled us: {}",
                    e.m.as_deref().unwrap_or(&e.e)
                );
                if let Some(cb) = &self.events.on_relay_throttled {
                    cb(ThrottleReason::RateLimited, e.m.as_deref());
                }
            }
            _ => {
                eprintln!(
                    "[RelayClient] relay error: {}",
                    e.m.as_deref().unwrap_or(&e.e)
                );
            }
        }
    }

    /// Broadcast the daemon's public key to all connected frontends,
    /// encrypted with `kx_key`. Mirrors `broadcastDaemonPublicKey`
    /// (relay-client.ts:586-597).
    async fn broadcast_daemon_public_key(self: &Arc<Self>) {
        let kx_key = { *self.kx_key.lock().await };
        let Some(kx_key) = kx_key else { return };

        let label_json = match &self.config.label {
            Some(l) => serde_json::to_value(l).unwrap_or(serde_json::json!({"set": false})),
            None => serde_json::json!({"set": false}),
        };
        let payload = serde_json::json!({
            "pk": to_base64(&self.config.key_pair.public_key),
            "role": "daemon",
            "v": WS_PROTOCOL_VERSION,
            "label": label_json,
        });
        let plaintext = payload.to_string();
        let Ok(ct) = seal_random_nonce(plaintext.as_bytes(), &kx_key) else {
            eprintln!("[RelayClient] failed to seal kx broadcast");
            return;
        };
        let _ = self
            .send(RelayClientMessage::KeyExchange {
                ct,
                role: Role::Daemon,
            })
            .await;
    }

    /// Handle a key exchange frame from a frontend. Mirrors `handleKxFrame`
    /// (relay-client.ts:603-723).
    async fn handle_kx_frame(self: &Arc<Self>, frame: tp_relay::KeyExchangeFrame) {
        if frame.from != Role::Frontend {
            return;
        }
        let kx_key = { *self.kx_key.lock().await };
        let Some(kx_key) = kx_key else { return };

        let plaintext = match open(&frame.ct, &kx_key) {
            Ok(p) => p,
            Err(err) => {
                eprintln!("[RelayClient] kx frame decrypt/parse failed: {err}");
                return;
            }
        };
        let data: Value = match serde_json::from_slice(&plaintext) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("[RelayClient] kx frame decrypt/parse failed: {err}");
                return;
            }
        };

        let pk_b64 = data.get("pk").and_then(Value::as_str);
        let frontend_id = data.get("frontendId").and_then(Value::as_str);
        let (Some(pk_b64), Some(frontend_id)) = (pk_b64, frontend_id) else {
            eprintln!(
                "[RelayClient] kx frame missing/invalid pk or frontendId (both must be non-empty strings)"
            );
            return;
        };
        if pk_b64.is_empty() || frontend_id.is_empty() {
            eprintln!(
                "[RelayClient] kx frame missing/invalid pk or frontendId (both must be non-empty strings)"
            );
            return;
        }

        let Some(frontend_pub_key_vec) = from_base64(pk_b64) else {
            eprintln!("[RelayClient] kx frame pk is not valid base64");
            return;
        };
        let Ok(frontend_pub_key): Result<[u8; 32], _> = frontend_pub_key_vec.try_into() else {
            eprintln!("[RelayClient] kx frame pk is not 32 bytes");
            return;
        };

        let session_keys = kx_server_session_keys(
            &self.config.key_pair.public_key,
            &self.config.key_pair.secret_key,
            &frontend_pub_key,
        );

        let protocol_version = data
            .get("v")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(1.0);

        let is_new_peer = { !self.peers.lock().await.contains_key(frontend_id) };

        // Derive this frontend's Pairing Confirmation Tag. Skipped for
        // legacy pairings without a pairingId; a derivation failure is
        // contained.
        let (pct, pct_b64) = if self.config.pairing_id.is_empty() {
            (None, None)
        } else if let Some(pairing_id) = parse_uuid_16(&self.config.pairing_id) {
            let tag = derive_pairing_confirmation_tag(
                &pairing_id,
                &self.config.daemon_id,
                &self.config.hostname,
                &self.config.key_pair.public_key,
                &frontend_pub_key,
                &session_keys.tx,
                &session_keys.rx,
            );
            (Some(tag), Some(to_base64(&tag)))
        } else {
            eprintln!(
                "[RelayClient] PCT derivation failed for frontend {frontend_id}: invalid pairingId"
            );
            (None, None)
        };

        {
            let mut peers = self.peers.lock().await;
            peers.insert(
                frontend_id.to_string(),
                FrontendPeer {
                    public_key: frontend_pub_key,
                    session_keys,
                    protocol_version,
                    pct,
                    pct_b64,
                },
            );
        }

        {
            let mut st = self.state.lock().await;
            st.peerless_reconnects = 0;
            st.had_peer_this_connection = true;
        }

        eprintln!("[RelayClient] key exchange completed with frontend {frontend_id}");

        // kx delivery race fix: re-broadcast our pubkey on a frontend's
        // FIRST join so a late-connecting app (after the auth-time
        // broadcast) still receives it — the relay does not cache kx frames.
        if is_new_peer {
            self.broadcast_daemon_public_key().await;
        }

        if let Some(pct) = pct {
            if let Some(cb) = &self.events.on_peer_confirmed {
                cb(frontend_id, &pct, &frontend_pub_key);
            }
        }

        if let Some(cb) = &self.events.on_frontend_joined {
            cb(frontend_id);
        }
    }

    /// Mirrors `handleFrame` (relay-client.ts:725-765).
    async fn handle_frame(self: &Arc<Self>, frame: tp_relay::Frame) {
        if frame.from != Role::Frontend {
            return;
        }

        if let Some(frontend_id) = &frame.frontend_id {
            let peer_snapshot = {
                let peers = self.peers.lock().await;
                peers
                    .get(frontend_id)
                    .map(|p| (p.session_keys.rx, p.session_keys.tx))
            };
            if let Some((rx, _tx)) = peer_snapshot {
                if let Err(err) = self.decrypt_and_dispatch(&frame, frontend_id, &rx).await {
                    eprintln!(
                        "[RelayClient] decrypt/dispatch failed for peer {frontend_id}: {err}"
                    );
                }
                return;
            }
        }

        // Fallback: try all peers (for backward compat).
        let candidates: Vec<(String, [u8; 32])> = {
            let peers = self.peers.lock().await;
            peers
                .iter()
                .map(|(id, p)| (id.clone(), p.session_keys.rx))
                .collect()
        };
        let peer_count = candidates.len();
        for (frontend_id, rx) in candidates {
            match self.decrypt_and_dispatch(&frame, &frontend_id, &rx).await {
                Ok(()) => return,
                Err(err) => {
                    eprintln!(
                        "[RelayClient] fallback decrypt failed for peer {frontend_id}: {err}"
                    );
                }
            }
        }

        if peer_count == 0 {
            eprintln!(
                "[RelayClient] no frontend peers for decryption (key exchange not completed)"
            );
        }
    }

    /// Mirrors `decryptAndDispatch` (relay-client.ts:767-823).
    async fn decrypt_and_dispatch(
        self: &Arc<Self>,
        frame: &tp_relay::Frame,
        frontend_id: &str,
        rx_key: &[u8; 32],
    ) -> TpResult<()> {
        let plaintext = open(&frame.ct, rx_key)?;
        let msg: Value =
            serde_json::from_slice(&plaintext).map_err(|e| TpError::Codec(e.to_string()))?;
        let t = msg.get("t").and_then(Value::as_str).unwrap_or("");

        if frame.sid == RELAY_CHANNEL_CONTROL && (t == CONTROL_UNPAIR || t == CONTROL_RENAME) {
            let Some(control) = parse_control_message(&msg) else {
                eprintln!("[RelayClient] dropped malformed control frame: t={t}");
                return Ok(());
            };
            match control {
                ControlMessage::Unpair {
                    frontend_id: fid,
                    reason,
                    ..
                } => {
                    if let Some(cb) = &self.events.on_unpair {
                        cb(&fid, reason);
                    }
                }
                ControlMessage::Rename {
                    frontend_id: fid,
                    label,
                    ..
                } => {
                    if let Some(cb) = &self.events.on_rename {
                        cb(&fid, &label);
                    }
                }
            }
            return Ok(());
        }

        if t == "in.chat" || t == "in.term" {
            let sid = msg.get("sid").and_then(Value::as_str);
            let d = msg.get("d").and_then(Value::as_str);
            let (Some(sid), Some(d)) = (sid, d) else {
                eprintln!("[RelayClient] dropped malformed input frame: t={t}");
                return Ok(());
            };
            let kind = if t == "in.chat" {
                InputKind::Chat
            } else {
                InputKind::Term
            };
            if let Some(cb) = &self.events.on_input {
                cb(kind, sid, d, frontend_id);
            }
        } else {
            // Control plane messages (attach/detach/resume/resize/ping/
            // session.*/worktree.*/hello): increment 4 (command dispatcher)
            // owns interpreting the parsed value, so it is handed through
            // raw rather than re-derived into a typed union here.
            if let Some(cb) = &self.events.on_control_message {
                cb(&msg, frontend_id);
            }
        }
        Ok(())
    }

    // ── Outbound send path (relay-client.ts:825-1025) ──────────────────

    /// Encrypt `payload` for `peer` and push it into an outbound `relay.pub`
    /// frame. Mirrors `sendEncrypted` (relay-client.ts:832-841).
    async fn send_encrypted(
        self: &Arc<Self>,
        frontend_id: &str,
        sid: &str,
        seq: u64,
        payload: &Value,
    ) -> bool {
        let tx_key = {
            let peers = self.peers.lock().await;
            peers.get(frontend_id).map(|p| p.session_keys.tx)
        };
        let Some(tx_key) = tx_key else { return false };
        let plaintext = payload.to_string();
        let Ok(ct) = seal_random_nonce(plaintext.as_bytes(), &tx_key) else {
            return false;
        };
        self.send(RelayClientMessage::Publish {
            sid: sid.to_string(),
            ct,
            seq,
        })
        .await
    }

    /// Broadcast `payload` to every connected peer under `sid`/`seq`.
    /// Best-effort per peer — mirrors `broadcastEncrypted`
    /// (relay-client.ts:843-866).
    async fn broadcast_encrypted(self: &Arc<Self>, sid: &str, seq: u64, payload: &Value) {
        let authenticated = self.state.lock().await.authenticated;
        let frontend_ids: Vec<String> = self.peers.lock().await.keys().cloned().collect();
        if !authenticated || frontend_ids.is_empty() {
            return;
        }
        for frontend_id in frontend_ids {
            // send_encrypted already contains its own failure (returns
            // false rather than propagating) — mirrored here as a
            // best-effort continue-on-failure loop, matching the TS
            // try/catch-per-peer.
            let _ = self.send_encrypted(&frontend_id, sid, seq, payload).await;
        }
    }

    /// Encrypt and publish a WS record to all connected frontends.
    pub async fn publish_record(self: &Arc<Self>, sid: &str, seq: u64, rec: &Value) {
        self.broadcast_encrypted(sid, seq, rec).await;
    }

    /// Encrypt and publish a state update to all connected frontends.
    pub async fn publish_state(self: &Arc<Self>, sid: &str, state_msg: &Value) {
        self.broadcast_encrypted(sid, 0, state_msg).await;
    }

    /// Encrypt and publish a `session.removed` notice to all connected
    /// frontends.
    pub async fn publish_removed(self: &Arc<Self>, sid: &str, msg: &Value) {
        self.broadcast_encrypted(sid, 0, msg).await;
    }

    /// Encrypt and publish a message to a specific frontend peer.
    pub async fn publish_to_peer(self: &Arc<Self>, frontend_id: &str, sid: &str, msg: &Value) {
        if !self.state.lock().await.authenticated {
            return;
        }
        if !self.peers.lock().await.contains_key(frontend_id) {
            return;
        }
        let _ = self.send_encrypted(frontend_id, sid, 0, msg).await;
    }

    /// Send an encrypted control frame (unpair / rename) to `frontend_id` on
    /// the virtual `RELAY_CHANNEL_CONTROL` sid. Mirrors `sendControl`
    /// (relay-client.ts:911-940).
    async fn send_control(self: &Arc<Self>, method: &str, frontend_id: &str, msg: &Value) -> bool {
        if !self.state.lock().await.authenticated {
            eprintln!(
                "[RelayClient] {method}: not authenticated; skipping notice for {frontend_id}"
            );
            return false;
        }
        if !self.peers.lock().await.contains_key(frontend_id) {
            eprintln!(
                "[RelayClient] {method}: no peer session for frontend {frontend_id}; skipping"
            );
            return false;
        }
        self.send_encrypted(frontend_id, RELAY_CHANNEL_CONTROL, 0, msg)
            .await
    }

    /// Send an unpair control notice to a specific frontend peer. Mirrors
    /// `sendUnpairNotice` (relay-client.ts:947-959).
    pub async fn send_unpair_notice(
        self: &Arc<Self>,
        frontend_id: &str,
        reason: UnpairReason,
    ) -> bool {
        let control = ControlMessage::Unpair {
            daemon_id: self.config.daemon_id.clone(),
            frontend_id: frontend_id.to_string(),
            reason,
            ts: now_ms(),
        };
        let msg = serde_json::to_value(&control).unwrap_or(Value::Null);
        self.send_control("sendUnpairNotice", frontend_id, &msg)
            .await
    }

    /// Encrypted control.rename notice to `frontend_id`. Mirrors
    /// `sendRenameNotice` (relay-client.ts:971-980).
    pub async fn send_rename_notice(self: &Arc<Self>, frontend_id: &str, label: Label) -> bool {
        let control = ControlMessage::Rename {
            daemon_id: self.config.daemon_id.clone(),
            frontend_id: frontend_id.to_string(),
            label,
            ts: now_ms(),
        };
        let msg = serde_json::to_value(&control).unwrap_or(Value::Null);
        self.send_control("sendRenameNotice", frontend_id, &msg)
            .await
    }

    /// Send a push notification request to the relay server. Mirrors
    /// `sendPush` (relay-client.ts:992-1025).
    pub async fn send_push(
        self: &Arc<Self>,
        frontend_id: &str,
        sealed: &str,
        title: &str,
        body: &str,
        interruption_level: Option<InterruptionLevel>,
        data: Option<(&str, Option<&str>, &str)>,
    ) -> bool {
        if !self.state.lock().await.authenticated {
            return false;
        }
        let push_data = data.map(|(sid, daemon_id, event)| PushData {
            sid: sid.to_string(),
            daemon_id: daemon_id.unwrap_or(&self.config.daemon_id).to_string(),
            event: event.to_string(),
        });
        self.send(RelayClientMessage::Push {
            frontend_id: frontend_id.to_string(),
            sealed: sealed.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            interruption_level,
            data: push_data,
        })
        .await
    }

    /// Mirrors `subscribe` (relay-client.ts:1027-1032).
    pub async fn subscribe(self: &Arc<Self>, sid: &str) {
        let authenticated = {
            let mut st = self.state.lock().await;
            st.subscribed_sessions.insert(sid.to_string());
            st.authenticated
        };
        if authenticated {
            let _ = self
                .send(RelayClientMessage::Subscribe {
                    sid: sid.to_string(),
                    after: None,
                })
                .await;
        }
    }

    /// Mirrors `unsubscribe` (relay-client.ts:1034-1039).
    pub async fn unsubscribe(self: &Arc<Self>, sid: &str) {
        let authenticated = {
            let mut st = self.state.lock().await;
            st.subscribed_sessions.remove(sid);
            st.authenticated
        };
        if authenticated {
            let _ = self
                .send(RelayClientMessage::Unsubscribe {
                    sid: sid.to_string(),
                })
                .await;
        }
    }

    /// Mirrors `startPing` (relay-client.ts:1041-1053) — spawns a periodic
    /// ping task rather than installing a JS interval. Guards against a
    /// `dispose()` racing an in-flight auth.ok handler by re-checking
    /// `disposed` (and the generation) both before spawning and on every
    /// tick.
    fn start_ping(self: &Arc<Self>) {
        let this = Arc::clone(self);
        let task = tokio::spawn(async move {
            if this.state.lock().await.disposed {
                return;
            }
            let generation = this.state.lock().await.generation;
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(PING_INTERVAL_MS));
            interval.tick().await; // first tick fires immediately; skip it
            loop {
                interval.tick().await;
                let st = this.state.lock().await;
                if st.disposed || st.generation != generation {
                    return;
                }
                drop(st);
                let _ = this
                    .send(RelayClientMessage::Ping { ts: Some(now_ms()) })
                    .await;
            }
        });
        // Fire-and-forget: the task self-terminates on disposed/generation
        // mismatch, mirroring `clearInterval` being implied by a fresh
        // `cleanup()`'s generation bump. Not tracked in `tasks` because the
        // ping loop's own guards make explicit abort unnecessary and
        // avoiding a `.lock().await` inside `start_ping`'s synchronous
        // caller path keeps this callable from non-async contexts later.
        drop(task);
    }

    /// Write `msg` to the relay socket. Returns `true` only if the frame was
    /// actually handed to a live outbound channel. Mirrors `send`
    /// (relay-client.ts:1069-1075) — the real-transmitted-bool contract that
    /// `sendEncrypted`/`sendControl`/`sendUnpairNotice`/`sendRenameNotice`
    /// all propagate so callers never overcount delivered frames.
    #[must_use]
    async fn send(self: &Arc<Self>, msg: RelayClientMessage) -> bool {
        let tx = { self.state.lock().await.ws_tx.clone() };
        let Some(tx) = tx else { return false };
        let Ok(text) = serde_json::to_string(&msg) else {
            return false;
        };
        tx.try_send(Message::Text(text.into())).is_ok()
    }

    /// Mirrors `scheduleReconnect` (relay-client.ts:1077-1111).
    fn schedule_reconnect(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            if this.state.lock().await.disposed {
                return;
            }
            let (delay_ms, generation) = {
                let mut st = this.state.lock().await;
                st.peerless_reconnects =
                    next_peerless_reconnects(st.peerless_reconnects, st.had_peer_this_connection);
                let plan = compute_reconnect_plan(st.reconnect_attempt, st.peerless_reconnects);
                st.reconnect_attempt = plan.next_attempt;
                (plan.delay_ms, st.generation)
            };
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            {
                let st = this.state.lock().await;
                if st.disposed || st.generation != generation {
                    return;
                }
            }
            // connect() itself contains its own failure handling (it calls
            // schedule_reconnect again on a connect error) — mirroring the
            // TS `.catch(err => { log; scheduleReconnect(); })` wrapper so a
            // failing connect never permanently kills the reconnect loop.
            this.connect().await;
        });
    }

    /// Close the live socket if one is open (used by the register.err /
    /// auth.err arms to force an immediate reconnect instead of waiting for
    /// the relay's slowloris auth-timeout). The close is realized by
    /// dropping the outbound sender, which ends the writer task and lets the
    /// reader task observe EOF/close on its next poll.
    async fn close_socket(self: &Arc<Self>) {
        let mut st = self.state.lock().await;
        st.ws_tx = None;
    }

    /// Mirrors `cleanup()` (relay-client.ts:1113-1138).
    async fn cleanup(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().await;
            st.had_peer_this_connection = false;
            st.ws_tx = None;
            st.generation += 1; // invalidates any still-running read loop
        }
        let mut tasks = self.tasks.lock().await;
        for task in tasks.drain(..) {
            task.abort();
        }
    }

    /// Mirrors `dispose()` (relay-client.ts:1140-1143).
    pub async fn dispose(self: &Arc<Self>) {
        self.state.lock().await.disposed = true;
        self.cleanup().await;
    }

    /// True once `relay.auth.ok` has been received. Mirrors `isConnected()`
    /// (relay-client.ts:1150-1152).
    pub async fn is_connected(self: &Arc<Self>) -> bool {
        self.state.lock().await.authenticated
    }

    /// Mirrors `getPeerCount()` (relay-client.ts:1154-1156).
    pub async fn get_peer_count(self: &Arc<Self>) -> usize {
        self.peers.lock().await.len()
    }

    /// Mirrors `isThrottled()` (relay-client.ts:1169-1171).
    pub async fn is_throttled(self: &Arc<Self>) -> bool {
        self.state.lock().await.peerless_reconnects >= PEERLESS_RECONNECT_THRESHOLD
    }

    /// Mirrors `listPeerFrontendIds()` (relay-client.ts:1174-1176).
    pub async fn list_peer_frontend_ids(self: &Arc<Self>) -> Vec<String> {
        self.peers.lock().await.keys().cloned().collect()
    }

    /// Mirrors `peerPct()` (relay-client.ts:1184-1186).
    pub async fn peer_pct(self: &Arc<Self>, frontend_id: &str) -> Option<[u8; 32]> {
        self.peers.lock().await.get(frontend_id).and_then(|p| p.pct)
    }

    /// Mirrors `peerPctB64()` (relay-client.ts:1189-1191).
    pub async fn peer_pct_b64(self: &Arc<Self>, frontend_id: &str) -> Option<String> {
        self.peers
            .lock()
            .await
            .get(frontend_id)
            .and_then(|p| p.pct_b64.clone())
    }

    /// The daemonId this client is registered as on the relay. Mirrors the
    /// `daemonId` getter (relay-client.ts:1193-1196).
    #[must_use]
    pub fn daemon_id(&self) -> &str {
        &self.config.daemon_id
    }

    /// The relay URL this client connects to. Mirrors the `relayUrl` getter
    /// (relay-client.ts:1198-1201).
    #[must_use]
    pub fn relay_url(&self) -> &str {
        &self.config.relay_url
    }

    /// The pairing label for this relay client. Mirrors the `label` getter
    /// (relay-client.ts:1203-1207).
    #[must_use]
    pub fn label(&self) -> Option<&Label> {
        self.config.label.as_ref()
    }
}

/// Half of the split WS stream used by the read loop.
type WsReadHalf = futures_util::stream::SplitStream<Ws>;

/// `seal(plaintext, key)` with a fresh random nonce — the daemon side never
/// needs a caller-supplied nonce (only golden-vector tests in `tp-core` pin
/// specific nonces), so this wraps `tp_core::crypto::seal` with an
/// OS-random 24-byte `XChaCha20` nonce, mirroring what the TS libsodium
/// `crypto_aead_xchacha20poly1305_ietf_encrypt` binding does internally when
/// no nonce is supplied.
fn seal_random_nonce(plaintext: &[u8], key: &[u8; 32]) -> TpResult<String> {
    use rand_core::{OsRng, RngCore};
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    seal(plaintext, key, &nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── compute_reconnect_plan parity table ─────────────────────────────

    #[test]
    fn reconnect_plan_exponential_backoff() {
        assert_eq!(
            compute_reconnect_plan(0, 0),
            ReconnectPlan {
                delay_ms: 1000,
                next_attempt: 1
            }
        );
        assert_eq!(
            compute_reconnect_plan(1, 0),
            ReconnectPlan {
                delay_ms: 2000,
                next_attempt: 2
            }
        );
        assert_eq!(
            compute_reconnect_plan(2, 0),
            ReconnectPlan {
                delay_ms: 4000,
                next_attempt: 3
            }
        );
        assert_eq!(
            compute_reconnect_plan(3, 0),
            ReconnectPlan {
                delay_ms: 8000,
                next_attempt: 4
            }
        );
        assert_eq!(
            compute_reconnect_plan(4, 0),
            ReconnectPlan {
                delay_ms: 16_000,
                next_attempt: 5
            }
        );
        // attempt=5 → 1000*2^5=32000, capped at 30000; next_attempt clamped
        // to MAX_RECONNECT_ATTEMPT (5).
        assert_eq!(
            compute_reconnect_plan(5, 0),
            ReconnectPlan {
                delay_ms: 30_000,
                next_attempt: 5
            }
        );
        // Beyond MAX_RECONNECT_ATTEMPT stays pinned at the cap.
        assert_eq!(
            compute_reconnect_plan(10, 0),
            ReconnectPlan {
                delay_ms: 30_000,
                next_attempt: 5
            }
        );
    }

    #[test]
    fn reconnect_plan_peerless_throttle_engages_at_threshold() {
        // Below threshold: normal backoff still applies.
        assert_eq!(
            compute_reconnect_plan(2, 2),
            ReconnectPlan {
                delay_ms: 4000,
                next_attempt: 3
            }
        );
        // At threshold: throttled to 30 min, attempt UNCHANGED (critical —
        // a recovered pairing resumes fast backoff from where it left off).
        assert_eq!(
            compute_reconnect_plan(2, 3),
            ReconnectPlan {
                delay_ms: PEERLESS_RECONNECT_MS,
                next_attempt: 2
            }
        );
        // Above threshold: still throttled.
        assert_eq!(
            compute_reconnect_plan(0, 100),
            ReconnectPlan {
                delay_ms: PEERLESS_RECONNECT_MS,
                next_attempt: 0
            }
        );
    }

    #[test]
    fn reconnect_plan_throttle_takes_priority_even_at_attempt_zero() {
        // Even a fresh connection (attempt=0) is throttled once peerless
        // count crosses the threshold — the throttle is independent of the
        // backoff attempt counter.
        let plan = compute_reconnect_plan(0, PEERLESS_RECONNECT_THRESHOLD);
        assert_eq!(plan.delay_ms, PEERLESS_RECONNECT_MS);
        assert_eq!(plan.next_attempt, 0);
    }

    // ── next_peerless_reconnects arm/reset ──────────────────────────────

    #[test]
    fn peerless_reconnects_resets_on_peer() {
        assert_eq!(next_peerless_reconnects(5, true), 0);
        assert_eq!(next_peerless_reconnects(0, true), 0);
    }

    #[test]
    fn peerless_reconnects_increments_without_peer() {
        assert_eq!(next_peerless_reconnects(0, false), 1);
        assert_eq!(next_peerless_reconnects(2, false), 3);
        assert_eq!(next_peerless_reconnects(100, false), 101);
    }

    #[test]
    fn peerless_reconnects_full_arm_then_reset_sequence() {
        // Simulates 3 peerless reconnects hitting the threshold, then a real
        // peer joining and resetting it.
        let mut count = 0u32;
        for _ in 0..PEERLESS_RECONNECT_THRESHOLD {
            count = next_peerless_reconnects(count, false);
        }
        assert_eq!(count, PEERLESS_RECONNECT_THRESHOLD);
        assert!(compute_reconnect_plan(1, count).delay_ms == PEERLESS_RECONNECT_MS);
        // A real peer joins.
        count = next_peerless_reconnects(count, true);
        assert_eq!(count, 0);
        assert!(compute_reconnect_plan(1, count).delay_ms < PEERLESS_RECONNECT_MS);
    }

    // ── local helpers ────────────────────────────────────────────────────

    #[test]
    fn base64_roundtrip() {
        let bytes = [1u8, 2, 3, 4, 250, 251, 252];
        let encoded = to_base64(&bytes);
        assert_eq!(from_base64(&encoded).unwrap(), bytes.to_vec());
    }

    #[test]
    fn parse_uuid_16_accepts_canonical_and_bare_hex() {
        let canonical = "01020304-0506-0708-090a-0b0c0d0e0f10";
        let expected: [u8; 16] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10,
        ];
        assert_eq!(parse_uuid_16(canonical), Some(expected));
        let bare = "0102030405060708090a0b0c0d0e0f10";
        assert_eq!(parse_uuid_16(bare), Some(expected));
        // Uppercase hex accepted.
        assert_eq!(
            parse_uuid_16("01020304-0506-0708-090A-0B0C0D0E0F10"),
            Some(expected)
        );
    }

    #[test]
    fn parse_uuid_16_rejects_malformed() {
        assert_eq!(parse_uuid_16("too-short"), None);
        assert_eq!(parse_uuid_16(""), None);
        assert_eq!(
            parse_uuid_16("0102030405060708090a0b0c0d0e0f1g"), // non-hex 'g'
            None
        );
        assert_eq!(
            parse_uuid_16("0102030405060708090a0b0c0d0e0f100"), // too long
            None
        );
    }

    #[test]
    fn seal_random_nonce_produces_openable_ciphertext() {
        let key = [7u8; 32];
        let ct = seal_random_nonce(b"hello world", &key).unwrap();
        let plaintext = open(&ct, &key).unwrap();
        assert_eq!(plaintext, b"hello world");
    }
}
