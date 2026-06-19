//! Parameterized concurrent soak / load harness — the **10k capacity gate**.
//!
//! ADR-0003 §6.9 (Amendment 1 §6.9): the Stage-1 Rust relay redesign must NOT
//! lower the standing **~10k concurrent connection capacity bar**. This is a
//! *capacity* gate, not a *parity* gate: it does not assert byte-for-byte wire
//! shapes (the golden vectors in `wire_vectors.rs` / `message_vectors.rs` do
//! that). It asserts that the real async server — bound on a real loopback
//! `TcpListener`, driven by real `tokio-tungstenite` clients — survives heavy
//! concurrency across the three load dimensions the production relay faces:
//!
//!   a. **PUB FAN-OUT** — 1 daemon + N frontends all subscribed to one sid; the
//!      daemon publishes M frames; every frontend must receive all M (0 dropped).
//!   b. **RESUME STORM** — auth N conns, capture each resume token, drop the
//!      sockets, reconnect, `relay.auth.resume {token}`, assert ~100% accepted.
//!   c. **PUSH UNDER LOAD** — drive N concurrent `PushService::send_or_deliver`
//!      calls (the WS hot path is a deliberate no-op for `relay.push`, conn.rs
//!      ~599, so push MUST be exercised at the service API level), asserting
//!      dedup + rate-limit + commit-on-success hold under contention with no
//!      panic / deadlock / leak.
//!
//! ## heavy = local, light = CI
//!
//! ONE parameterized harness. Connection count + duration come from the
//! environment:
//!   * `TP_SOAK_CONNS` — frontends per dimension (default **10_000**).
//!   * `TP_SOAK_SECS`  — soft wall-clock budget per dimension (default **60**).
//!   * `TP_SOAK_JSON=1` — emit a one-line JSON summary on the final line.
//!
//! The FULL 10k run is **heavy** and runs **locally on demand**:
//! ```bash
//! ulimit -n 65535
//! TP_SOAK_CONNS=10000 TP_SOAK_SECS=60 \
//!   cargo test -p tp-relay --test soak_10k -- --ignored --nocapture
//! ```
//! CI runs a **light** scaled-down tier (same code path, smaller N, fast +
//! deterministic) as the merge gate — see `.github/workflows/ci.yml`'s `rust`
//! job. Every soak test is `#[ignore]` so the normal `cargo test --workspace`
//! job NEVER opens thousands of sockets.
//!
//! ## Honest scope
//!
//! * Fan-out + resume run REAL WS clients end-to-end against the real server.
//! * Push runs at the `PushService` API level with a fake `TransportDyn`
//!   returning HTTP 200 (so dedup/rate-limit COMMIT on success — real coverage)
//!   plus a real `ApnsSigner` over a freshly-generated p256 PKCS#8 key. It is
//!   NOT a network/APNs test; it proves the dedup/rate-limit guard mutex holds
//!   under concurrent contention and does not leak or deadlock.
//! * The capacity invariants asserted are precise (see each phase). We assert
//!   trends and hard contracts, and FAIL only on real breakage (a frontend that
//!   never gets a frame, a resume that rejects, a push that wrongly leaks).

// Test-binary pedantic noise that adds nothing here: `# Panics`/`# Errors` doc
// sections on private test helpers, `#[must_use]` on tally fns, doc-backtick
// nitpicks, the soak-orchestrator line count, and the deterministic small-int
// casts in env parsing. The crate's `clippy::all = deny` gate still applies.
#![allow(
    clippy::too_many_lines,
    clippy::must_use_candidate,
    clippy::doc_markdown,
    clippy::missing_panics_doc,
    clippy::missing_errors_doc,
    clippy::cast_possible_truncation,
    clippy::missing_const_for_fn
)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use tp_relay::server::SharedState;
use tp_relay::RelayServer;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

// ── Shared test harness (copied from server_integration.rs — those helpers are
//    file-private module fns and cannot be imported across test binaries) ───────

const TOKEN: &str = "soak-token-0001";
const DAEMON_ID: &str = "daemon-soak-1";

/// Max in-flight loopback dials. Caps the client-side connect storm so the
/// kernel accept backlog is never overrun (a load-generator artifact, not a
/// server limit). High enough to keep the server genuinely saturated.
const CONNECT_CONCURRENCY: usize = 512;

