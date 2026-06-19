//! Integration tests for the async relay WS hot path.
//!
//! These drive a **real** [`RelayServer`] over a loopback `TcpListener` with a
//! `tokio-tungstenite` client. They exercise the genuine axum upgrade →
//! per-conn actor → routing path (not the synchronous unit-tested decision
//! functions in isolation). Each test is deterministic: clients await the
//! server's reply before proceeding, never sleeping on a wall-clock race.
//!
//! Coverage:
//! * daemon auth → frontend auth (auth.ok both)
//! * kx exchange both directions (opposite-role only)
//! * pub/sub fan-out (frontend subscribes, daemon pubs, frontend gets relay.frame)
//! * resume reject path (bogus token → auth.err)
//! * rate-limit drop (>budget → `RATE_LIMITED`, socket stays open)
//! * presence on daemon auth (frontend receives relay.presence with empty sessions)
//! * unknown-type drop (malformed frame → `UNKNOWN_TYPE`, no dispatch)

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use tp_relay::server::{SharedState, DEFAULT_OUTBOX_CAP};
use tp_relay::RelayServer;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A relay token the daemon/frontend share. The server validates tokens via the
/// registry's `valid_tokens` map; we seed it directly on the shared state so the
/// test does not have to perform a proof-based `relay.register` first.
const TOKEN: &str = "test-token-0001";
const DAEMON_ID: &str = "daemon-int-1";

/// Spawn a relay server bound to an ephemeral loopback port with a fixed resume
/// secret + the test token pre-seeded. Returns the `ws://` URL + the shared
/// state (so a test can tweak rate limits before connecting).
async fn spawn_relay() -> (String, SharedState) {
    spawn_relay_with(|_state| {}).await
}

/// As [`spawn_relay`] but lets the caller mutate the `SharedState` (e.g. shrink
/// the outbox/rate) before the server starts accepting.
async fn spawn_relay_with(tweak: impl FnOnce(&mut SharedState)) -> (String, SharedState) {
    // Fixed resume secret so issued tokens verify deterministically.
    let signer = tp_relay::resume_token::ResumeTokenSigner::new(Some(&[7u8; 32]), Some(3_600_000));
    let mut state = SharedState::with_signer(signer);
    tweak(&mut state);

    // Seed a valid token for DAEMON_ID so relay.auth succeeds without register.
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

    (format!("ws://{addr}/"), state)
}

/// Connect a client to the relay.
async fn connect(url: &str) -> Ws {
    let (ws, _resp) = connect_async(url).await.expect("ws connect");
    ws
}

/// Send a JSON value as a text frame.
async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(serde_json::to_string(&v).unwrap()))
        .await
        .unwrap();
}

