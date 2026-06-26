//! Per-connection actor + axum WebSocket upgrade + the stale-check task.
//!
//! The [`RelayServer`] builds an axum `Router` with a single GET `/` WebSocket
//! upgrade route (NO `/health`/`/metrics`/`/admin` — those are Step 6). Each
//! upgraded socket is driven by [`connection_loop`]:
//!
//! * a **write task** owns the ws write half and drains the per-conn bounded
//!   `mpsc::Receiver` into `Message::Text(json)`;
//! * the **read loop** parses inbound text, resets the idle `Interval`, runs the
//!   2-layer GCRA rate limit (ping-exempt for authed clients), dispatches the
//!   handshake/routing **synchronously under the lock**, then delivers the
//!   resulting `Vec<Action>` outside the lock via `try_send`.
//!
//! Timeouts: an auth deadline (1008 close if not authed within 10 s) and an idle
//! `Interval` (close if no inbound frame for 90 s — daemon pings every 30 s keep
//! it alive).
//!
//! ## No-lock-across-await audit
//!
//! The conn loop acquires `state.core.lock()` only inside `dispatch_locked`,
//! which is a **synchronous** function: it takes `&mut RelayCore`, returns an
//! owned `Vec<Action>`, and contains no `.await`. The caller drops the guard at
//! the end of that call and only then awaits `deliver_actions`. The handshake
//! path is the same shape. See the `// LOCK:` comments at each `lock()` site.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::handshake;
use crate::messages::{Notification, PushToken, RelayErr, RelayServerMessage};
use crate::push::{DeliveryResult, PushRequest, PushService};
use crate::push_seal::{global_push_sealer, UnsealResult};
use crate::resume_token::ResumePayload;
use crate::server::{
    handle_close, now_ms, presence_actions, register_authed_conn, route_key_exchange, route_ping,
    route_publish, route_subscribe, route_unsubscribe, Action, AuthState, ConnHandle, ConnId,
    RelayCore, SharedState, STALE_CHECK_INTERVAL_MS, WS_IDLE_TIMEOUT_S,
};
use std::sync::Arc;
use tp_proto::relay_client::{
    parse_relay_client_message, InterruptionLevel, PushData as WirePushData, RelayClientMessage,
    Role,
};

/// Auth handshake timeout. A socket that never authenticates within this window
/// is closed with 1008. Mirrors `AUTH_TIMEOUT_MS = 10_000` (`relay-server.ts:90`).
pub const AUTH_TIMEOUT_MS: u64 = 10_000;

/// Default max inbound frame size (bytes). Mirrors `DEFAULT_MAX_FRAME_SIZE`
/// (`relay-server.ts:70`, 1 MiB) and the `maxFrameSize` single-node knob in
/// `.claude/rules/relay-capacity.md`. Override via `TP_RELAY_MAX_FRAME_SIZE`.
pub const DEFAULT_MAX_FRAME_SIZE: usize = 1024 * 1024;

/// Resolve the max inbound frame size from `TP_RELAY_MAX_FRAME_SIZE`, falling
/// back to [`DEFAULT_MAX_FRAME_SIZE`]. Mirrors `relay-server.ts:312-315`.
#[must_use]
pub fn max_frame_size_from_env() -> usize {
    std::env::var("TP_RELAY_MAX_FRAME_SIZE")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_FRAME_SIZE)
}

/// The relay server. Holds the shared state and binds an axum router.
pub struct RelayServer {
    state: SharedState,
}

impl RelayServer {
    /// Construct from environment configuration.
    #[must_use]
    pub fn from_env() -> Self {
        Self {
            state: SharedState::from_env(),
        }
    }

    /// Construct from an explicit [`SharedState`] (tests).
    #[must_use]
    pub fn with_state(state: SharedState) -> Self {
        Self { state }
    }

    /// Borrow the shared state (tests / external stale-task wiring).
    #[must_use]
    pub fn state(&self) -> &SharedState {
        &self.state
    }

    /// Build the axum router: the GET `/` WebSocket upgrade route plus the
    /// Step-6 HTTP surface (`/health`, `/metrics`, `/admin`). All four routes
    /// share the SAME `Router` + `SharedState` + listener — no new `TcpListener`.
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", get(ws_upgrade))
            .route("/health", get(crate::http::health))
            .route("/metrics", get(crate::http::metrics))
            .route("/admin", get(crate::http::admin))
            .with_state(self.state.clone())
    }

    /// Spawn the periodic stale-check sweep (30 s). Returns the join handle.
    /// On each tick it runs `check_stale_daemons` under the lock, collects
    /// presence actions for newly-offline daemons and `recentFrames` purges for
    /// evicted daemons, then delivers presence outside the lock.
    #[must_use]
    pub fn spawn_stale_check(&self) -> tokio::task::JoinHandle<()> {
        let state = self.state.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(STALE_CHECK_INTERVAL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let actions = stale_sweep(&state);
                deliver_actions(&state, actions).await;
            }
        })
    }

    /// Bind a TCP listener and serve until the process exits. Convenience entry
    /// point for a `tp relay` binary (not used by the integration tests, which
    /// drive `router()` over a loopback listener directly).
    ///
    /// # Errors
    ///
    /// Returns any bind or serve I/O error.
    pub async fn serve(self, addr: std::net::SocketAddr) -> std::io::Result<()> {
        let listener = TcpListener::bind(addr).await?;
        // Detach the stale-check task: it runs for the lifetime of `serve`, which
        // never returns until the process exits, so its handle is intentionally
        // dropped here (the task is cancelled when the runtime shuts down).
        let _stale = self.spawn_stale_check();
        axum::serve(listener, self.router()).await
    }

    /// Like [`serve`](Self::serve) but stops accepting new connections and drains
    /// in-flight ones once `shutdown` resolves. The `tp-relay` binary wires
    /// `shutdown` to SIGINT/SIGTERM so a `systemctl stop` / Ctrl-C exits cleanly
    /// instead of being killed mid-frame.
    ///
    /// # Errors
    ///
    /// Returns any bind or serve I/O error.
    pub async fn serve_with_shutdown<F>(
        self,
        addr: std::net::SocketAddr,
        shutdown: F,
    ) -> std::io::Result<()>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind(addr).await?;
        // The stale-check task is cancelled when the runtime shuts down after
        // `serve` returns, so its handle is intentionally dropped here.
        let _stale = self.spawn_stale_check();
        axum::serve(listener, self.router())
            .with_graceful_shutdown(shutdown)
            .await
    }
}

/// Run one stale-check sweep synchronously under the lock, returning presence
/// actions for newly-offline daemons. Evicted daemons have their recent-frame
/// cache purged inside the same critical section. No `.await` inside.
fn stale_sweep(state: &SharedState) -> Vec<Action> {
    // LOCK: synchronous critical section — no `.await` between lock() and drop.
    let mut core = state.core.lock().expect("relay core mutex poisoned");
    let now = now_ms();
    let result =
        core.registry
            .check_stale_daemons(now, state.stale_timeout_ms, state.offline_evict_ms);
    let mut actions = Vec::new();
    for daemon_id in &result.newly_offline {
        actions.extend(presence_actions(&core, daemon_id));
    }
    for daemon_id in &result.evicted {
        core.recent.purge_daemon(daemon_id);
        // Evict the per-daemon group-rate limiter so it doesn't leak (#17).
        core.group_limiters.remove(daemon_id);
        // evictions++ per evicted daemon (relay-server.ts evictDaemon).
        state.metrics.inc_evictions();
    }
    actions
    // guard dropped here
}

/// axum WebSocket upgrade handler. Hands the upgraded socket to
/// [`connection_loop`].
async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<SharedState>) -> Response {
    // Bound the transport too: tungstenite rejects giant (possibly fragmented)
    // frames before they fully buffer, so the application-level guard in
    // `handle_inbound` is a defence-in-depth backstop rather than the only line.
    // We size the transport ceiling slightly above the app limit so the app
    // guard (with its `relay.err FRAME_TOO_LARGE` + 1009 close) is what fires for
    // a normal oversize, while the transport only kills the pathological case.
    let max = state.max_frame_size;
    let ws = ws
        .max_message_size(max.saturating_mul(2))
        .max_frame_size(max.saturating_mul(2));
    ws.on_upgrade(move |socket| connection_loop(socket, state))
}