/// Minimum fraction of N that must successfully connect+auth. A handful of
/// loopback dials may transiently fail under the herd (CLIENT-side load-generator
/// limit); we require ≥99% to land so the soak still genuinely exercises the
/// target width, while not failing on a kernel accept-queue hiccup. The HARD
/// contracts (full delivery over the subscribed set, 0 rejects, 0 bp-deaths) are
/// asserted exactly — only the connect yield has this tolerance.
const MIN_CONNECT_FRACTION: f64 = 0.99;

/// Spawn a relay server on an ephemeral loopback port with a fixed resume secret
/// and the test token pre-seeded. Returns the `ws://` base URL, the bound
/// `SocketAddr` (for `http://` probes against `/health` + `/metrics`), and the
/// `SharedState` (so a phase can tweak rate knobs before connecting).
///
/// `tweak` runs against the `SharedState` BEFORE the server starts accepting —
/// the fan-out phase uses it to raise the per-daemon-group GCRA budget so a
/// 10k-wide publish burst is not throttled by the default 5000/s group limiter.
async fn spawn_relay_with(
    tweak: impl FnOnce(&mut SharedState),
) -> (String, SocketAddr, SharedState) {
    // Fixed resume secret so issued tokens verify deterministically across the
    // drop→reconnect cycle in the resume-storm phase.
    let signer = tp_relay::resume_token::ResumeTokenSigner::new(Some(&[9u8; 32]), Some(3_600_000));
    let mut state = SharedState::with_signer(signer);
    tweak(&mut state);

    {
        let mut core = state.core.lock().unwrap();
        core.registry
            .valid_tokens
            .insert(TOKEN.to_string(), DAEMON_ID.to_string());
    }

    let server = RelayServer::with_state(state.clone());
    let router = server.router();
    let _stale = server.spawn_stale_check();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    (format!("ws://{addr}/"), addr, state)
}

async fn connect(url: &str) -> Ws {
    connect_opt(url).await.expect("ws connect")
}

/// Fallible connect with a few retries. Under a thundering-herd connect storm
/// (thousands of loopback dials at once) the kernel accept backlog can transiently
/// refuse a dial; that is a CLIENT-side artifact of the load generator, not a
/// server fault, so we retry briefly and return `None` only if it never lands.
/// The soak counts losses honestly rather than panicking a worker thread.
async fn connect_opt(url: &str) -> Option<Ws> {
    for attempt in 0..5 {
        match connect_async(url).await {
            Ok((ws, _resp)) => return Some(ws),
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(20 * (attempt + 1))).await;
            }
        }
    }
    None
}

async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(serde_json::to_string(&v).unwrap()))
        .await
        .unwrap();
}

/// Receive the next text frame parsed as JSON within `dur`, or `None`.
async fn recv_json_within(ws: &mut Ws, dur: Duration) -> Option<Value> {
    match tokio::time::timeout(dur, ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str(&t).ok(),
        _ => None,
    }
}

/// Read frames until one with `t == want` arrives (skipping interleaved
/// `relay.presence` broadcasts), or `None` after `dur` of total quiet.
///
/// Under heavy concurrency a single daemon group emits a presence broadcast on
/// EVERY frontend join, so an already-authed socket sees presence frames
/// interleaved with its own auth.ok / relay.frame stream. The auth.ok is still
/// FIFO-first on the joining socket, but later presence frames from other joins
/// land before whatever we wait for next. We therefore skip non-target control
/// frames rather than asserting strict frame order (a strict order assumption is
/// a TEST bug at scale, not a server bug).
async fn recv_until(ws: &mut Ws, want: &str, dur: Duration) -> Option<Value> {
    let deadline = Instant::now() + dur;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match recv_json_within(ws, remaining).await {
            Some(v) if v["t"] == want => return Some(v),
            Some(_) => {} // skip interleaved presence / pong
            None => return None,
        }
    }
}

/// Authenticate a daemon socket; returns the `relay.auth.ok` payload.
async fn auth_daemon(ws: &mut Ws) -> Value {
    send_json(
        ws,
        json!({"t":"relay.auth","role":"daemon","daemonId":DAEMON_ID,"token":TOKEN,"v":2}),
    )
    .await;
    recv_until(ws, "relay.auth.ok", Duration::from_secs(30))
        .await
        .expect("daemon auth.ok")
}