/// Receive the next text frame parsed as JSON, with a generous timeout so a
/// hang surfaces as a test failure rather than blocking forever.
async fn recv_json(ws: &mut Ws) -> Value {
    let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("recv timed out")
        .expect("stream ended")
        .expect("ws error");
    match msg {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

/// Try to receive a frame within a short window; `None` if nothing arrives
/// (used to assert "socket did NOT close / did NOT send").
async fn try_recv_json(ws: &mut Ws, dur: Duration) -> Option<Value> {
    match tokio::time::timeout(dur, ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => Some(serde_json::from_str(&t).unwrap()),
        // Non-text frame, closed stream, ws error, or timeout — in every case
        // nothing relay-protocol arrived, which is exactly the negative assertion.
        _ => None,
    }
}

/// Authenticate a daemon socket and await `relay.auth.ok`.
async fn auth_daemon(ws: &mut Ws) {
    send_json(
        ws,
        json!({"t":"relay.auth","role":"daemon","daemonId":DAEMON_ID,"token":TOKEN,"v":2}),
    )
    .await;
    let ok = recv_json(ws).await;
    assert_eq!(ok["t"], "relay.auth.ok", "daemon auth.ok: {ok}");
}

/// Authenticate a frontend socket and await `relay.auth.ok`.
async fn auth_frontend(ws: &mut Ws, frontend_id: &str) {
    send_json(
        ws,
        json!({"t":"relay.auth","role":"frontend","daemonId":DAEMON_ID,"token":TOKEN,"v":2,"frontendId":frontend_id}),
    )
    .await;
    let ok = recv_json(ws).await;
    assert_eq!(ok["t"], "relay.auth.ok", "frontend auth.ok: {ok}");
}

#[tokio::test]
async fn daemon_and_frontend_auth_then_presence() {
    let (url, _state) = spawn_relay().await;

    // Daemon authenticates first (so it is online when the frontend joins).
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;

    // Frontend authenticates → auth.ok then a presence broadcast.
    let mut frontend = connect(&url).await;
    auth_frontend(&mut frontend, "fe-1").await;

    // The frontend's own auth triggers a presence broadcast to itself.
    let presence = recv_json(&mut frontend).await;
    assert_eq!(presence["t"], "relay.presence");
    assert_eq!(presence["daemonId"], DAEMON_ID);
    assert_eq!(presence["online"], true);
    // ADR §A1.4: sessions is empty.
    assert_eq!(presence["sessions"], json!([]));
}

#[tokio::test]
async fn kx_exchange_opposite_role_only() {
    let (url, _state) = spawn_relay().await;
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;
    let mut frontend = connect(&url).await;
    auth_frontend(&mut frontend, "fe-1").await;
    // Drain the presence frame the frontend gets on its own auth.
    let _ = recv_json(&mut frontend).await;

    // Frontend → daemon kx.
    send_json(
        &mut frontend,
        json!({"t":"relay.kx","ct":"fe-pub","role":"frontend"}),
    )
    .await;
    let kx = recv_json(&mut daemon).await;
    assert_eq!(kx["t"], "relay.kx.frame");
    assert_eq!(kx["ct"], "fe-pub");
    assert_eq!(kx["from"], "frontend");

    // Daemon → frontend kx.
    send_json(
        &mut daemon,
        json!({"t":"relay.kx","ct":"d-pub","role":"daemon"}),
    )
    .await;
    let kx2 = recv_json(&mut frontend).await;
    assert_eq!(kx2["t"], "relay.kx.frame");
    assert_eq!(kx2["ct"], "d-pub");
    assert_eq!(kx2["from"], "daemon");
}

#[tokio::test]
async fn pub_sub_fan_out() {
    let (url, _state) = spawn_relay().await;
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;
    let mut frontend = connect(&url).await;
    auth_frontend(&mut frontend, "fe-1").await;
    let _ = recv_json(&mut frontend).await; // drain presence

    // Frontend subscribes to a session.
    send_json(&mut frontend, json!({"t":"relay.sub","sid":"sess-1"})).await;

    // Daemon publishes to that session.
    send_json(
        &mut daemon,
        json!({"t":"relay.pub","sid":"sess-1","ct":"cipher-1","seq":1}),
    )
    .await;

    // Frontend receives relay.frame (daemon-origin: no frontendId).
    let frame = recv_json(&mut frontend).await;
    assert_eq!(frame["t"], "relay.frame");
    assert_eq!(frame["sid"], "sess-1");
    assert_eq!(frame["ct"], "cipher-1");
    assert_eq!(frame["seq"], 1);
    assert_eq!(frame["from"], "daemon");
    assert!(
        frame.get("frontendId").is_none(),
        "daemon frame omits frontendId"
    );
}

#[tokio::test]
async fn sub_after_replays_cached_frames() {
    let (url, _state) = spawn_relay().await;
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;

    // Daemon publishes 3 frames before any subscriber exists (they get cached).
    for seq in 1..=3 {
        send_json(
            &mut daemon,
            json!({"t":"relay.pub","sid":"sess-1","ct":format!("c{seq}"),"seq":seq}),
        )
        .await;
    }
    // Round-trip a ping to ensure the 3 pubs were processed before we subscribe.
    send_json(&mut daemon, json!({"t":"relay.ping","ts":1.0})).await;
    let pong = recv_json(&mut daemon).await;
    assert_eq!(pong["t"], "relay.pong");

    // Frontend joins and subscribes with after=1 → replays seq 2,3.
    let mut frontend = connect(&url).await;
    auth_frontend(&mut frontend, "fe-1").await;
    let _ = recv_json(&mut frontend).await; // drain presence
    send_json(
        &mut frontend,
        json!({"t":"relay.sub","sid":"sess-1","after":1}),
    )
    .await;

    let f2 = recv_json(&mut frontend).await;
    assert_eq!(f2["seq"], 2);
    let f3 = recv_json(&mut frontend).await;
    assert_eq!(f3["seq"], 3);
}

#[tokio::test]
async fn resume_with_bogus_token_rejects() {
    let (url, _state) = spawn_relay().await;
    let mut ws = connect(&url).await;
    send_json(
        &mut ws,
        json!({"t":"relay.auth.resume","token":"not.a.valid.token","v":2}),
    )
    .await;
    let err = recv_json(&mut ws).await;
    // Resume-token rejection is a handshake failure → relay.auth.err.
    assert_eq!(err["t"], "relay.auth.err");
    // The socket must NOT be authenticated; a routing message before auth gets
    // NOT_AUTHENTICATED on the GENERIC error channel (relay.err, NOT
    // relay.auth.err), matching relay-server.ts handlePublish (1099-1103).
    send_json(&mut ws, json!({"t":"relay.pub","sid":"s","ct":"c","seq":1})).await;
    let err2 = recv_json(&mut ws).await;
    assert_eq!(err2["t"], "relay.err");
    assert_eq!(err2["e"], "NOT_AUTHENTICATED");
    assert_eq!(err2["m"], "Send relay.auth first");
}

#[tokio::test]
async fn rate_limit_drops_frame_without_closing() {
    // Shrink the per-client rate so we can exceed it quickly and deterministically.
    let (url, _state) = spawn_relay_with(|s| {
        let mut core = s.core.lock().unwrap();
        core.rate_per_client = 5;
    })
    .await;
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;

    // Burst well past the budget of 5. relay.pub is rate-checked (unlike ping).
    // The daemon pubs to a session with no subscribers, so the only replies are
    // RATE_LIMITED errors once the budget is exhausted.
    let mut saw_rate_limited = false;
    for seq in 1..=50 {
        send_json(
            &mut daemon,
            json!({"t":"relay.pub","sid":"s","ct":"c","seq":seq}),
        )
        .await;
    }
    // Collect any error replies for a short window.
    for _ in 0..50 {
        match try_recv_json(&mut daemon, Duration::from_millis(50)).await {
            Some(v) if v["t"] == "relay.err" && v["e"] == "RATE_LIMITED" => {
                saw_rate_limited = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(saw_rate_limited, "expected at least one RATE_LIMITED drop");

    // The socket is still open: a ping still gets a pong.
    send_json(&mut daemon, json!({"t":"relay.ping","ts":9.0})).await;
    // Drain any trailing rate-limited errors until we see the pong.
    let mut got_pong = false;
    for _ in 0..60 {
        match try_recv_json(&mut daemon, Duration::from_millis(100)).await {
            Some(v) if v["t"] == "relay.pong" => {
                got_pong = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        got_pong,
        "socket must remain open after RATE_LIMITED (ping→pong)"
    );
}

#[tokio::test]
async fn unknown_type_dropped() {
    let (url, _state) = spawn_relay().await;
    let mut ws = connect(&url).await;
    send_json(&mut ws, json!({"t":"relay.bogus","x":1})).await;
    let err = recv_json(&mut ws).await;
    assert_eq!(err["t"], "relay.err");
    assert_eq!(err["e"], "UNKNOWN_TYPE");
}

#[tokio::test]
async fn unauthenticated_ping_gets_no_pong() {
    let (url, _state) = spawn_relay().await;
    let mut ws = connect(&url).await;
    // Ping before auth: no pong, no rate check (relay-server.ts:1331).
    send_json(&mut ws, json!({"t":"relay.ping","ts":1.0})).await;
    let reply = try_recv_json(&mut ws, Duration::from_millis(300)).await;
    assert!(
        reply.is_none(),
        "unauthenticated ping must get no reply: {reply:?}"
    );
}

#[tokio::test]
async fn daemon_disconnect_broadcasts_offline_presence() {
    let (url, _state) = spawn_relay().await;
    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;
    let mut frontend = connect(&url).await;
    auth_frontend(&mut frontend, "fe-1").await;
    let online = recv_json(&mut frontend).await; // presence (online=true)
    assert_eq!(online["online"], true);

    // Daemon drops its socket → relay marks it offline + broadcasts presence.
    drop(daemon);

    let offline = recv_json(&mut frontend).await;
    assert_eq!(offline["t"], "relay.presence");
    assert_eq!(offline["online"], false);
    assert_eq!(offline["sessions"], json!([]));
}

#[tokio::test]
async fn backpressure_closes_slow_consumer() {
    // Force a tiny outbox so a slow consumer (one that never reads) fills it and
    // gets a 1013 backpressure close. We make the FRONTEND the slow consumer:
    // it subscribes then stops reading while the daemon floods frames.
    let (url, _state) = spawn_relay_with(|s| {
        s.outbox_cap = 2; // tiny — fills almost immediately
                          // Raise rate limits so the flood is not throttled before it backpressures.
        let mut core = s.core.lock().unwrap();
        core.rate_per_client = 1_000_000;
        core.rate_per_daemon = 1_000_000;
    })
    .await;
    let _ = DEFAULT_OUTBOX_CAP; // referenced for the doc-link; default is 512.

    let mut daemon = connect(&url).await;
    auth_daemon(&mut daemon).await;
    let mut frontend = connect(&url).await;
    auth_frontend(&mut frontend, "fe-1").await;
    let _ = recv_json(&mut frontend).await; // drain presence
    send_json(&mut frontend, json!({"t":"relay.sub","sid":"s"})).await;

    // Ensure the subscribe is applied before the flood (otherwise no fan-out →
    // no backpressure). A daemon ping round-trip orders after the sub because
    // the relay processes each socket's frames in order and the sub arrived
    // first on the frontend socket; we additionally pub one frame and confirm
    // the frontend can receive it, proving the subscription is live.
    send_json(
        &mut daemon,
        json!({"t":"relay.pub","sid":"s","ct":"warmup","seq":0}),
    )
    .await;
    let warm = recv_json(&mut frontend).await;
    assert_eq!(
        warm["ct"], "warmup",
        "subscription must be live before flood"
    );

    // Daemon floods frames. The frontend never reads again, so its bounded
    // outbox (cap=2) fills and the relay closes it with 1013.
    for seq in 1..=300u64 {
        send_json(
            &mut daemon,
            json!({"t":"relay.pub","sid":"s","ct":"x","seq":seq}),
        )
        .await;
    }

    // The frontend stream ends (close / TCP teardown). Read until it closes,
    // draining any buffered frames first. A single overall deadline bounds the
    // wait so a non-close (test bug) fails fast instead of hanging.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match frontend.next().await {
                Some(Ok(Message::Close(_)) | Err(_)) | None => return true,
                Some(Ok(_)) => {} // a buffered frame before the close — keep draining
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(closed, "slow consumer must be closed under backpressure");
}