/// Drive one upgraded WebSocket: register the outbox, spawn the write task, run
/// the read loop with auth + idle timers, and tear down on exit.
async fn connection_loop(socket: WebSocket, state: SharedState) {
    let conn_id = state.alloc_conn_id();
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<RelayServerMessage>(state.outbox_cap);
    // Out-of-band close channel: the backpressure path (and our own teardown)
    // pushes `(code, reason)` here; the write task emits the WS Close frame. A
    // clone lives in the ConnHandle so `close_conn` can force-close a slow
    // consumer whose read loop is idle.
    let (close_tx, mut close_rx) = mpsc::channel::<(u16, String)>(4);

    // Register the conn handle + outbox sender.
    {
        // LOCK: synchronous — insert the conn handle. No `.await` inside.
        let mut core = state.core.lock().expect("relay core mutex poisoned");
        let rate = core.rate_per_client;
        core.conns
            .insert(conn_id, ConnHandle::new(out_tx, close_tx.clone(), rate));
        // guard dropped here
    }

    // Write task: drain the outbox into the socket as plain-text JSON. A control
    // `Close` directive arrives on `close_rx` and is emitted before teardown.
    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // `biased`: a pending close directive ALWAYS wins over an
                // out_rx-closed break. Teardown drops the ConnHandle (closing
                // out_rx) and THEN sends the close on close_rx; without bias the
                // select! would pseudo-randomly take the out_rx==None arm and
                // silently drop the intended close code (1008/1009/1013). Bias +
                // close-first makes close-code delivery deterministic, matching
                // the TS `ws.close(code, reason)` guarantee.
                biased;
                maybe_close = close_rx.recv() => {
                    if let Some((code, reason)) = maybe_close {
                        let _ = ws_tx
                            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code,
                                reason: reason.into(),
                            })))
                            .await;
                    }
                    break;
                }
                maybe_msg = out_rx.recv() => {
                    match maybe_msg {
                        Some(msg) => {
                            let json = serde_json::to_string(&msg)
                                .unwrap_or_else(|_| "{\"t\":\"relay.err\",\"e\":\"ENCODE\"}".into());
                            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Auth deadline + idle interval.
    let auth_deadline = tokio::time::sleep(Duration::from_millis(AUTH_TIMEOUT_MS));
    tokio::pin!(auth_deadline);
    let mut idle = tokio::time::interval(Duration::from_secs(WS_IDLE_TIMEOUT_S));
    idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    idle.tick().await; // consume the immediate first tick

    let mut closed_reason: Option<(u16, &'static str)> = None;

    // Cache the authed flag: once a connection authenticates it stays authed
    // for the rest of its lifetime, so we avoid re-locking the core mutex on
    // every loop iteration. The flag is updated after handling an inbound frame
    // (which may have been a relay.auth / relay.auth.resume message).
    let mut authed = is_authed(&state, conn_id);

    loop {
        tokio::select! {
            // `biased`: process a ready inbound frame BEFORE the auth-deadline
            // arm. A client that sends `relay.auth` exactly at the 10 s boundary
            // would otherwise be pseudo-randomly closed with 1008 even though
            // its auth frame was deliverable in the same wake — this mirrors the
            // TS clear-on-auth ordering (the auth message processes and clears
            // the deadline synchronously). Idle/auth timers only win when no
            // inbound frame is pending.
            biased;
            // Inbound frame.
            maybe_frame = ws_rx.next() => {
                let Some(frame) = maybe_frame else { break };
                let Ok(frame) = frame else { break };
                match frame {
                    Message::Text(text) => {
                        // Reset the idle deadline only on a genuine relay
                        // protocol message — NOT on transport-level Ping/Pong or
                        // junk Binary frames. A peer emitting only WS keepalive
                        // pings must still hit the 90 s idle close (TS ties the
                        // liveness reset to real relay.* traffic, daemon pings at
                        // ~30 s). Reset before dispatch so a slow handler doesn't
                        // shrink the window.
                        idle.reset();
                        if let Some((code, reason)) = handle_inbound(&state, conn_id, &text).await {
                            closed_reason = Some((code, reason));
                            break;
                        }
                        // Re-check authed only while not yet authenticated
                        // (auth transitions once: unauthenticated → authenticated).
                        if !authed {
                            authed = is_authed(&state, conn_id);
                        }
                    }
                    Message::Close(_) => break,
                    // Binary frames are ignored (the relay WS is plain-text JSON
                    // only); WS-level Ping/Pong keepalive is handled by the
                    // transport and does NOT reset the idle deadline.
                    Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => {}
                }
            }
            // Auth timeout — only fires while still unauthenticated.
            () = &mut auth_deadline, if !authed => {
                // authTimeouts++ (relay-server.ts:522).
                state.metrics.inc_auth_timeouts();
                closed_reason = Some((1008, "Auth timeout"));
                break;
            }
            // Idle timeout — no inbound relay frame within the window.
            _ = idle.tick() => {
                closed_reason = Some((1008, "Idle timeout"));
                break;
            }
        }
    }

    // Issue the close frame FIRST, while this conn's outbox is still registered
    // (handle_close below drops the ConnHandle → out_tx → out_rx, which would
    // otherwise race the close in the write task). With the close enqueued
    // before teardown and the write task's `biased; close_rx`-first select!,
    // the close code (1008/1009/1013) is delivered deterministically.
    if let Some((code, reason)) = closed_reason {
        let _ = close_tx.send((code, reason.to_string())).await;
    }
    drop(close_tx);

    // Tear down: mark offline / release attached, then broadcast presence.
    let presence = {
        // LOCK: synchronous teardown. No `.await` inside.
        let mut core = state.core.lock().expect("relay core mutex poisoned");
        let daemon = handle_close(&mut core, conn_id, now_ms());
        daemon.map(|d| presence_actions(&core, &d))
        // guard dropped here
    };
    if let Some(actions) = presence {
        deliver_actions(&state, actions).await;
    }

    let _ = write_task.await;
}

/// Cheap authed-check (separate short lock). Synchronous; no `.await`.
fn is_authed(state: &SharedState, conn_id: ConnId) -> bool {
    // LOCK: synchronous read. No `.await` inside.
    let core = state.core.lock().expect("relay core mutex poisoned");
    core.conns.get(&conn_id).is_some_and(|h| h.auth.is_some())
    // guard dropped here
}

/// Handle one inbound text frame. Returns `Some((code, reason))` when the
/// connection must be closed (backpressure 1013), else `None`.
///
/// The flow mirrors `relay-server.ts:660-757`: parse → (authed) 2-layer rate
/// limit (ping-exempt) → dispatch under the lock → deliver outside the lock.
async fn handle_inbound(
    state: &SharedState,
    conn_id: ConnId,
    text: &str,
) -> Option<(u16, &'static str)> {
    // Max-frame-size guard — checked BEFORE any parse/rate/auth work so an
    // oversized frame can never amplify CPU/memory (10k-conn capacity bar). The
    // String is already materialized by the transport, but we reject it before
    // the far costlier `serde_json::Value` allocation. Mirrors the TS reference
    // (`relay-server.ts:633-647`): count `oversizedDrops`, send `relay.err
    // FRAME_TOO_LARGE`, close 1009. `text.len()` is the UTF-8 byte length, which
    // matches `Buffer.byteLength(raw)` for a JSON text frame.
    let size = text.len();
    if size > state.max_frame_size {
        // oversizedDrops++ (relay-server.ts:636).
        state.metrics.inc_oversized_drops();
        deliver_actions(
            state,
            vec![Action::Send(
                conn_id,
                RelayServerMessage::Err(RelayErr {
                    e: "FRAME_TOO_LARGE".to_string(),
                    m: Some(format!(
                        "Frame size {size} exceeds limit of {} bytes",
                        state.max_frame_size
                    )),
                }),
            )],
        )
        .await;
        return Some((1009, "Frame too large"));
    }

    // framesIn++ — count every frame past the oversize guard, BEFORE the JSON
    // parse (relay-server.ts:648). A subsequent PARSE_ERROR / UNKNOWN_TYPE does
    // NOT decrement, preserving the `framesIn ≈ framesOut + drops` accounting.
    state.metrics.inc_frames_in();

    // Pre-auth throttle: count every frame from unauthenticated sockets BEFORE
    // parse (mirrors relay-server.ts:742-754). The counter lives in ConnHandle
    // behind the RelayCore mutex. LOCK: synchronous — read/increment
    // preauth_count, check auth. No .await inside the block.
    {
        let close_preauth = {
            let mut core = state.core.lock().expect("relay core mutex poisoned");
            if let Some(handle) = core.conns.get_mut(&conn_id) {
                if handle.auth.is_none() {
                    handle.preauth_count += 1;
                    handle.preauth_count > state.max_preauth_msgs
                } else {
                    false
                }
            } else {
                false
            }
            // guard dropped here
        };
        if close_preauth {
            return Some((1008, "Too many pre-auth messages"));
        }
    }

    // Parse JSON; malformed → relay.err PARSE_ERROR (relay-server.ts:656).
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        deliver_actions(
            state,
            vec![Action::Send(
                conn_id,
                RelayServerMessage::Err(RelayErr {
                    e: "PARSE_ERROR".to_string(),
                    m: Some("Invalid JSON".to_string()),
                }),
            )],
        )
        .await;
        return None;
    };

    // Zero-trust validation: unknown/malformed → UNKNOWN_TYPE (relay-server.ts:676).
    let Some(msg) = parse_relay_client_message(&value) else {
        let t = value
            .get("t")
            .and_then(Value::as_str)
            .unwrap_or("(none)")
            .to_string();
        // unknownTypeDrops++ (relay-server.ts:675).
        state.metrics.inc_unknown_type_drops();
        deliver_actions(
            state,
            vec![Action::Send(
                conn_id,
                RelayServerMessage::Err(RelayErr {
                    e: "UNKNOWN_TYPE".to_string(),
                    m: Some(format!("Unknown or malformed message type: {t}")),
                }),
            )],
        )
        .await;
        return None;
    };

    // ── relay.push intercept (daemon → relay → APNs) ─────────────────────────
    //
    // `relay.push` is the ONLY arm whose work is async (the APNs HTTP/2 send),
    // so it cannot be handled inside the synchronous, lock-held `dispatch_locked`
    // (no `.await` may run under the RelayCore mutex). Intercept it here BEFORE
    // the dispatch lock block: take ONE short synchronous lock to run the role
    // gate + target-frontend lookup + token unseal (all sync), drop the lock,
    // then `tokio::spawn` the async `send_or_deliver` and deliver its mapped
    // reply. Mirrors `relay-server.ts handlePush:1351-1483`.
    if let RelayClientMessage::Push {
        frontend_id,
        sealed,
        title,
        body,
        interruption_level,
        data,
    } = &msg
    {
        return handle_push(
            state,
            conn_id,
            frontend_id,
            sealed,
            title,
            body,
            interruption_level.as_ref(),
            data.as_ref(),
        )
        .await;
    }

    // Dispatch synchronously under the lock; collect actions; release lock.
    // Metrics are an Arc shared outside the RelayCore lock; the rate-limit +
    // resume counters increment from inside dispatch (no extra lock taken).
    let outcome = {
        // LOCK: synchronous dispatch — no `.await` between lock() and drop.
        let mut core = state.core.lock().expect("relay core mutex poisoned");
        dispatch_locked(&mut core, &state.signer, &state.metrics, conn_id, &msg)
        // guard dropped here
    };

    // Deliver the produced actions outside the lock.
    deliver_actions(state, outcome.actions).await;
    outcome.close
}

/// Output of a single synchronous dispatch: the actions to deliver and an
/// optional close directive (backpressure is signalled later, in delivery).
struct DispatchOutcome {
    actions: Vec<Action>,
    close: Option<(u16, &'static str)>,
}

impl DispatchOutcome {
    fn actions(actions: Vec<Action>) -> Self {
        Self {
            actions,
            close: None,
        }
    }

    fn empty() -> Self {
        Self {
            actions: Vec::new(),
            close: None,
        }
    }
}

/// The synchronous routing core. Runs entirely under the `RelayCore` lock and
/// contains **no `.await`** — it produces a `DispatchOutcome` of owned actions.
///
/// 2-layer rate limit: applied to every authed message **except** `relay.ping`.
/// On exceed the frame is dropped with `relay.err RATE_LIMITED` (the socket is
/// NOT closed — that is backpressure, a different path).
fn dispatch_locked(
    core: &mut RelayCore,
    signer: &crate::resume_token::ResumeTokenSigner,
    metrics: &crate::metrics::Metrics,
    conn_id: ConnId,
    msg: &RelayClientMessage,
) -> DispatchOutcome {
    let now = now_ms();
    let authed = core.conns.get(&conn_id).is_some_and(|h| h.auth.is_some());

    // 2-layer GCRA rate limit (authed clients, non-ping). Mirrors
    // relay-server.ts:684-705. The two layers are SEPARATE counters with
    // distinct error messages: per-client (`rateLimitedDrops`, "Too many
    // messages. Slow down.") is checked first, then per-daemon-group
    // (`daemonRateLimitedDrops`, "Daemon group budget exceeded. Slow down.").
    if authed && !matches!(msg, RelayClientMessage::Ping { .. }) {
        if let Some(handle) = core.conns.get(&conn_id) {
            let client_ok = handle.client_limiter.check();
            // Only evaluate the group limiter when the client check passed, so a
            // single inbound frame consumes at most one GCRA cell per layer (the
            // TS short-circuits: `if (!checkRateLimit) ... return`).
            if !client_ok {
                metrics.inc_rate_limited_drops();
                return DispatchOutcome::actions(vec![Action::Send(
                    conn_id,
                    RelayServerMessage::Err(RelayErr {
                        e: "RATE_LIMITED".to_string(),
                        m: Some("Too many messages. Slow down.".to_string()),
                    }),
                )]);
            }
            let group_ok = handle.group_limiter.as_ref().is_none_or(|g| g.check());
            if !group_ok {
                metrics.inc_daemon_rate_limited_drops();
                return DispatchOutcome::actions(vec![Action::Send(
                    conn_id,
                    RelayServerMessage::Err(RelayErr {
                        e: "RATE_LIMITED".to_string(),
                        m: Some("Daemon group budget exceeded. Slow down.".to_string()),
                    }),
                )]);
            }
        }
    }

    match msg {
        // ── Handshake ────────────────────────────────────────────────────────
        RelayClientMessage::Auth {
            role,
            daemon_id,
            token,
            frontend_id,
            ..
        } => {
            let is_daemon = *role == Role::Daemon;
            let reply = handshake::handle_auth(
                daemon_id,
                token,
                is_daemon,
                frontend_id.as_deref(),
                now,
                &mut core.registry,
                signer,
            );
            finish_auth(core, conn_id, reply, *role, daemon_id, frontend_id.clone())
        }
        RelayClientMessage::AuthResume { token, .. } => {
            // resumesAttempted++ at entry (relay-server.ts:889).
            metrics.inc_resumes_attempted();
            // handle_auth_resume verifies once and returns (reply, Option<payload>)
            // so we never call signer.verify twice for the same token (#15 fix).
            let (reply, payload) =
                handshake::handle_auth_resume(token, now, &mut core.registry, signer);
            match payload {
                Some(p) if matches!(reply, RelayServerMessage::AuthOk(_)) => {
                    // resumesAccepted++ on success (relay-server.ts:947).
                    metrics.inc_resumes_accepted();
                    let (role, daemon_id, fid) = resume_identity(&p);
                    finish_auth(core, conn_id, reply, role, &daemon_id, fid)
                }
                _ => {
                    // resumesRejected++ — bad token (relay-server.ts:892) OR
                    // daemon no longer registered (relay-server.ts:911); both TS
                    // sites collapse to this single fallthrough.
                    metrics.inc_resumes_rejected();
                    DispatchOutcome::actions(vec![Action::Send(conn_id, reply)])
                }
            }
        }
        RelayClientMessage::Register {
            daemon_id,
            proof,
            token,
            ..
        } => {
            let reply =
                handshake::handle_register(daemon_id, token, proof, now, &mut core.registry);
            DispatchOutcome::actions(vec![Action::Send(conn_id, reply)])
        }

        // ── Routing (requires auth) ──────────────────────────────────────────
        RelayClientMessage::Publish { sid, ct, seq } => {
            let Some(client) = authed_state(core, conn_id) else {
                return not_authenticated(conn_id, Some("Send relay.auth first"));
            };
            DispatchOutcome::actions(route_publish(core, conn_id, &client, sid, ct, *seq, now))
        }
        RelayClientMessage::KeyExchange { ct, .. } => {
            let Some(client) = authed_state(core, conn_id) else {
                return not_authenticated(conn_id, Some("Send relay.auth first"));
            };
            DispatchOutcome::actions(route_key_exchange(core, conn_id, &client, ct))
        }
        RelayClientMessage::Subscribe { sid, after } => {
            if authed_state(core, conn_id).is_none() {
                return not_authenticated(conn_id, None);
            }
            DispatchOutcome::actions(route_subscribe(core, conn_id, sid, *after))
        }
        RelayClientMessage::Unsubscribe { sid } => {
            if authed_state(core, conn_id).is_some() {
                route_unsubscribe(core, conn_id, sid);
            }
            DispatchOutcome::empty()
        }
        RelayClientMessage::Ping { ts } => {
            // Unauthenticated ping: no pong, no rate check (relay-server.ts:1331).
            match authed_state(core, conn_id) {
                Some(client) => {
                    DispatchOutcome::actions(route_ping(core, conn_id, &client, *ts, now))
                }
                None => DispatchOutcome::empty(),
            }
        }

        // ── Push register (frontend → relay): seal the device token + route it
        // to the daemon as relay.push.token. Synchronous (seal is in-memory; no
        // APNs I/O here). Mirrors relay-server.ts handlePushRegister:1493-1542.
        RelayClientMessage::PushRegister {
            // The wire frontend_id is intentionally ignored — routing uses the
            // authenticated identity (see route_push_register). Binding it as `_`
            // documents that the relay does not trust the wire-supplied value.
            frontend_id: _,
            token,
            platform,
        } => route_push_register(core, conn_id, token, *platform),

        // ── Push send (daemon → relay → APNs): async HTTP/2 delivery, which
        // cannot run under the RelayCore lock (no .await in dispatch_locked).
        // Handled earlier in `handle_inbound` (the `handle_push` intercept) so
        // the async `send_or_deliver` runs AFTER the lock drops. This arm is
        // unreachable in practice — kept only for match exhaustiveness.
        RelayClientMessage::Push { .. } => DispatchOutcome::empty(),
    }
}

/// Seal a frontend's plaintext APNs/FCM device token and route it to the daemon
/// in the same group as `relay.push.token { frontendId, sealed, platform }`. The
/// relay holds the plaintext only transiently inside this call; the daemon stores
/// the opaque sealed blob. Port of `relay-server.ts` `handlePushRegister`
/// (1493-1542): UNAUTHORIZED for non-frontends; silent drop when no daemon is
/// connected (the frontend re-registers on reconnect).
fn route_push_register(
    core: &RelayCore,
    conn_id: ConnId,
    token: &str,
    platform: tp_proto::relay_client::Platform,
) -> DispatchOutcome {
    let Some(client) = authed_state(core, conn_id) else {
        return not_authenticated(conn_id, Some("Send relay.auth first"));
    };
    if client.role != Role::Frontend {
        return DispatchOutcome::actions(vec![Action::Send(
            conn_id,
            RelayServerMessage::Err(RelayErr {
                e: "UNAUTHORIZED".to_string(),
                m: Some("Only frontends can send relay.push.register".to_string()),
            }),
        )]);
    }

    // Find the daemon conn in this client's group (role == Daemon).
    let daemon_conn = core.groups.get(&client.daemon_id).and_then(|group| {
        group.iter().copied().find(|cid| {
            core.conns
                .get(cid)
                .and_then(|h| h.auth.as_ref())
                .is_some_and(|a| a.role == Role::Daemon)
        })
    });

    // Seal the plaintext token (in-memory AEAD; never logged). Sealing should not
    // fail with a healthy key; if it does, drop rather than leak the plaintext or
    // crash the dispatch — the frontend re-registers on its next reconnect.
    let Ok(sealed) = global_push_sealer().seal(token) else {
        return DispatchOutcome::empty();
    };

    // No daemon online for this group → drop silently (re-register on reconnect).
    let Some(daemon_conn) = daemon_conn else {
        return DispatchOutcome::empty();
    };

    // Route under the AUTHENTICATED identity (client.frontend_id), never the
    // wire-supplied frontend_id. The relay is the identity authority here: if it
    // trusted the wire frontend_id, any authenticated frontend in the daemon
    // group could register its own APNs token under a victim's frontendId and
    // hijack the victim's push delivery. For an honest client the wire value
    // already equals client.frontend_id, so this is a no-op for them and a hard
    // boundary for a hostile one. Mirrors relay-server.ts handlePushRegister.
    let authed_frontend_id = client.frontend_id.clone().unwrap_or_default();

    DispatchOutcome::actions(vec![Action::Send(
        daemon_conn,
        RelayServerMessage::PushToken(PushToken {
            frontend_id: authed_frontend_id,
            sealed,
            platform,
        }),
    )])
}

/// Handle one `relay.push` (daemon → relay → APNs). Port of `relay-server.ts`
/// `handlePush` (1351-1483).
///
/// Structure preserves the no-await-under-lock invariant absolutely:
/// 1. ONE short synchronous lock runs the role gate + target-frontend lookup +
///    token unseal — all sync — and returns owned values (token, `ConnId`s,
///    `daemon_id`, `is_frontend_connected`). Terminal replies (`UNAUTHORIZED` /
///    `PUSH_UNSEAL_FAILED`) are delivered and the fn returns before any spawn.
/// 2. The lock drops, then (if a `PushService` is configured) the async
///    `send_or_deliver` is `tokio::spawn`ed on a clone of `SharedState`; its
///    `DeliveryResult` is mapped to a `Vec<Action>` and delivered via
///    `deliver_actions` — which re-resolves each outbox under its own brief
///    per-action lock AFTER the await. No guard ever crosses the await.
///
/// Returns `None` always — `relay.push` never closes the connection.
/// Outcome of the synchronous `relay.push` gate/lookup/unseal section
/// ([`resolve_push_locked`]): either a terminal reply to deliver immediately, or
/// the owned values needed to build the async push request after the lock drops.
enum PushResolution {
    /// Terminal: deliver these actions and stop (no spawn). `UNAUTHORIZED`,
    /// `NOT_AUTHENTICATED`, or `PUSH_UNSEAL_FAILED`.
    Reply(Vec<Action>),
    /// Happy path: spawn the async send with these owned values.
    Push {
        daemon_id: String,
        token: String,
        frontend_conn: Option<ConnId>,
        is_frontend_connected: bool,
    },
}

/// The synchronous part of `relay.push` handling: role gate + target-frontend
/// lookup + token unseal, all under ONE short `RelayCore` lock (no `.await`).
/// Returns owned values so the guard drops before the caller spawns the async
/// send. Mirrors `relay-server.ts handlePush` 1355-1409.
fn resolve_push_locked(
    core: &RelayCore,
    conn_id: ConnId,
    frontend_id: &str,
    sealed: &str,
) -> PushResolution {
    // Role gate: only authed DAEMONS may send relay.push (opposite of
    // push.register's frontend gate). An unauthenticated sender gets
    // NOT_AUTHENTICATED (parity with the other routing arms); a non-daemon gets
    // UNAUTHORIZED.
    let client = match authed_state(core, conn_id) {
        None => {
            return PushResolution::Reply(
                not_authenticated(conn_id, Some("Send relay.auth first")).actions,
            );
        }
        Some(client) if client.role != Role::Daemon => {
            return PushResolution::Reply(vec![Action::Send(
                conn_id,
                RelayServerMessage::Err(RelayErr {
                    e: "UNAUTHORIZED".to_string(),
                    m: Some("Only daemons can send push requests".to_string()),
                }),
            )]);
        }
        Some(client) => client,
    };

    // Target-frontend lookup: within this daemon's group, find the frontend conn
    // whose frontend_id matches (mirrors TS 1365-1382). is_frontend_connected
    // drives the Ws-vs-push precedence; the conn is the notification target.
    let frontend_conn = core.groups.get(&client.daemon_id).and_then(|group| {
        group.iter().copied().find(|cid| {
            core.conns
                .get(cid)
                .and_then(|h| h.auth.as_ref())
                .is_some_and(|a| {
                    a.role == Role::Frontend && a.frontend_id.as_deref() == Some(frontend_id)
                })
        })
    });
    let is_frontend_connected = frontend_conn.is_some();

    // Unseal the device token (sync AEAD). Mirrors TS 1384-1409.
    match global_push_sealer().unseal(sealed) {
        UnsealResult::Ok(token) => PushResolution::Push {
            daemon_id: client.daemon_id,
            token,
            frontend_conn,
            is_frontend_connected,
        },
        // Blob without the tpps1 prefix → legacy plaintext token (verbatim).
        UnsealResult::Legacy => PushResolution::Push {
            daemon_id: client.daemon_id,
            token: sealed.to_string(),
            frontend_conn,
            is_frontend_connected,
        },
        // Both unseal_failed AND parse_error → relay.err to the daemon.
        UnsealResult::ParseError | UnsealResult::UnsealFailed => {
            PushResolution::Reply(vec![Action::Send(
                conn_id,
                RelayServerMessage::Err(RelayErr {
                    e: "PUSH_UNSEAL_FAILED".to_string(),
                    m: Some(format!(
                        "Push token unseal failed for frontendId {frontend_id}"
                    )),
                }),
            )])
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_push(
    state: &SharedState,
    conn_id: ConnId,
    frontend_id: &str,
    sealed: &str,
    title: &str,
    body: &str,
    interruption_level: Option<&InterruptionLevel>,
    data: Option<&WirePushData>,
) -> Option<(u16, &'static str)> {
    // 2-layer GCRA rate limit FIRST — BEFORE the spawn. `relay.push` is
    // intercepted in `handle_inbound` ahead of `dispatch_locked`, so it would
    // otherwise skip the rate limit that every other authed arm passes through
    // (relay-server.ts gates push via `checkRateLimit` before its switch:
    // `relay-server.ts:793` precedes `case "relay.push"` at :838). Without this,
    // an authed daemon can fire `relay.push` at unbounded rate and each one
    // `tokio::spawn`s an APNs HTTP/2 request with NO concurrency cap — a memory /
    // fd / HTTP-2-stream exhaustion vector at the ~10k bar (push.rs's per-frontend
    // dedup/rate-limit runs only AFTER the spawn, and caps per frontend, not the
    // daemon's aggregate spawn rate). Mirrors the per-client → per-daemon order +
    // metrics + RATE_LIMITED messages of `dispatch_locked` exactly.
    // Resolve the rate-limit decision under ONE short lock, drop the guard, THEN
    // (only on a reject) deliver the reply outside the lock — the MutexGuard must
    // never be held across an `.await` (the no-await-under-lock invariant).
    let rate_reject: Option<RelayServerMessage> = {
        // LOCK: synchronous rate check — no `.await` inside.
        let core = state.core.lock().expect("relay core mutex poisoned");
        match core.conns.get(&conn_id) {
            // Only gate authed senders (an unauthed push falls through to the
            // NOT_AUTHENTICATED reply in resolve_push_locked below).
            Some(handle) if handle.auth.is_some() => {
                if !handle.client_limiter.check() {
                    state.metrics.inc_rate_limited_drops();
                    Some(RelayServerMessage::Err(RelayErr {
                        e: "RATE_LIMITED".to_string(),
                        m: Some("Too many messages. Slow down.".to_string()),
                    }))
                } else if !handle.group_limiter.as_ref().is_none_or(|g| g.check()) {
                    state.metrics.inc_daemon_rate_limited_drops();
                    Some(RelayServerMessage::Err(RelayErr {
                        e: "RATE_LIMITED".to_string(),
                        m: Some("Daemon group budget exceeded. Slow down.".to_string()),
                    }))
                } else {
                    None
                }
            }
            _ => None,
        }
        // guard dropped here
    };
    if let Some(reply) = rate_reject {
        deliver_actions(state, vec![Action::Send(conn_id, reply)]).await;
        return None;
    }

    // Sync section under ONE short lock — returns owned values, drops the guard.
    let resolved = {
        // LOCK: synchronous gate + lookup + unseal — no `.await` to drop.
        let core = state.core.lock().expect("relay core mutex poisoned");
        resolve_push_locked(&core, conn_id, frontend_id, sealed)
        // guard dropped here
    };

    let (daemon_id, token, frontend_conn, is_frontend_connected) = match resolved {
        PushResolution::Reply(actions) => {
            deliver_actions(state, actions).await;
            return None;
        }
        PushResolution::Push {
            daemon_id,
            token,
            frontend_conn,
            is_frontend_connected,
        } => (daemon_id, token, frontend_conn, is_frontend_connected),
    };

    // Graceful no-op when APNs creds are absent: the daemon's relay.push is
    // fire-and-forget, so silence (no spawn, no error reply) is correct. The
    // role gate + unseal parity replies above still fire regardless. The `?`
    // returns `None` (the function's no-close result) when push_service is None.
    let push_service: Arc<PushService> = state.push_service.clone()?;

    // ── Async section (spawned, lock-free) ───────────────────────────────────
    let req = PushRequest {
        frontend_id: frontend_id.to_string(),
        daemon_id,
        token,
        title: title.to_string(),
        body: body.to_string(),
        is_frontend_connected,
        interruption_level: interruption_level.copied().map(level_to_string),
        data: data.map(wire_to_push_data),
    };

    // Owned reply context for the spawned task (SharedState is Arc-backed Clone).
    let state2 = state.clone();
    let fid = frontend_id.to_string();
    let notif_title = title.to_string();
    let notif_body = body.to_string();
    let notif_data = data.cloned();
    let daemon_conn = conn_id;
    let target_frontend = frontend_conn;

    tokio::spawn(async move {
        let result = push_service.send_or_deliver(&req).await;
        let actions = map_delivery_result(
            &result,
            target_frontend,
            daemon_conn,
            notif_title,
            notif_body,
            notif_data,
            &fid,
        );
        deliver_actions(&state2, actions).await;
    });

    None
}

/// Convert the wire [`InterruptionLevel`] to the `Option<String>` form
/// `PushRequest` carries. `Active` → `"active"`, `TimeSensitive` →
/// `"time-sensitive"` (apns.rs matches `"time-sensitive"` case-insensitively
/// for `apns-priority: 10`).
fn level_to_string(level: InterruptionLevel) -> String {
    match level {
        InterruptionLevel::Active => "active".to_string(),
        InterruptionLevel::TimeSensitive => "time-sensitive".to_string(),
    }
}

/// Convert the wire [`WirePushData`] (`tp_proto::relay_client::PushData`) to the
/// internal [`crate::push::PushData`] used to build a [`PushRequest`]. (The wire
/// type is reused byte-exactly by `relay.notification`'s `data`, but the push
/// orchestrator carries its own struct — hence this field-wise conversion only
/// here, not on the notification path.)
fn wire_to_push_data(d: &WirePushData) -> crate::push::PushData {
    crate::push::PushData {
        sid: d.sid.clone(),
        daemon_id: d.daemon_id.clone(),
        event: d.event.clone(),
    }
}

/// Map a [`DeliveryResult`] to its reply actions. Mirrors the exhaustive switch
/// in `relay-server.ts handlePush` (1425-1482).
///
/// - `Ws` → notify the target frontend conn with `relay.notification` (reusing
///   the wire `data` byte-exactly); no frontend conn → no reply (Ws implies
///   connected so it is normally `Some`).
/// - `Push` / `Deduped` → no reply (fire-and-forget / suppressed).
/// - `RateLimited` / `Error` / `DeadToken` → `relay.err` to the DAEMON conn.
fn map_delivery_result(
    result: &DeliveryResult,
    target_frontend: Option<ConnId>,
    daemon_conn: ConnId,
    notif_title: String,
    notif_body: String,
    notif_data: Option<WirePushData>,
    fid: &str,
) -> Vec<Action> {
    match result {
        DeliveryResult::Ws => target_frontend.map_or_else(Vec::new, |fc| {
            vec![Action::Send(
                fc,
                RelayServerMessage::Notification(Notification {
                    title: notif_title,
                    body: notif_body,
                    data: notif_data,
                }),
            )]
        }),
        DeliveryResult::Push | DeliveryResult::Deduped => Vec::new(),
        DeliveryResult::RateLimited => vec![Action::Send(
            daemon_conn,
            RelayServerMessage::Err(RelayErr {
                e: "PUSH_RATE_LIMITED".to_string(),
                m: Some(format!("Push rate limit exceeded for frontendId {fid}")),
            }),
        )],
        DeliveryResult::Error => vec![Action::Send(
            daemon_conn,
            RelayServerMessage::Err(RelayErr {
                e: "PUSH_DELIVERY_ERROR".to_string(),
                m: Some(format!("Push delivery failed for frontendId {fid}")),
            }),
        )],
        DeliveryResult::DeadToken => vec![Action::Send(
            daemon_conn,
            RelayServerMessage::Err(RelayErr {
                e: "PUSH_TOKEN_DEAD".to_string(),
                m: Some(format!("APNs device token is dead for frontendId {fid}")),
            }),
        )],
    }
}

/// Finalize a successful auth: on `AuthOk`, register the conn into its group and
/// emit the reply + a presence broadcast. On `AuthErr`, just emit the reply.
fn finish_auth(
    core: &mut RelayCore,
    conn_id: ConnId,
    reply: RelayServerMessage,
    role: Role,
    daemon_id: &str,
    frontend_id: Option<String>,
) -> DispatchOutcome {
    if !matches!(reply, RelayServerMessage::AuthOk(_)) {
        let mut actions = vec![Action::Send(conn_id, reply)];
        // Mirror the TS reference (relay-server.ts:946-957): a `role=frontend`
        // auth with a missing `frontendId` is rejected AND the socket is closed.
        // The conn was never registered into a group (auth stays None), so
        // without this close it would linger in `core.conns` — invisible to
        // `relay_clients`/`relay_pending_auth` — until the 10 s auth deadline
        // fires. Closing on reject frees the fd immediately and upholds the
        // "auth 거부 path closes the socket" invariant in
        // `.claude/rules/relay-capacity.md`. The invalid-token reject is left to
        // the auth deadline (matching TS), since an honest client may retry.
        if role == Role::Frontend && frontend_id.is_none() {
            actions.push(Action::Close(conn_id, 1008, "frontendId required"));
        }
        return DispatchOutcome::actions(actions);
    }
    let auth = AuthState {
        role,
        daemon_id: daemon_id.to_string(),
        frontend_id,
        subscriptions: std::collections::HashSet::new(),
    };
    register_authed_conn(core, conn_id, auth);
    let mut actions = vec![Action::Send(conn_id, reply)];
    actions.extend(presence_actions(core, daemon_id));
    DispatchOutcome::actions(actions)
}

/// Extract `(role, daemon_id, frontend_id)` from a verified resume payload.
fn resume_identity(payload: &ResumePayload) -> (Role, String, Option<String>) {
    match payload {
        ResumePayload::Daemon { daemon_id, .. } => (Role::Daemon, daemon_id.clone(), None),
        ResumePayload::Frontend {
            daemon_id,
            frontend_id,
            ..
        } => (Role::Frontend, daemon_id.clone(), Some(frontend_id.clone())),
    }
}

/// Clone the auth state for a conn, if authenticated.
fn authed_state(core: &RelayCore, conn_id: ConnId) -> Option<AuthState> {
    core.conns.get(&conn_id).and_then(|h| h.auth.clone())
}

/// `NOT_AUTHENTICATED` reply for a routing message before auth.
///
/// Mirrors the TS reference: handlePublish (`relay-server.ts:1099-1103`) and
/// handleKeyExchange (`1044-1048`) reply with `relay.err { e:"NOT_AUTHENTICATED",
/// m:"Send relay.auth first" }`; handleSubscribe (`1173-1176`) replies with
/// `relay.err { e:"NOT_AUTHENTICATED" }` (no `m`). All three are `t:"relay.err"`
/// — the generic error channel — NOT `relay.auth.err` (the handshake-failure
/// channel). `msg` is `Some("Send relay.auth first")` for pub/kx and `None` for
/// sub to stay byte-exact with each arm.
fn not_authenticated(conn_id: ConnId, msg: Option<&'static str>) -> DispatchOutcome {
    DispatchOutcome::actions(vec![Action::Send(
        conn_id,
        RelayServerMessage::Err(RelayErr {
            e: "NOT_AUTHENTICATED".to_string(),
            m: msg.map(str::to_string),
        }),
    )])
}

/// Deliver routing actions to their target outboxes. `Send` uses `try_send`;
/// on `Full` the target is marked for a 1013 backpressure close (a `Close`
/// directive is delivered to its write task). `Close` directives forward to the
/// target's close channel. This function is `async` ONLY because closing a conn
/// awaits the write-task close channel — it never holds the `RelayCore` lock.
async fn deliver_actions(state: &SharedState, actions: Vec<Action>) {
    // First pass (synchronous): try_send each message; collect conns needing a
    // backpressure close. We grab+release the lock per action — never across an
    // await.
    let mut backpressured: Vec<ConnId> = Vec::new();
    for action in actions {
        match action {
            Action::Send(target, msg) => {
                // LOCK: synchronous — clone the sender, then drop the guard
                // BEFORE try_send (try_send itself is non-blocking + lock-free).
                let sender = {
                    let core = state.core.lock().expect("relay core mutex poisoned");
                    core.conns.get(&target).map(|h| h.outbox.clone())
                    // guard dropped here
                };
                if let Some(sender) = sender {
                    match sender.try_send(msg) {
                        Ok(()) => {
                            // framesOut++ per delivered Send (relay-server.ts:619,
                            // inside send() after ws.send()).
                            state.metrics.inc_frames_out();
                        }
                        Err(mpsc::error::TrySendError::Full(_)) => backpressured.push(target),
                        // Closed → conn already gone; drop silently (NOT counted —
                        // matches TS, which only counts a successful ws.send()).
                        Err(mpsc::error::TrySendError::Closed(_)) => {}
                    }
                }
            }
            Action::Close(target, code, reason) => {
                close_conn(state, target, code, reason).await;
            }
        }
    }
    // Second pass: close every backpressured slow consumer with 1013.
    for target in backpressured {
        // backpressureDisconnects++ per 1013 close (relay-server.ts:606).
        state.metrics.inc_backpressure_disconnects();
        close_conn(state, target, 1013, "Backpressure").await;
    }
}

/// Tear a connection down out-of-band (backpressure / forced close). Grabs the
/// conn's `close_tx` BEFORE removing the handle, runs `handle_close` for
/// presence/attached bookkeeping, then signals the write task to emit the WS
/// Close frame `(code, reason)`. Removing the handle also drops the outbox
/// sender, which the write task observes via `out_rx.recv() == None`.
async fn close_conn(state: &SharedState, conn_id: ConnId, close_code: u16, reason: &'static str) {
    let (close_tx, presence) = {
        // LOCK: synchronous teardown — grab close_tx, run handle_close, compute
        // presence. No `.await` inside.
        let mut core = state.core.lock().expect("relay core mutex poisoned");
        let close_tx = core.conns.get(&conn_id).map(|h| h.close_tx.clone());
        let daemon = handle_close(&mut core, conn_id, now_ms());
        let presence = daemon.map(|d| presence_actions(&core, &d));
        (close_tx, presence)
        // guard dropped here
    };
    // Signal the write task to emit a Close frame, then terminate. Use the async
    // `send` (not `try_send`) for symmetry with the self-close path
    // (`connection_loop` line ~353): `try_send` swallows a `Full` on the cap-4
    // `close_rx`, silently dropping the close code (the slow consumer would then
    // linger until the 90s idle timeout, and be miscounted as an idle close
    // rather than a 1013 backpressure close). The handle is already removed from
    // `core.conns` above (handle_close), so this is at most a one-slot send and
    // resolves immediately — or returns `Closed` harmlessly if the write task has
    // already exited. `close_conn` is async, so awaiting here costs nothing.
    if let Some(close_tx) = close_tx {
        let _ = close_tx.send((close_code, reason.to_string())).await;
    }
    if let Some(actions) = presence {
        // Recurse once: presence sends never themselves backpressure-close the
        // same conn (it is already removed), so this terminates.
        Box::pin(deliver_actions(state, actions)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::RelayServerMessage;
    use crate::resume_token::ResumeTokenSigner;
    use crate::ring::RecentFrames;
    use crate::server::{ConnHandle, RelayCore};

    #[test]
    fn auth_timeout_constant_matches_ts() {
        assert_eq!(AUTH_TIMEOUT_MS, 10_000);
    }

    #[test]
    fn parse_rejects_unknown_type() {
        // Sanity: the zero-trust boundary the conn loop relies on.
        let v: Value = serde_json::from_str(r#"{"t":"relay.bogus"}"#).unwrap();
        assert!(parse_relay_client_message(&v).is_none());
    }

    // ── Test helpers ─────────────────────────────────────────────────────────

    fn test_core() -> RelayCore {
        use crate::registry::DEFAULT_MAX_REGISTRATIONS;
        RelayCore::new(
            RecentFrames::with_cache_size(10),
            500,
            5000,
            DEFAULT_MAX_REGISTRATIONS,
        )
    }

    fn insert_unauthed(core: &mut RelayCore, id: ConnId) {
        let (tx, rx) = mpsc::channel(64);
        let (close_tx, close_rx) = mpsc::channel(4);
        core.conns.insert(id, ConnHandle::new(tx, close_tx, 500));
        std::mem::forget(rx);
        std::mem::forget(close_rx);
    }

    fn test_signer() -> ResumeTokenSigner {
        ResumeTokenSigner::new(
            Some(b"test-secret-test-secret-test-secret!"),
            Some(3_600_000),
        )
    }

    fn test_metrics() -> crate::metrics::Metrics {
        crate::metrics::Metrics::new()
    }

    /// Serialize the single `Send` action a dispatch produced.
    fn sole_send_json(outcome: &DispatchOutcome) -> serde_json::Value {
        assert_eq!(outcome.actions.len(), 1, "expected exactly one action");
        match &outcome.actions[0] {
            Action::Send(_, msg) => serde_json::to_value(msg).unwrap(),
            other => panic!("expected Send, got {other:?}"),
        }
    }

    // ── Finding 1: NOT_AUTHENTICATED uses relay.err (not relay.auth.err) ──────
    //
    // pub/kx carry m:"Send relay.auth first"; sub carries no m. Mirrors
    // relay-server.ts:1099-1103 (pub), 1044-1048 (kx), 1173-1176 (sub).

    #[test]
    fn unauthed_publish_replies_relay_err_with_message() {
        let mut core = test_core();
        insert_unauthed(&mut core, 7);
        let msg = RelayClientMessage::Publish {
            sid: "s".into(),
            ct: "c".into(),
            seq: 1,
        };
        let out = dispatch_locked(&mut core, &test_signer(), &test_metrics(), 7, &msg);
        let json = sole_send_json(&out);
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "NOT_AUTHENTICATED");
        assert_eq!(json["m"], "Send relay.auth first");
    }

    #[test]
    fn unauthed_key_exchange_replies_relay_err_with_message() {
        let mut core = test_core();
        insert_unauthed(&mut core, 8);
        let msg = RelayClientMessage::KeyExchange {
            ct: "c".into(),
            role: Role::Frontend,
        };
        let out = dispatch_locked(&mut core, &test_signer(), &test_metrics(), 8, &msg);
        let json = sole_send_json(&out);
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "NOT_AUTHENTICATED");
        assert_eq!(json["m"], "Send relay.auth first");
    }

    #[test]
    fn unauthed_subscribe_replies_relay_err_without_message() {
        let mut core = test_core();
        insert_unauthed(&mut core, 9);
        let msg = RelayClientMessage::Subscribe {
            sid: "s".into(),
            after: None,
        };
        let out = dispatch_locked(&mut core, &test_signer(), &test_metrics(), 9, &msg);
        let json = sole_send_json(&out);
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "NOT_AUTHENTICATED");
        // TS handleSubscribe omits `m`; RelayErr skips serializing None.
        assert!(json.get("m").is_none(), "sub arm must not carry m: {json}");
    }

    #[test]
    fn not_authenticated_helper_frame_type_is_relay_err() {
        // Direct check of the wire frame type: must NOT be relay.auth.err.
        let with = not_authenticated(1, Some("Send relay.auth first"));
        assert_eq!(sole_send_json(&with)["t"], "relay.err");
        let without = not_authenticated(1, None);
        let j = sole_send_json(&without);
        assert_eq!(j["t"], "relay.err");
        assert!(j.get("m").is_none());
    }

    // ── Auth-reject closes the socket on `role=frontend && !frontendId` ───────
    //
    // A frontend auth with a missing frontendId must be rejected AND closed
    // (1008) — not left in core.conns until the 10 s auth deadline. Mirrors the
    // TS reference (relay-server.ts:946-957) and the "auth 거부 path closes the
    // socket (neither-map 누수 금지)" invariant in relay-capacity.md.
    #[test]
    fn frontend_auth_without_frontend_id_is_rejected_and_closed() {
        let mut core = test_core();
        insert_unauthed(&mut core, 11);
        // A valid token so we pass the token check and reach the frontendId
        // guard inside handshake::handle_auth.
        core.registry
            .valid_tokens
            .insert("tok".to_string(), "d1".to_string());

        let msg = RelayClientMessage::Auth {
            role: Role::Frontend,
            daemon_id: "d1".into(),
            token: "tok".into(),
            v: 2.0,
            frontend_id: None, // the rejected condition
        };
        let out = dispatch_locked(&mut core, &test_signer(), &test_metrics(), 11, &msg);

        // Exactly two actions, in order: Send(auth.err) then Close(1008).
        assert_eq!(
            out.actions.len(),
            2,
            "expected Send + Close: {:?}",
            out.actions
        );
        match &out.actions[0] {
            Action::Send(target, m) => {
                assert_eq!(*target, 11);
                let json = serde_json::to_value(m).unwrap();
                assert_eq!(json["t"], "relay.auth.err");
            }
            other => panic!("expected Send first, got {other:?}"),
        }
        match &out.actions[1] {
            Action::Close(target, code, reason) => {
                assert_eq!(*target, 11);
                assert_eq!(*code, 1008);
                assert_eq!(*reason, "frontendId required");
            }
            other => panic!("expected Close second, got {other:?}"),
        }
    }

    // A DAEMON auth that fails (invalid token) is NOT force-closed here — it
    // falls through to the 10 s auth deadline, mirroring TS (relay-server.ts:937
    // returns without close). Only the frontendId-required reject closes.
    #[test]
    fn invalid_token_auth_does_not_force_close() {
        let mut core = test_core();
        insert_unauthed(&mut core, 12);
        // No valid_tokens entry → handshake::handle_auth rejects with
        // "Invalid token or daemon ID".
        let msg = RelayClientMessage::Auth {
            role: Role::Daemon,
            daemon_id: "d1".into(),
            token: "bad".into(),
            v: 2.0,
            frontend_id: None,
        };
        let out = dispatch_locked(&mut core, &test_signer(), &test_metrics(), 12, &msg);
        // Only the auth.err Send — no Close action.
        let json = sole_send_json(&out);
        assert_eq!(json["t"], "relay.auth.err");
        assert!(
            !out.actions.iter().any(|a| matches!(a, Action::Close(..))),
            "invalid-token reject must not force-close (auth deadline handles it)"
        );
    }

    // ── Finding 2: max-frame-size guard config ───────────────────────────────

    #[test]
    fn default_max_frame_size_matches_ts() {
        // DEFAULT_MAX_FRAME_SIZE = 1 MiB (relay-server.ts:70).
        assert_eq!(DEFAULT_MAX_FRAME_SIZE, 1024 * 1024);
    }

    #[test]
    fn frame_too_large_error_frame_matches_ts_shape() {
        // The exact frame handle_inbound emits on oversize. Mirrors
        // relay-server.ts:640-644 { t:"relay.err", e:"FRAME_TOO_LARGE", m:... }.
        let msg = RelayServerMessage::Err(crate::messages::RelayErr {
            e: "FRAME_TOO_LARGE".to_string(),
            m: Some("Frame size 2 exceeds limit of 1 bytes".to_string()),
        });
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "FRAME_TOO_LARGE");
        assert_eq!(json["m"], "Frame size 2 exceeds limit of 1 bytes");
    }

    #[tokio::test]
    async fn oversized_frame_increments_counter_and_closes_1009() {
        // End-to-end through handle_inbound with a tiny cap: an oversized text
        // frame is dropped (counter++), and a 1009 close directive is returned.
        let state = SharedState::from_env_with_max_frame_size(1);
        // Register a conn so deliver_actions has an outbox.
        {
            let mut core = state.core.lock().unwrap();
            insert_unauthed(&mut core, 1);
        }
        // The oversize counter now lives on this state's Arc<Metrics> (no longer
        // a process-global static), so a delta check is deterministic.
        let before = state.metrics.snapshot().oversized_drops;
        let close = handle_inbound(&state, 1, "{\"t\":\"relay.ping\"}").await;
        assert_eq!(close, Some((1009, "Frame too large")));
        assert_eq!(state.metrics.snapshot().oversized_drops, before + 1);
    }

    #[tokio::test]
    async fn within_limit_frame_is_not_dropped() {
        let state = SharedState::from_env_with_max_frame_size(1024);
        {
            let mut core = state.core.lock().unwrap();
            insert_unauthed(&mut core, 2);
        }
        // A valid (unauthenticated) ping is well under the cap, so the size
        // guard does not fire — no close directive, and the oversize counter on
        // this state's own Arc<Metrics> stays at zero.
        let close = handle_inbound(&state, 2, "{\"t\":\"relay.ping\"}").await;
        assert_eq!(close, None);
        assert_eq!(state.metrics.snapshot().oversized_drops, 0);
    }

    // ── Finding 3: relay.hello / version-mismatch counter is not on hot path ──

    #[test]
    fn relay_hello_is_not_parseable_so_counter_stays_zero() {
        // The wire parser cannot produce a relay.hello message — it is rejected
        // as UNKNOWN_TYPE one layer earlier, so VERSION_MISMATCH_COUNT can never
        // be incremented by a live socket. Guards the doc claim in handshake.rs.
        let v: Value = serde_json::from_str(
            r#"{"t":"relay.hello","role":"daemon","daemonId":"d","token":"t","v":1}"#,
        )
        .unwrap();
        assert!(
            parse_relay_client_message(&v).is_none(),
            "relay.hello must not parse into a RelayClientMessage"
        );
        // And there is no Hello variant to dispatch on. (Compile-time: the match
        // in dispatch_locked is exhaustive without a Hello arm.)
    }

    // ── relay.push.register → relay.push.token routing ───────────────────────
    //
    // Port-parity guard for handlePushRegister (relay-server.ts:1493-1542):
    // an authed frontend's plaintext token is sealed and routed to the daemon
    // in the same group as relay.push.token; non-frontends get UNAUTHORIZED;
    // a group with no daemon drops silently.

    fn insert_authed(
        core: &mut RelayCore,
        id: ConnId,
        role: Role,
        daemon_id: &str,
        frontend_id: Option<String>,
    ) {
        insert_unauthed(core, id);
        let auth = AuthState {
            role,
            daemon_id: daemon_id.to_string(),
            frontend_id,
            subscriptions: std::collections::HashSet::new(),
        };
        register_authed_conn(core, id, auth);
    }

    fn push_register_msg() -> RelayClientMessage {
        RelayClientMessage::PushRegister {
            frontend_id: "fe-1".into(),
            token: "apns-device-token-abc".into(),
            platform: tp_proto::relay_client::Platform::Ios,
        }
    }

    #[test]
    fn push_register_seals_and_routes_token_to_daemon() {
        let mut core = test_core();
        // Daemon conn 1 + frontend conn 2, same group "d".
        insert_authed(&mut core, 1, Role::Daemon, "d", None);
        insert_authed(&mut core, 2, Role::Frontend, "d", Some("fe-1".into()));

        let out = dispatch_locked(
            &mut core,
            &test_signer(),
            &test_metrics(),
            2,
            &push_register_msg(),
        );

        // Exactly one Send, targeting the DAEMON conn (id 1).
        assert_eq!(out.actions.len(), 1, "expected one Send to the daemon");
        let Action::Send(target, msg) = &out.actions[0] else {
            panic!("expected Send");
        };
        assert_eq!(
            *target, 1,
            "token must route to the daemon conn, not the frontend"
        );
        let json = serde_json::to_value(msg).unwrap();
        assert_eq!(json["t"], "relay.push.token");
        assert_eq!(json["frontendId"], "fe-1");
        assert_eq!(json["platform"], "ios");
        // The sealed blob must NOT be the plaintext token, and must carry the
        // PushSealer envelope prefix.
        let sealed = json["sealed"].as_str().unwrap();
        assert_ne!(
            sealed, "apns-device-token-abc",
            "token must be sealed, not plaintext"
        );
        assert!(
            sealed.starts_with("tpps1."),
            "sealed blob must carry the tpps1 prefix: {sealed}"
        );
    }

    #[test]
    fn push_register_routes_under_authed_identity_not_wire_frontend_id() {
        // Cross-frontend push-hijack guard: a hostile authed frontend sends a
        // push.register whose WIRE frontendId names a *victim*. The relay is the
        // identity authority and must route the sealed token under the attacker's
        // OWN authenticated identity, never the wire-supplied victim id — else the
        // attacker hijacks the victim's push delivery. Mirrors relay-server.ts.
        let mut core = test_core();
        insert_authed(&mut core, 1, Role::Daemon, "d", None);
        // The attacker is authed as "fe-attacker" but claims to be "fe-victim".
        insert_authed(
            &mut core,
            2,
            Role::Frontend,
            "d",
            Some("fe-attacker".into()),
        );

        let hostile = RelayClientMessage::PushRegister {
            frontend_id: "fe-victim".into(), // spoofed wire identity
            token: "apns-device-token-abc".into(),
            platform: tp_proto::relay_client::Platform::Ios,
        };
        let out = dispatch_locked(&mut core, &test_signer(), &test_metrics(), 2, &hostile);

        assert_eq!(out.actions.len(), 1, "expected one Send to the daemon");
        let Action::Send(target, msg) = &out.actions[0] else {
            panic!("expected Send");
        };
        assert_eq!(*target, 1, "token must route to the daemon conn");
        let json = serde_json::to_value(msg).unwrap();
        assert_eq!(json["t"], "relay.push.token");
        assert_eq!(
            json["frontendId"], "fe-attacker",
            "must route under the AUTHENTICATED identity, not the wire frontendId"
        );
    }

    #[test]
    fn push_register_from_daemon_is_unauthorized() {
        let mut core = test_core();
        insert_authed(&mut core, 1, Role::Daemon, "d", None);
        let out = dispatch_locked(
            &mut core,
            &test_signer(),
            &test_metrics(),
            1,
            &push_register_msg(),
        );
        let json = sole_send_json(&out);
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "UNAUTHORIZED");
    }

    #[test]
    fn push_register_unauthed_replies_not_authenticated() {
        let mut core = test_core();
        insert_unauthed(&mut core, 9);
        let out = dispatch_locked(
            &mut core,
            &test_signer(),
            &test_metrics(),
            9,
            &push_register_msg(),
        );
        let json = sole_send_json(&out);
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "NOT_AUTHENTICATED");
    }

    #[test]
    fn push_register_drops_silently_when_no_daemon_in_group() {
        let mut core = test_core();
        // Only a frontend in the group — no daemon connected.
        insert_authed(&mut core, 2, Role::Frontend, "d", Some("fe-1".into()));
        let out = dispatch_locked(
            &mut core,
            &test_signer(),
            &test_metrics(),
            2,
            &push_register_msg(),
        );
        assert!(
            out.actions.is_empty(),
            "no daemon → silent drop (frontend re-registers on reconnect)"
        );
    }

    // ── relay.push (daemon → relay → APNs) dispatch ──────────────────────────
    //
    // Port-parity guard for handlePush (relay-server.ts:1351-1483): the role
    // gate (daemon-only), the token-unseal failure reply, and the graceful
    // no-op when the relay has no APNs creds. These exercise the synchronous
    // intercept in handle_inbound INDEPENDENTLY of any live APNs connection —
    // SharedState::from_env() leaves push_service == None because APNS_* are
    // unset in the test environment.

    /// Register an authed conn into a `SharedState`'s core, returning its outbox
    /// receiver so a test can assert what (if anything) was delivered to it. The
    /// outbox capacity is generous so nothing backpressures.
    fn insert_authed_state(
        state: &SharedState,
        id: ConnId,
        role: Role,
        daemon_id: &str,
        frontend_id: Option<String>,
    ) -> mpsc::Receiver<RelayServerMessage> {
        let (tx, rx) = mpsc::channel(64);
        let (close_tx, close_rx) = mpsc::channel(4);
        std::mem::forget(close_rx);
        let mut core = state.core.lock().unwrap();
        core.conns.insert(id, ConnHandle::new(tx, close_tx, 500));
        let auth = AuthState {
            role,
            daemon_id: daemon_id.to_string(),
            frontend_id,
            subscriptions: std::collections::HashSet::new(),
        };
        register_authed_conn(&mut core, id, auth);
        rx
    }

    /// A `relay.push` wire frame from a daemon for `frontendId` "fe-1".
    fn push_frame(sealed: &str) -> String {
        format!(
            r#"{{"t":"relay.push","frontendId":"fe-1","sealed":"{sealed}","title":"hi","body":"there"}}"#
        )
    }

    #[tokio::test]
    async fn push_send_from_frontend_is_unauthorized() {
        // The role gate fires regardless of push_service config: a FRONTEND
        // sender gets relay.err UNAUTHORIZED to its own conn, no spawn.
        let state = SharedState::from_env();
        // Frontend conn 2 sends relay.push (only daemons may).
        let mut fe_rx = insert_authed_state(&state, 2, Role::Frontend, "d", Some("fe-1".into()));

        let close = handle_inbound(&state, 2, &push_frame("tpps1.whatever")).await;
        assert_eq!(close, None, "relay.push never closes the conn");

        let msg = fe_rx
            .try_recv()
            .expect("frontend sender must receive the UNAUTHORIZED reply");
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "UNAUTHORIZED");
        assert_eq!(json["m"], "Only daemons can send push requests");
    }

    #[tokio::test]
    async fn push_send_unseal_failure_replies_push_unseal_failed() {
        // A daemon-sent relay.push whose sealed blob has the tpps1 prefix but is
        // malformed → relay.err PUSH_UNSEAL_FAILED to the DAEMON conn, no spawn.
        let state = SharedState::from_env();
        let mut daemon_rx = insert_authed_state(&state, 1, Role::Daemon, "d", None);

        // "tpps1." prefix present but the rest is not a valid sealed envelope.
        let close = handle_inbound(&state, 1, &push_frame("tpps1.not-a-real-envelope")).await;
        assert_eq!(close, None);

        let msg = daemon_rx
            .try_recv()
            .expect("daemon must receive the PUSH_UNSEAL_FAILED reply");
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "PUSH_UNSEAL_FAILED");
        assert_eq!(json["m"], "Push token unseal failed for frontendId fe-1");
    }

    #[tokio::test]
    async fn push_send_is_noop_when_push_service_unconfigured() {
        // With APNS_* unset, SharedState::from_env() builds push_service == None.
        // A valid (legacy-token) relay.push from a daemon with a connected
        // frontend in its group must produce NO frame on either outbox — the
        // happy-path intercept short-circuits to a clean no-op (no spawn, no
        // panic, no error reply). This locks the flip-live-merge-safe behaviour:
        // before creds, relay.push is silently dropped.
        let state = SharedState::from_env();
        assert!(
            state.push_service.is_none(),
            "test env must leave push_service unconfigured (no APNS_* set)"
        );

        let mut daemon_rx = insert_authed_state(&state, 1, Role::Daemon, "d", None);
        let mut frontend_rx =
            insert_authed_state(&state, 2, Role::Frontend, "d", Some("fe-1".into()));

        // A legacy (no tpps1 prefix) token unseals to itself → reaches the
        // push_service==None short-circuit (NOT the unseal-failure branch).
        let close = handle_inbound(&state, 1, &push_frame("legacy-plain-token")).await;
        assert_eq!(close, None);

        // Give any (erroneously) spawned task a chance to run.
        tokio::task::yield_now().await;

        assert!(
            daemon_rx.try_recv().is_err(),
            "no reply should reach the daemon when push_service is None"
        );
        assert!(
            frontend_rx.try_recv().is_err(),
            "no notification should reach the frontend when push_service is None"
        );
    }

    #[tokio::test]
    async fn push_send_unauthed_replies_not_authenticated() {
        // An unauthenticated sender gets NOT_AUTHENTICATED (parity with the
        // other routing arms), before any push work.
        let state = SharedState::from_env();
        // Register the conn but do NOT authenticate it.
        let mut rx = {
            let (tx, rx) = mpsc::channel(64);
            let (close_tx, close_rx) = mpsc::channel(4);
            std::mem::forget(close_rx);
            state
                .core
                .lock()
                .unwrap()
                .conns
                .insert(9, ConnHandle::new(tx, close_tx, 500));
            rx
        };

        let close = handle_inbound(&state, 9, &push_frame("tpps1.x")).await;
        assert_eq!(close, None);

        let msg = rx.try_recv().expect("unauthed sender gets a reply");
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "NOT_AUTHENTICATED");
    }

    #[tokio::test]
    async fn push_over_per_client_rate_limit_is_dropped_before_spawn() {
        // GENUINE GUARD: `relay.push` is intercepted in handle_inbound ahead of
        // dispatch_locked, so without an explicit gate it skips the 2-layer GCRA
        // rate limit every other authed arm passes through — letting an authed
        // daemon spawn unbounded APNs tasks (memory/fd/HTTP-2-stream exhaustion at
        // the ~10k bar). This locks the gate: a daemon over its per-client budget
        // gets relay.err RATE_LIMITED and NO push work happens.
        //
        // Register a daemon conn with rate_per_client = 1 so the GCRA burst is a
        // single cell: the first push consumes it, the second is throttled.
        let state = SharedState::from_env();
        let mut daemon_rx = {
            let (tx, rx) = mpsc::channel(64);
            let (close_tx, close_rx) = mpsc::channel(4);
            std::mem::forget(close_rx);
            let mut core = state.core.lock().unwrap();
            // rate_per_client = 1 → Limiter::per_second(1), burst capacity 1.
            core.conns.insert(1, ConnHandle::new(tx, close_tx, 1));
            let auth = AuthState {
                role: Role::Daemon,
                daemon_id: "d".to_string(),
                frontend_id: None,
                subscriptions: std::collections::HashSet::new(),
            };
            register_authed_conn(&mut core, 1, auth);
            rx
        };

        let drops_before = state.metrics.snapshot().rate_limited_drops;

        // First push: consumes the single GCRA cell. push_service is None in the
        // test env, so this is a clean no-op (no reply on the outbox).
        let close = handle_inbound(&state, 1, &push_frame("legacy-plain-token")).await;
        assert_eq!(close, None);
        assert!(
            daemon_rx.try_recv().is_err(),
            "first (in-budget) push must not produce an error reply"
        );

        // Second push: over budget → RATE_LIMITED reply to the daemon, no spawn.
        let close = handle_inbound(&state, 1, &push_frame("legacy-plain-token")).await;
        assert_eq!(close, None, "relay.push never closes the conn");

        let msg = daemon_rx
            .try_recv()
            .expect("over-budget push must receive a RATE_LIMITED reply");
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["t"], "relay.err");
        assert_eq!(json["e"], "RATE_LIMITED");
        assert_eq!(json["m"], "Too many messages. Slow down.");

        // The per-client drop counter advanced exactly once (mirrors dispatch_locked).
        assert_eq!(
            state.metrics.snapshot().rate_limited_drops,
            drops_before + 1,
            "rate_limited_drops must increment on the throttled push"
        );
    }

    // ── map_delivery_result reply-mapping parity (relay-server.ts:1425-1482) ──

    #[test]
    fn map_delivery_result_ws_notifies_frontend() {
        let data = Some(WirePushData {
            sid: "s1".into(),
            daemon_id: "d".into(),
            event: "Stop".into(),
        });
        let actions = map_delivery_result(
            &DeliveryResult::Ws,
            Some(42),
            7,
            "hi".into(),
            "there".into(),
            data,
            "fe-1",
        );
        assert_eq!(actions.len(), 1);
        let Action::Send(target, msg) = &actions[0] else {
            panic!("expected Send");
        };
        assert_eq!(*target, 42, "notification targets the frontend conn");
        let json = serde_json::to_value(msg).unwrap();
        assert_eq!(json["t"], "relay.notification");
        assert_eq!(json["title"], "hi");
        assert_eq!(json["body"], "there");
        assert_eq!(json["data"]["sid"], "s1");
        assert_eq!(json["data"]["daemonId"], "d");
        assert_eq!(json["data"]["event"], "Stop");
    }

    #[test]
    fn map_delivery_result_ws_without_frontend_is_empty() {
        let actions = map_delivery_result(
            &DeliveryResult::Ws,
            None,
            7,
            "hi".into(),
            "there".into(),
            None,
            "fe-1",
        );
        assert!(actions.is_empty(), "no frontend conn → no notification");
    }

    #[test]
    fn map_delivery_result_push_and_deduped_are_silent() {
        for result in [DeliveryResult::Push, DeliveryResult::Deduped] {
            let actions = map_delivery_result(
                &result,
                Some(42),
                7,
                "hi".into(),
                "there".into(),
                None,
                "fe-1",
            );
            assert!(
                actions.is_empty(),
                "{result:?} → no reply (fire-and-forget)"
            );
        }
    }

    #[test]
    fn map_delivery_result_errors_reply_to_daemon() {
        let cases = [
            (DeliveryResult::RateLimited, "PUSH_RATE_LIMITED"),
            (DeliveryResult::Error, "PUSH_DELIVERY_ERROR"),
            (DeliveryResult::DeadToken, "PUSH_TOKEN_DEAD"),
        ];
        for (result, expected_e) in cases {
            let actions = map_delivery_result(
                &result,
                Some(42),
                7,
                "hi".into(),
                "there".into(),
                None,
                "fe-1",
            );
            assert_eq!(actions.len(), 1, "{result:?} → one relay.err");
            let Action::Send(target, msg) = &actions[0] else {
                panic!("expected Send");
            };
            assert_eq!(*target, 7, "{result:?} relay.err targets the DAEMON conn");
            let json = serde_json::to_value(msg).unwrap();
            assert_eq!(json["t"], "relay.err");
            assert_eq!(json["e"], expected_e);
        }
    }

    #[test]
    fn interruption_level_maps_to_apns_strings() {
        assert_eq!(level_to_string(InterruptionLevel::Active), "active");
        assert_eq!(
            level_to_string(InterruptionLevel::TimeSensitive),
            "time-sensitive"
        );
    }

    // ── Pre-auth throttle ────────────────────────────────────────────────────

    #[tokio::test]
    async fn preauth_throttle_closes_after_too_many_frames() {
        let mut state = SharedState::from_env();
        state.max_preauth_msgs = 3; // tiny cap for testing
                                    // Register an unauthenticated conn.
        {
            let mut core = state.core.lock().unwrap();
            insert_unauthed(&mut core, 50);
        }
        // First 3 frames should NOT close (count=1,2,3; threshold is >3).
        for _ in 0..3 {
            let result = handle_inbound(&state, 50, r#"{"t":"relay.ping"}"#).await;
            assert_eq!(result, None, "frames at or under cap must not close");
        }
        // 4th frame exceeds cap → 1008 close.
        let result = handle_inbound(&state, 50, r#"{"t":"relay.ping"}"#).await;
        assert_eq!(result, Some((1008, "Too many pre-auth messages")));
    }

    #[tokio::test]
    async fn preauth_throttle_does_not_apply_after_auth() {
        // Authenticated conns are not subject to the pre-auth cap.
        // Use a very small cap (1) but authed conn.
        let mut state = SharedState::from_env();
        state.max_preauth_msgs = 1;
        {
            let mut core = state.core.lock().unwrap();
            // Insert an authed conn directly.
            let (tx, rx) = mpsc::channel(64);
            let (close_tx, close_rx) = mpsc::channel(4);
            std::mem::forget(rx);
            std::mem::forget(close_rx);
            let mut handle = ConnHandle::new(tx, close_tx, 500);
            handle.auth = Some(crate::server::AuthState {
                role: Role::Daemon,
                daemon_id: "d".into(),
                frontend_id: None,
                subscriptions: std::collections::HashSet::new(),
            });
            core.conns.insert(51, handle);
        }
        // Sending many frames should NOT trigger the preauth close.
        for _ in 0..5 {
            let result = handle_inbound(&state, 51, r#"{"t":"relay.ping"}"#).await;
            // It may return None (no close) or an auth-related close from
            // dispatch, but must NEVER be the preauth close code.
            assert_ne!(
                result,
                Some((1008, "Too many pre-auth messages")),
                "authed conn must not be subject to preauth throttle"
            );
        }
    }
}