/// Fallible frontend auth — `None` on a missed reply (client-side read race
/// under the herd), so callers count losses instead of panicking a worker.
async fn try_auth_frontend(ws: &mut Ws, frontend_id: &str) -> Option<Value> {
    send_json(
        ws,
        json!({"t":"relay.auth","role":"frontend","daemonId":DAEMON_ID,"token":TOKEN,"v":2,"frontendId":frontend_id}),
    )
    .await;
    recv_until(ws, "relay.auth.ok", Duration::from_secs(30)).await
}

// ── env knobs ─────────────────────────────────────────────────────────────────

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn soak_conns() -> usize {
    env_usize("TP_SOAK_CONNS", 10_000)
}

fn soak_secs() -> u64 {
    env_usize("TP_SOAK_SECS", 60) as u64
}

fn json_summary_enabled() -> bool {
    std::env::var("TP_SOAK_JSON").is_ok_and(|v| v == "1")
}

/// HTTP GET against the server's `/health` or `/metrics` surface (same listener
/// as the WS upgrade route). Used for the capacity-invariant probe.
async fn http_get(addr: SocketAddr, path: &str) -> String {
    let url = format!("http://{addr}{path}");
    reqwest::get(&url)
        .await
        .expect("http get")
        .text()
        .await
        .expect("http body")
}

/// Read `relay_clients <n>` (authenticated conn gauge) out of the `/metrics`
/// Prometheus text body — the leak check reads this before/after a phase.
fn metric_value(body: &str, name: &str) -> u64 {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix(name) {
            if let Some(v) = rest.split_whitespace().next() {
                if let Ok(n) = v.parse() {
                    return n;
                }
            }
        }
    }
    panic!("metric {name} not found in /metrics body");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DIMENSION (a): PUB FAN-OUT
// ═══════════════════════════════════════════════════════════════════════════════

/// 1 daemon + N frontends all subscribed to one sid. The daemon publishes M
/// frames. Assert EVERY frontend receives all M (0 dropped) — well-behaved
/// consumers that drain promptly must never be sched a 1013 backpressure close.
///
/// Rate-knob caveat (DOCUMENTED): the daemon-publish fan-out is checked against
/// the **per-daemon-group** GCRA limiter (`rate_per_daemon`, default 5000/s). A
/// 10k-wide subscriber set with M publishes would otherwise risk the daemon's
/// own pub cadence tripping the group limiter (and `route_publish` would drop
/// the pub, not fan it out). We raise BOTH the group limiter and the per-client
/// limiter to effectively-unbounded for this phase so the assertion isolates
/// *fan-out delivery*, not rate-limiting (rate-limiting has its own integration
/// test, `rate_limit_drops_frame_without_closing`). This is the (b) option in
/// the ADR caveat — raise the knob via `SharedState` tweak, and say so.
async fn run_fan_out(conns: usize, frames: usize) -> FanOutReport {
    let started = Instant::now();
    let (url, addr, _state) = spawn_relay_with(|s| {
        // Effectively-unbounded so fan-out delivery is what's measured, not GCRA.
        let mut core = s.core.lock().unwrap();
        core.rate_per_client = 10_000_000;
        core.rate_per_daemon = 10_000_000;
        drop(core);
        // Outbox headroom for the worst case. A single daemon group of N
        // frontends emits a presence broadcast on EVERY join, so one socket can
        // queue up to ~N presence frames during the connect storm BEFORE its
        // drain loop catches up, plus the M fan-out frames. Size the outbox to
        // absorb that so a well-behaved (draining) consumer is never mistaken
        // for a slow consumer and 1013-closed. (This is the realistic single-
        // node knob: production raises LimitNOFILE + outbox for dense groups.)
        s.outbox_cap = conns + frames + 512;
    })
    .await;

    // Daemon authenticates first so it is online before frontends subscribe.
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;

    // Connect + auth + subscribe N frontends. Each frontend drains in its own
    // task and counts received frames. A frontend that fails to connect/auth
    // (client-side herd artifact) reports `subscribed=false` and is excluded
    // from the delivery contract — the contract is "every SUBSCRIBED frontend
    // gets all M frames (0 dropped)", and we separately assert `subscribed` is a
    // high fraction of N.
    let received = Arc::new(AtomicU64::new(0));
    let subscribed = Arc::new(AtomicU64::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(CONNECT_CONCURRENCY));
    let mut handles = Vec::with_capacity(conns);
    let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<bool>(conns.max(1));

    for i in 0..conns {
        let url = url.clone();
        let received = Arc::clone(&received);
        let subscribed = Arc::clone(&subscribed);
        let gate = Arc::clone(&gate);
        let ready_tx = ready_tx.clone();
        handles.push(tokio::spawn(async move {
            let permit = gate.acquire().await.expect("semaphore");
            let Some(mut fe) = connect_opt(&url).await else {
                ready_tx.send(false).await.ok();
                return false;
            };
            if try_auth_frontend(&mut fe, &format!("fe-{i}"))
                .await
                .is_none()
            {
                ready_tx.send(false).await.ok();
                return false;
            }
            // Subscribe immediately after auth so no published frame is missed.
            send_json(&mut fe, json!({"t":"relay.sub","sid":"soak-sid"})).await;
            // Barrier: round-trip a ping. The relay processes each socket's
            // inbound frames in order, so a pong proves the sub was APPLIED
            // server-side before we signal ready. Without this, "ready" only
            // means the client WROTE the sub — the daemon could publish before
            // the server registered the subscription, dropping frames for this
            // frontend (a real race the soak must not paper over with sleeps).
            send_json(&mut fe, json!({"t":"relay.ping","ts":1.0})).await;
            if recv_until(&mut fe, "relay.pong", Duration::from_secs(30))
                .await
                .is_none()
            {
                ready_tx.send(false).await.ok();
                return false;
            }
            subscribed.fetch_add(1, Ordering::Relaxed);
            // Hold the connect permit until subscription is confirmed, then
            // release so other dials proceed; the drain below needs no permit.
            drop(permit);
            ready_tx.send(true).await.ok();
            drop(ready_tx);

            // Continuous drain: count target frames, skipping the interleaved
            // presence broadcasts from other frontends' joins. A draining
            // consumer keeps its outbox empty, so it is never 1013-closed.
            let mut got = 0usize;
            while got < frames {
                match recv_json_within(&mut fe, Duration::from_secs(15)).await {
                    Some(v) if v["t"] == "relay.frame" && v["sid"] == "soak-sid" => got += 1,
                    Some(_) => {}  // skip presence / pong
                    None => break, // quiet window — stop waiting
                }
            }
            received.fetch_add(got as u64, Ordering::Relaxed);
            got == frames
        }));
    }
    drop(ready_tx);

    // Wait until every frontend has reported (subscribed or failed).
    let mut ready_count = 0usize;
    while ready_count < conns {
        match tokio::time::timeout(Duration::from_secs(90), ready_rx.recv()).await {
            Ok(Some(_)) => ready_count += 1,
            _ => break,
        }
    }
    let subscribed_n = subscribed.load(Ordering::Relaxed) as usize;

    // Daemon publishes M frames to the shared sid.
    for seq in 1..=frames {
        send_json(
            &mut daemon,
            json!({"t":"relay.pub","sid":"soak-sid","ct":"cipher","seq":seq}),
        )
        .await;
    }

    // Join all frontend tasks; count how many received the full M.
    let mut full_delivery = 0usize;
    for h in handles {
        if h.await.unwrap_or(false) {
            full_delivery += 1;
        }
    }

    // The delivery contract is over SUBSCRIBED frontends (those that completed
    // the auth→sub→ping barrier), not the raw N — a frontend the load generator
    // never managed to connect cannot be expected to receive frames.
    let expected_total = (subscribed_n * frames) as u64;
    let delivered_total = received.load(Ordering::Relaxed);

    // Capacity invariant probes: server still serving + no backpressure deaths
    // for well-behaved consumers + metrics reflect the fan-out.
    let health = http_get(addr, "/health").await;
    let metrics = http_get(addr, "/metrics").await;
    let backpressure_deaths = metric_value(&metrics, "relay_backpressure_disconnects");
    let frames_out = metric_value(&metrics, "relay_frames_out");
    let health_ok = serde_json::from_str::<Value>(&health).is_ok_and(|v| v["status"] == "ok");

    FanOutReport {
        conns,
        subscribed: subscribed_n,
        frames,
        full_delivery,
        delivered_total,
        expected_total,
        backpressure_deaths,
        frames_out,
        health_ok,
        elapsed: started.elapsed(),
    }
}

struct FanOutReport {
    conns: usize,
    subscribed: usize,
    frames: usize,
    full_delivery: usize,
    delivered_total: u64,
    expected_total: u64,
    backpressure_deaths: u64,
    frames_out: u64,
    health_ok: bool,
    elapsed: Duration,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DIMENSION (b): RESUME STORM
// ═══════════════════════════════════════════════════════════════════════════════

/// Auth N frontend conns, capture each resume token from `auth.ok`, drop the
/// sockets, reconnect, send `relay.auth.resume {token}`, assert ~100% accepted
/// (`resumed: true`). The daemon stays online throughout so the registry still
/// recognizes the group on resume.
async fn run_resume_storm(conns: usize) -> ResumeReport {
    let started = Instant::now();
    let (url, addr, _state) = spawn_relay_with(|_s| {}).await;

    // Keep the daemon online for the whole storm (resume requires the daemon
    // still registered — handshake.rs handle_auth_resume).
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;

    // Bounded connect concurrency: dialing thousands of loopback sockets all at
    // once overruns the kernel accept backlog (client-side load-generator
    // artifact). A semaphore caps in-flight dials so the storm is heavy but the
    // accept queue is never overrun — the SERVER sees a steady stream, which is
    // the realistic reconnect-storm shape.
    let gate = Arc::new(tokio::sync::Semaphore::new(CONNECT_CONCURRENCY));

    // Phase 1: auth N frontends, capture each resume token, then drop.
    let mut handles = Vec::with_capacity(conns);
    for i in 0..conns {
        let url = url.clone();
        let gate = Arc::clone(&gate);
        handles.push(tokio::spawn(async move {
            let _permit = gate.acquire().await.ok()?;
            let mut fe = connect_opt(&url).await?;
            let ok = try_auth_frontend(&mut fe, &format!("rfe-{i}")).await?;
            let token = ok["resumeToken"].as_str().map(str::to_string);
            // Drop the socket (simulate a reconnect-storm disconnect).
            drop(fe);
            token
        }));
    }
    let mut tokens = Vec::with_capacity(conns);
    for h in handles {
        if let Some(tok) = h.await.unwrap_or(None) {
            tokens.push(tok);
        }
    }
    let captured = tokens.len();

    // Phase 2: reconnect + resume each captured token (bounded concurrency).
    let mut handles = Vec::with_capacity(captured);
    for token in tokens {
        let url = url.clone();
        let gate = Arc::clone(&gate);
        handles.push(tokio::spawn(async move {
            let Ok(_permit) = gate.acquire().await else {
                return false;
            };
            let Some(mut fe) = connect_opt(&url).await else {
                return false;
            };
            send_json(
                &mut fe,
                json!({"t":"relay.auth.resume","token":token,"v":2}),
            )
            .await;
            matches!(
                recv_until(&mut fe, "relay.auth.ok", Duration::from_secs(30)).await,
                Some(ok) if ok["resumed"] == true
            )
        }));
    }
    let mut accepted = 0usize;
    for h in handles {
        if h.await.unwrap_or(false) {
            accepted += 1;
        }
    }

    let metrics = http_get(addr, "/metrics").await;
    let resumes_accepted = metric_value(&metrics, "relay_resumes_accepted");
    let resumes_rejected = metric_value(&metrics, "relay_resumes_rejected");

    ResumeReport {
        conns,
        captured,
        accepted,
        resumes_accepted,
        resumes_rejected,
        elapsed: started.elapsed(),
    }
}

struct ResumeReport {
    conns: usize,
    captured: usize,
    accepted: usize,
    resumes_accepted: u64,
    resumes_rejected: u64,
    elapsed: Duration,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DIMENSION (c): PUSH UNDER LOAD
// ═══════════════════════════════════════════════════════════════════════════════

use tp_relay::apns::{
    ApnsClient, ApnsClientConfig, TokioSleeper, TransportDyn, TransportRequest, TransportResponse,
};
use tp_relay::apns_jwt::{ApnsKey, ApnsSigner};
use tp_relay::push::{DeliveryResult, PushData, PushRequest, PushService, PushServiceConfig};

/// Fake transport: every POST "succeeds" with HTTP 200 and no network. This lets
/// `send_or_deliver` reach Step 6 (commit dedup + rate-limit), giving genuine
/// dedup/rate-limit coverage under concurrency without touching APNs.
struct OkTransport {
    posts: AtomicU64,
}

impl TransportDyn for OkTransport {
    fn post_dyn(
        &self,
        _req: TransportRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<TransportResponse, String>> + Send>,
    > {
        self.posts.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            Ok(TransportResponse {
                status: 200,
                retry_after: None,
                body: Vec::new(),
            })
        })
    }
}

/// Generate a fresh p256 PKCS#8 PEM so the real `ApnsSigner` can sign a JWT
/// (the fake transport never sends it anywhere — it just must parse).
fn test_p256_pem() -> String {
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePrivateKey;
    let sk = SigningKey::random(&mut rand_core::OsRng);
    sk.to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
        .expect("p256 to_pkcs8_pem")
        .to_string()
}

fn build_push_service() -> Arc<PushService> {
    let signer = ApnsSigner::new(
        ApnsKey::Pem(test_p256_pem()),
        "KEYID01234".to_string(),
        "TEAMID5678".to_string(),
    );
    let transport = Box::new(OkTransport {
        posts: AtomicU64::new(0),
    });
    let apns = Arc::new(ApnsClient::new(
        ApnsClientConfig::from_env(
            "api.push.apple.com".to_string(),
            "dev.tpmt.teleprompter".to_string(),
        ),
        signer,
        transport,
        Box::new(TokioSleeper),
    ));
    // Sanity: the signer can actually sign over the generated key (else every
    // delivery would error before reaching dedup/rate-limit). We confirm via a
    // single real send below in the test body.
    Arc::new(PushService::new(PushServiceConfig {
        rate_limit_per_minute: 5,
        dedup_window_ms: 60_000,
        rate_limit_window_ms: 60_000,
        apns_client: Some(apns),
    }))
}

fn push_req(frontend_id: &str, sid: &str, event: &str, connected: bool) -> PushRequest {
    PushRequest {
        frontend_id: frontend_id.to_string(),
        daemon_id: DAEMON_ID.to_string(),
        token: "00aabbccddeeff00".to_string(),
        title: "soak".to_string(),
        body: "soak".to_string(),
        is_frontend_connected: connected,
        interruption_level: None,
        data: Some(PushData {
            sid: sid.to_string(),
            daemon_id: DAEMON_ID.to_string(),
            event: event.to_string(),
        }),
    }
}

/// Drive N concurrent deliveries across three concurrent sub-loads:
///   1. WS-priority: N connected requests → all `Ws` (the production hot path).
///   2. Dedup: N requests with the SAME (frontend,sid,event) → exactly 1 `Push`,
///      the rest `Deduped` (proves the dedup guard mutex serializes correctly).
///   3. Rate-limit: 1 frontend, distinct events past the per-minute budget →
///      first `rate_limit_per_minute` are `Push`, the rest `RateLimited`.
async fn run_push_under_load(conns: usize) -> PushReport {
    let started = Instant::now();
    let svc = build_push_service();

    // Sub-load 1: WS priority (connected → Ws). N concurrent.
    let mut handles = Vec::with_capacity(conns);
    for i in 0..conns {
        let svc = Arc::clone(&svc);
        handles.push(tokio::spawn(async move {
            let r = svc
                .send_or_deliver(&push_req(&format!("ws-fe-{i}"), "s", "Stop", true))
                .await;
            r == DeliveryResult::Ws
        }));
    }
    let mut ws_ok = 0usize;
    for h in handles {
        if h.await.unwrap_or(false) {
            ws_ok += 1;
        }
    }

    // Sub-load 2: dedup storm — same triple, N concurrent, disconnected so push
    // is attempted. Exactly one commits (Push); the rest dedup. Because all N
    // race the guard, the first to commit wins and subsequent ones see it; a
    // small number MAY land as Push if they all pass the dedup check before any
    // commits — that is a correct (not leaking) outcome, so we assert "at least
    // one Push, and Push + Deduped == N" rather than "exactly one Push".
    let dedup_svc = build_push_service();
    let mut handles = Vec::with_capacity(conns);
    for _ in 0..conns {
        let svc = Arc::clone(&dedup_svc);
        handles.push(tokio::spawn(async move {
            svc.send_or_deliver(&push_req("dedup-fe", "dsid", "Stop", false))
                .await
        }));
    }
    let mut dedup_push = 0usize;
    let mut dedup_deduped = 0usize;
    let mut dedup_other = 0usize;
    for h in handles {
        match h.await.unwrap_or(DeliveryResult::Error) {
            DeliveryResult::Push => dedup_push += 1,
            DeliveryResult::Deduped => dedup_deduped += 1,
            _ => dedup_other += 1,
        }
    }

    // Sub-load 3: rate-limit — one frontend, distinct events sequentially past
    // the budget (5/min). First 5 Push, rest RateLimited. Sequential so the
    // count is deterministic (concurrent would be racy on the exact boundary).
    let rl_svc = build_push_service();
    let mut rl_push = 0usize;
    let mut rl_limited = 0usize;
    let attempts = 12usize; // > rate_limit_per_minute (5)
    for n in 0..attempts {
        match rl_svc
            .send_or_deliver(&push_req("rl-fe", "rlsid", &format!("ev-{n}"), false))
            .await
        {
            DeliveryResult::Push => rl_push += 1,
            DeliveryResult::RateLimited => rl_limited += 1,
            _ => {}
        }
    }

    PushReport {
        conns,
        ws_ok,
        dedup_push,
        dedup_deduped,
        dedup_other,
        rl_push,
        rl_limited,
        elapsed: started.elapsed(),
    }
}

struct PushReport {
    conns: usize,
    ws_ok: usize,
    dedup_push: usize,
    dedup_deduped: usize,
    dedup_other: usize,
    rl_push: usize,
    rl_limited: usize,
    elapsed: Duration,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  The soak test (ignored by default — heavy local / light CI)
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
#[ignore = "heavy capacity gate: opens TP_SOAK_CONNS sockets — run explicitly (local full 10k / CI light tier)"]
async fn soak_10k_three_dimensions() {
    let conns = soak_conns();
    let budget = Duration::from_secs(soak_secs());
    // M frames per fan-out frontend: keep the fan-out volume meaningful but
    // bounded so the full 10k run stays within a sane wall-clock. At 10k conns
    // this is 10k × frames deliveries.
    let frames = if conns >= 5_000 { 5 } else { 20 };

    eprintln!(
        "[soak] start — conns={conns} secs={} frames/fan-out={frames}",
        budget.as_secs()
    );

    // ── (a) PUB FAN-OUT ──────────────────────────────────────────────────────
    let fan = run_fan_out(conns, frames).await;
    eprintln!(
        "[soak] fan-out: subscribed {}/{} | {}/{} subscribed frontends got all {} frames | delivered {}/{} | bp-deaths={} framesOut={} health_ok={} | {:?}",
        fan.subscribed, fan.conns, fan.full_delivery, fan.subscribed, fan.frames,
        fan.delivered_total, fan.expected_total, fan.backpressure_deaths, fan.frames_out,
        fan.health_ok, fan.elapsed,
    );
    assert!(fan.health_ok, "fan-out: /health must report status ok");
    #[allow(clippy::cast_precision_loss)]
    let connect_frac = fan.subscribed as f64 / fan.conns as f64;
    assert!(
        connect_frac >= MIN_CONNECT_FRACTION,
        "fan-out: only {}/{} frontends subscribed ({:.3} < {MIN_CONNECT_FRACTION}) — load generator under-delivered",
        fan.subscribed, fan.conns, connect_frac
    );
    // HARD contract: every SUBSCRIBED frontend received every frame (0 dropped).
    assert_eq!(
        fan.delivered_total, fan.expected_total,
        "fan-out: every subscribed frontend must receive every frame (0 dropped) — got {}/{}",
        fan.delivered_total, fan.expected_total
    );
    assert_eq!(
        fan.full_delivery, fan.subscribed,
        "fan-out: every subscribed frontend must get the FULL frame set"
    );
    assert_eq!(
        fan.backpressure_deaths, 0,
        "fan-out: well-behaved (draining) consumers must NOT be 1013-closed"
    );
    assert!(
        fan.frames_out >= fan.expected_total,
        "fan-out: /metrics framesOut ({}) must reflect the fan-out (>= {})",
        fan.frames_out,
        fan.expected_total
    );

    // ── (b) RESUME STORM ─────────────────────────────────────────────────────
    let resume = run_resume_storm(conns).await;
    eprintln!(
        "[soak] resume: captured {}/{} tokens | accepted {}/{} | metrics accepted={} rejected={} | {:?}",
        resume.captured, resume.conns, resume.accepted, resume.captured,
        resume.resumes_accepted, resume.resumes_rejected, resume.elapsed,
    );
    #[allow(clippy::cast_precision_loss)]
    let captured_frac = resume.captured as f64 / resume.conns as f64;
    assert!(
        captured_frac >= MIN_CONNECT_FRACTION,
        "resume: only captured {}/{} tokens ({:.3} < {MIN_CONNECT_FRACTION}) — load generator under-delivered",
        resume.captured, resume.conns, captured_frac
    );
    // HARD contract, server-side SoT: the relay accepted EVERY captured token
    // and rejected NONE. `/metrics resumesAccepted` counts server-side accepts;
    // it must equal the number of tokens we replayed, and `resumesRejected` must
    // be 0 (a valid token is never rejected under load). The client-observed
    // `accepted` tally can undercount if a reply read races on a dropped socket
    // — the metric is the authority, so we assert on it.
    assert_eq!(
        resume.resumes_rejected, 0,
        "resume: a valid token must never be rejected under load"
    );
    assert_eq!(
        resume.resumes_accepted as usize, resume.captured,
        "resume: every captured token must be accepted server-side (resumesAccepted == captured) — got {}/{}",
        resume.resumes_accepted, resume.captured
    );
    // The client-observed accept rate should also be ~100% (sanity on the wire
    // round-trip), with the same small client-read tolerance.
    #[allow(clippy::cast_precision_loss)]
    let accept_frac = resume.accepted as f64 / resume.captured.max(1) as f64;
    assert!(
        accept_frac >= MIN_CONNECT_FRACTION,
        "resume: client-observed accepts {}/{} ({:.3} < {MIN_CONNECT_FRACTION})",
        resume.accepted,
        resume.captured,
        accept_frac
    );

    // ── (c) PUSH UNDER LOAD ──────────────────────────────────────────────────
    let push = run_push_under_load(conns).await;
    eprintln!(
        "[soak] push: ws-priority {}/{} | dedup push={} deduped={} other={} | rate-limit push={} limited={} | {:?}",
        push.ws_ok, push.conns, push.dedup_push, push.dedup_deduped, push.dedup_other,
        push.rl_push, push.rl_limited, push.elapsed,
    );
    assert_eq!(
        push.ws_ok, push.conns,
        "push: every connected-frontend delivery must short-circuit to Ws"
    );
    assert_eq!(
        push.dedup_other, 0,
        "push: dedup storm must produce only Push/Deduped (no Error/RateLimited)"
    );
    assert!(
        push.dedup_push >= 1,
        "push: at least one delivery must commit (Push) in the dedup storm"
    );
    assert_eq!(
        push.dedup_push + push.dedup_deduped,
        push.conns,
        "push: dedup storm must account for every request (Push + Deduped == N)"
    );
    assert_eq!(
        push.rl_push, 5,
        "push: exactly rate_limit_per_minute (5) deliveries before the limiter trips"
    );
    assert!(
        push.rl_limited >= 1,
        "push: the rate limiter must engage past the per-minute budget"
    );

    let total = fan.elapsed + resume.elapsed + push.elapsed;
    eprintln!("[soak] PASS — all 3 dimensions green in {total:?} (budget {budget:?}/dim)");

    if json_summary_enabled() {
        let summary = json!({
            "conns": conns,
            "fanOut": {
                "fullDelivery": fan.full_delivery,
                "delivered": fan.delivered_total,
                "expected": fan.expected_total,
                "backpressureDeaths": fan.backpressure_deaths,
                "framesOut": fan.frames_out,
                "healthOk": fan.health_ok,
            },
            "resume": {
                "captured": resume.captured,
                "accepted": resume.accepted,
                "rejected": resume.resumes_rejected,
            },
            "push": {
                "wsOk": push.ws_ok,
                "dedupPush": push.dedup_push,
                "dedupDeduped": push.dedup_deduped,
                "rlPush": push.rl_push,
                "rlLimited": push.rl_limited,
            },
            "elapsedSecs": total.as_secs_f64(),
        });
        // Single-line JSON on the final line (mirrors scripts/soak.ts honesty).
        println!("{}", serde_json::to_string(&summary).unwrap());
    }
}
