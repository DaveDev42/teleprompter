//! `tp-loopback` — the Rust-native smoke-test loopback (ADR-0001 Phase 3, #5).
//!
//! Starts an in-process [`RelayServer`] and pre-seeds the deterministic
//! smoke-test token so the Simulator app can send `relay.auth` (role=frontend)
//! and receive `relay.auth.ok` without a real daemon (M2). For M3 it ALSO
//! attaches a minimal fake daemon WebSocket peer that:
//!
//!   - auths as role=daemon with the seeded token,
//!   - subscribes to `__meta__` / `__control__` / each session sid,
//!   - broadcasts its kx pubkey via `relay.kx`,
//!   - on the frontend's `relay.kx.frame`, derives server session keys, and
//!   - pushes an encrypted `hello` (session list + PCT) on `__meta__`.
//!
//! This drives the app through `TP_KX_OK` and `TP_FRAME_OK` end to end.
//!
//! Byte-for-byte the same wire behaviour as the retired
//! `scripts/local-relay-loopback.ts` — the seeded token is `derive_relay_token`
//! of the golden 32-incrementing-byte pairing secret (0x00..0x1f), matching
//! `rust/tp-core/tests/fixtures/wire-vectors.json` (`kdf.relayToken`). The
//! Simulator app gets that secret from a `tp://p?d=…` link whose relay URL
//! points here (`ws://localhost:<port>`).
//!
//! CRITICAL: the fake daemon must be connected + authed BEFORE the app sends its
//! `relay.kx` — the relay only fans out to currently-connected opposite-role
//! peers and does NOT cache kx frames. We connect the fake daemon at startup and
//! only print `LOOPBACK_READY` once it has authed.
//!
//! Run: `RELAY_PORT=7099 tp-loopback`
//! Prints `LOOPBACK_READY port=<port>` once listening + daemon authed, then
//! stays up until killed (SIGINT/SIGTERM).

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use tp_core::crypto::{
    derive_kx_key, derive_legacy_pairing_id, derive_pairing_confirmation_tag, kx_seed_keypair,
    kx_server_session_keys, open, seal, KxKeyPair, SessionKeys,
};
use tp_core::pairing::parse_uuid_16;
use tp_relay::{RelayServer, SharedState};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// `derive_relay_token(0x00..0x1f)` — must match the Swift FFI `deriveRelayToken`
/// output and the Rust golden vector. If the golden secret changes, update this
/// AND `scripts/ios.sh`'s `smoke_pair_link` AND `RelayAuthTests.swift` in
/// lockstep.
const TOKEN: &str = "a16760de00195ffd72a318d567eca9c2ee0fa7003e7e87cfec03538c4e7aa5c9";
const DAEMON_ID: &str = "daemon-smoketest";
const DEFAULT_PORT: u16 = 7099;

/// The golden pairing secret (0x00..0x1f). The kx-envelope key is derived from
/// it, byte-exact with the Swift app's `deriveKxKey(pairing.pairingSecret)`.
fn golden_secret() -> [u8; 32] {
    let mut s = [0u8; 32];
    for (i, b) in s.iter_mut().enumerate() {
        *b = u8::try_from(i).expect("0..32 fits u8");
    }
    s
}

/// A fixed daemon kx seed. The TS loopback used a random keypair; a fixed seed
/// is equally valid (the app derives its session keys from whatever pubkey we
/// broadcast) and makes the loopback fully deterministic run-to-run.
const DAEMON_KX_SEED: [u8; 32] = [0x5au8; 32];

/// One fake session so `TP_FRAME_OK sessions=<n>` proves a non-empty render and
/// M4 has a sid to attach + backfill. `lastSeq=1` matches the single synthetic
/// event record the daemon returns on `resume` (seq=1).
const FAKE_SID: &str = "sess-smoketest";
const FAKE_TS: i64 = 1_700_000_000_000;

fn fake_sessions() -> Value {
    json!([{
        "sid": FAKE_SID,
        "state": "running",
        "cwd": "/tmp/smoke",
        "createdAt": FAKE_TS,
        "updatedAt": FAKE_TS,
        "lastSeq": 1,
    }])
}

/// The history backfill the daemon replies with on `resume { c }` — one `event`
/// record carrying a Stop hook event. `d` is base64 of the event JSON (the
/// daemon always base64-encodes the payload regardless of `k`), so the app
/// base64-decodes → UTF8 → JSON to render `last_assistant_message`. seq=1 > the
/// app's resume cursor (0) so it applies.
fn fake_event_rec() -> Value {
    let payload = json!({
        "session_id": FAKE_SID,
        "hook_event_name": "Stop",
        "cwd": "/tmp/smoke",
        "last_assistant_message": "smoke ok",
    });
    let d = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(&payload).expect("event json"));
    json!({ "t": "rec", "sid": FAKE_SID, "seq": 1, "k": "event", "d": d, "ts": FAKE_TS })
}

fn main() -> ExitCode {
    let port = resolve_port();

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("tp-loopback: failed to start tokio runtime: {err}");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(run(port)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("tp-loopback: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Port precedence: `RELAY_PORT` env > `DEFAULT_PORT` (7099). Mirrors the TS
/// loopback (`process.env.RELAY_PORT`) and `scripts/ios.sh`'s
/// `RELAY_PORT="$RELAY_LOOPBACK_PORT"` spawn.
fn resolve_port() -> u16 {
    match std::env::var("RELAY_PORT") {
        Ok(raw) if !raw.is_empty() => raw.parse().unwrap_or(DEFAULT_PORT),
        _ => DEFAULT_PORT,
    }
}

/// Bind the relay on a fixed loopback port, pre-seed the golden token, start the
/// fake daemon, print `LOOPBACK_READY`, then serve until a signal arrives.
async fn run(port: u16) -> Result<(), String> {
    // Build state and pre-seed the smoke token so the app's `relay.auth`
    // (role=frontend) and the fake daemon's `relay.auth` (role=daemon) both
    // succeed without a proof-based `relay.register`.
    let state = SharedState::from_env();
    {
        let mut core = state
            .core
            .lock()
            .map_err(|_| "relay core mutex poisoned".to_string())?;
        core.registry
            .valid_tokens
            .insert(TOKEN.to_string(), DAEMON_ID.to_string());
    }

    let server = RelayServer::with_state(state);
    let router = server.router();
    let _stale = server.spawn_stale_check();

    // Bind the fixed port (the app's pairing link points at ws://localhost:<port>).
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr} failed: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?;

    // Serve in the background so we can connect the fake daemon back to it.
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            eprintln!("tp-loopback: serve error: {err}");
        }
    });

    // Connect + auth the fake daemon BEFORE announcing readiness. `start_fake_daemon`
    // resolves once it has received `relay.auth.ok`, guaranteeing the app's kx
    // (sent after it sees LOOPBACK_READY) always finds a daemon peer to fan out to.
    let ws_url = format!("ws://127.0.0.1:{}/", bound.port());
    start_fake_daemon(&ws_url).await?;

    // Single greppable readiness line the harness waits on.
    println!("LOOPBACK_READY port={}", bound.port());
    println!("[loopback] token {}… → {DAEMON_ID} seeded", &TOKEN[..12]);
    println!(
        "[loopback] health: http://localhost:{}/health",
        bound.port()
    );

    // Park until SIGINT/SIGTERM.
    shutdown_signal().await;
    eprintln!("tp-loopback: shutdown signal received");
    Ok(())
}

/// Connect the fake daemon peer and spawn its message loop. Resolves once the
/// daemon has authed (mirrors the TS `await startFakeDaemon()` gate).
async fn start_fake_daemon(ws_url: &str) -> Result<(), String> {
    let (ws, _resp) = connect_async(ws_url)
        .await
        .map_err(|e| format!("fake daemon ws connect failed: {e}"))?;

    let mut daemon = FakeDaemon::new()?;
    let (mut sink, mut stream) = ws.split();

    // Send auth. Pre-seeded token → relay accepts role=daemon without register.
    send_json(
        &mut sink,
        &json!({
            "t": "relay.auth",
            "v": 2,
            "role": "daemon",
            "daemonId": DAEMON_ID,
            "token": TOKEN,
        }),
    )
    .await?;

    // Wait (with timeout) for auth.ok, processing (and acting on) each frame as
    // it arrives — auth.ok itself triggers the sub + kx broadcast.
    let auth_deadline = Duration::from_secs(10);
    let authed = tokio::time::timeout(auth_deadline, async {
        while let Some(msg) = stream.next().await {
            let Ok(Message::Text(text)) = msg else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match v.get("t").and_then(Value::as_str) {
                Some("relay.auth.ok") => {
                    daemon.on_auth_ok(&mut sink).await?;
                    return Ok::<bool, String>(true);
                }
                Some("relay.auth.err") => {
                    return Err(format!(
                        "daemon auth rejected: {}",
                        v.get("e").and_then(Value::as_str).unwrap_or("?")
                    ));
                }
                _ => {}
            }
        }
        Err("daemon ws closed before auth".to_string())
    })
    .await
    .map_err(|_| "daemon auth timed out".to_string())??;

    if !authed {
        return Err("daemon did not auth".to_string());
    }

    // Hand off the remaining stream to a background task that plays kx.frame /
    // relay.frame for the whole process lifetime.
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let Ok(Message::Text(text)) = msg else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if let Err(err) = daemon.on_message(&v, &mut sink).await {
                eprintln!("[loopback:daemon] {err}");
            }
        }
    });

    Ok(())
}

/// The fake daemon's mutable state across the handshake.
struct FakeDaemon {
    kx_key: [u8; 32],
    daemon_kp: KxKeyPair,
    session_keys: Option<SessionKeys>,
    /// The frontend's kx pubkey, captured on `relay.kx.frame` (needed for PCT).
    frontend_pub: Option<[u8; 32]>,
    /// `__meta__`/session publish seq counter.
    meta_seq: u64,
    /// io record seq — starts at 2 so echoed io recs sort AFTER the seq=1
    /// synthetic event rec from the backfill batch.
    io_seq: u64,
}

impl FakeDaemon {
    fn new() -> Result<Self, String> {
        let kx_key = derive_kx_key(&golden_secret());
        let daemon_kp =
            kx_seed_keypair(&DAEMON_KX_SEED).map_err(|e| format!("daemon keypair: {e}"))?;
        Ok(Self {
            kx_key,
            daemon_kp,
            session_keys: None,
            frontend_pub: None,
            meta_seq: 0,
            io_seq: 2,
        })
    }

    /// Broadcast the daemon's kx pubkey (sealed with the kx-envelope key). The
    /// relay fans this out only to *currently-connected* opposite-role peers and
    /// does NOT cache it, so a single broadcast at our own auth time is lost (the
    /// frontend connects later). We re-broadcast when the frontend's kx.frame
    /// arrives (= a frontend just joined), mirroring the real daemon.
    async fn broadcast_kx(&self, sink: &mut WsSink) -> Result<(), String> {
        let payload = json!({
            "pk": b64(&self.daemon_kp.public_key),
            "role": "daemon",
            // PR-5: advertise WS protocol v3 (PCT-capable). The app raises its
            // anti-downgrade floor to 3 on this, so a pct-absent hello would FAIL
            // the §1.3 gate — the hello therefore MUST carry a matching pct.
            "v": 3,
            "label": { "set": false },
        });
        let ct = seal_json(&payload, &self.kx_key)?;
        send_json(
            sink,
            &json!({ "t": "relay.kx", "ct": ct, "role": "daemon" }),
        )
        .await
    }

    /// On `relay.auth.ok`: subscribe to the meta/control/session sids, then
    /// broadcast our kx pubkey (a no-op for the not-yet-connected frontend; the
    /// authoritative delivery is the re-broadcast on the frontend's kx.frame).
    async fn on_auth_ok(&self, sink: &mut WsSink) -> Result<(), String> {
        send_json(
            sink,
            &json!({ "t": "relay.sub", "sid": "__meta__", "after": 0 }),
        )
        .await?;
        send_json(
            sink,
            &json!({ "t": "relay.sub", "sid": "__control__", "after": 0 }),
        )
        .await?;
        send_json(
            sink,
            &json!({ "t": "relay.sub", "sid": FAKE_SID, "after": 0 }),
        )
        .await?;
        self.broadcast_kx(sink).await?;
        eprintln!("[loopback:daemon] authed + kx broadcast");
        Ok(())
    }

    /// Dispatch a post-auth frame (`relay.kx.frame` / `relay.frame`).
    async fn on_message(&mut self, v: &Value, sink: &mut WsSink) -> Result<(), String> {
        match v.get("t").and_then(Value::as_str) {
            Some("relay.kx.frame") => self.on_kx_frame(v, sink).await,
            Some("relay.frame") => self.on_relay_frame(v, sink).await,
            _ => Ok(()),
        }
    }

    /// The frontend's pubkey exchange. Derive server session keys, re-broadcast
    /// our kx pubkey (so a late-joined frontend receives it), then push hello.
    async fn on_kx_frame(&mut self, v: &Value, sink: &mut WsSink) -> Result<(), String> {
        if v.get("from").and_then(Value::as_str) != Some("frontend") {
            return Ok(());
        }
        let ct = v
            .get("ct")
            .and_then(Value::as_str)
            .ok_or("kx.frame missing ct")?;
        let plain = open(ct, &self.kx_key).map_err(|e| format!("kx.frame decrypt: {e}"))?;
        let data: Value =
            serde_json::from_slice(&plain).map_err(|e| format!("kx.frame json: {e}"))?;
        let pk_b64 = data
            .get("pk")
            .and_then(Value::as_str)
            .ok_or("kx.frame pk")?;
        let frontend_pub = decode_pk(pk_b64)?;
        self.frontend_pub = Some(frontend_pub);
        // Daemon plays the SERVER role in the kx (mirrors deriveSessionKeys(_, _, "daemon")).
        self.session_keys = Some(kx_server_session_keys(
            &self.daemon_kp.public_key,
            &self.daemon_kp.secret_key,
            &frontend_pub,
        ));
        let fid = data
            .get("frontendId")
            .and_then(Value::as_str)
            .unwrap_or("?");
        eprintln!(
            "[loopback:daemon] kx complete frontendId={}…",
            &fid[..fid.len().min(8)]
        );
        self.broadcast_kx(sink).await?;
        self.push_hello(sink).await
    }

    /// App-level frames the app publishes (sealed with its tx = our rx):
    ///   `{t:'hello'}`   → on-demand hello fallback (M3)
    ///   `{t:'attach'}`  → reply with a `state` frame (M4)
    ///   `{t:'resume'}`  → reply with a `batch` of records seq > c (M4)
    ///   `{t:'in.chat'}` → echo the line back as an `io` rec (M5)
    ///   `{t:'in.term'}` → echo the (base64) bytes back as an `io` rec (M5)
    async fn on_relay_frame(&mut self, v: &Value, sink: &mut WsSink) -> Result<(), String> {
        if v.get("from").and_then(Value::as_str) != Some("frontend") {
            return Ok(());
        }
        let Some(keys) = self.session_keys.as_ref() else {
            return Ok(());
        };
        let Some(ct) = v.get("ct").and_then(Value::as_str) else {
            return Ok(());
        };
        // Undecodable / unknown frames are ignored (mirrors the TS catch).
        let rx = keys.rx;
        let Ok(plain) = open(ct, &rx) else {
            return Ok(());
        };
        let Ok(inner) = serde_json::from_slice::<Value>(&plain) else {
            return Ok(());
        };
        let t = inner.get("t").and_then(Value::as_str).unwrap_or("");
        let sid = inner.get("sid").and_then(Value::as_str);
        match t {
            "hello" => {
                eprintln!("[loopback:daemon] on-demand hello request");
                self.push_hello(sink).await
            }
            "attach" => {
                if let Some(sid) = sid {
                    eprintln!("[loopback:daemon] attach sid={sid}");
                    self.push_state(sid, sink).await
                } else {
                    Ok(())
                }
            }
            "resume" => {
                if let Some(sid) = sid {
                    let c = inner.get("c").and_then(Value::as_i64).unwrap_or(0);
                    eprintln!("[loopback:daemon] resume sid={sid} c={c}");
                    self.push_batch(sid, c, sink).await
                } else {
                    Ok(())
                }
            }
            "in.chat" | "in.term" => {
                let (Some(sid), Some(d)) = (sid, inner.get("d").and_then(Value::as_str)) else {
                    return Ok(());
                };
                // Echo input back as an io record, mirroring a PTY echoing typed
                // input. in.chat `d` is plain text (real daemon appends \n);
                // in.term `d` is already base64 PTY bytes.
                let raw = if t == "in.chat" {
                    format!("{d}\n").into_bytes()
                } else {
                    base64::engine::general_purpose::STANDARD
                        .decode(d)
                        .map_err(|e| format!("in.term base64: {e}"))?
                };
                eprintln!("[loopback:daemon] input {t} sid={sid} → io echo");
                self.push_io_rec(sid, &raw, sink).await
            }
            _ => Ok(()),
        }
    }

    /// Push an encrypted `hello` (session list + per-frontend PCT) on `__meta__`.
    async fn push_hello(&mut self, sink: &mut WsSink) -> Result<(), String> {
        let (Some(keys), Some(frontend_pub)) =
            (self.session_keys.as_ref(), self.frontend_pub.as_ref())
        else {
            return Ok(());
        };
        // PR-5: derive the per-frontend PCT this hello carries. Inputs mirror the
        // app's `deriveEpochPct` exactly so the two tags converge byte-for-byte:
        //   - pairingId: the smoke QR is v3 (no explicit pairingId), so the app
        //     derives it locally from the daemonId (`deriveLegacyPairingId`);
        //   - daemonId: the full `daemon-…`-prefixed id;
        //   - hostname: "" (legacy — v3 QR carries no hostname);
        //   - daemonPubKey: our kx pubkey (the one we broadcast);
        //   - frontendPubKey: the frontend's kx pubkey from `relay.kx.frame`;
        //   - tx/rx: the derived session keys (the FFI sorts them).
        let legacy_pairing_id = derive_legacy_pairing_id(DAEMON_ID);
        let pairing_id =
            parse_uuid_16(&legacy_pairing_id).map_err(|e| format!("legacy pairing id: {e}"))?;
        let pct = derive_pairing_confirmation_tag(
            &pairing_id,
            DAEMON_ID,
            "",
            &self.daemon_kp.public_key,
            frontend_pub,
            &keys.tx,
            &keys.rx,
        );
        let hello = json!({
            "t": "hello",
            "v": 1,
            "d": {
                "sessions": fake_sessions(),
                "daemonLabel": { "set": false },
                "pct": b64(&pct),
            },
        });
        let tx = keys.tx;
        self.pub_on_sid("__meta__", &hello, &tx, sink).await?;
        eprintln!("[loopback:daemon] hello pushed sessions=1 (pct present)");
        Ok(())
    }

    /// Reply to `attach` with a `state` frame carrying the session's metadata.
    async fn push_state(&mut self, sid: &str, sink: &mut WsSink) -> Result<(), String> {
        let Some(keys) = self.session_keys.as_ref() else {
            return Ok(());
        };
        let meta = fake_sessions()[0].clone();
        let frame = json!({ "t": "state", "sid": sid, "d": meta });
        let tx = keys.tx;
        self.pub_on_sid(sid, &frame, &tx, sink).await?;
        eprintln!("[loopback:daemon] state pushed sid={sid}");
        Ok(())
    }

    /// Reply to `resume { c }` with a `batch` of records seq > c. We hold one
    /// synthetic event rec (seq=1), so c<1 backfills it and c>=1 returns empty.
    async fn push_batch(&mut self, sid: &str, c: i64, sink: &mut WsSink) -> Result<(), String> {
        let Some(keys) = self.session_keys.as_ref() else {
            return Ok(());
        };
        let recs = if 1 > c {
            json!([fake_event_rec()])
        } else {
            json!([])
        };
        let count = recs.as_array().map_or(0, Vec::len);
        let frame = json!({ "t": "batch", "sid": sid, "d": recs });
        let tx = keys.tx;
        self.pub_on_sid(sid, &frame, &tx, sink).await?;
        eprintln!("[loopback:daemon] batch pushed sid={sid} recs={count}");
        Ok(())
    }

    /// Push a live `io` record carrying raw PTY bytes (base64), mirroring the
    /// daemon's encoding. Used to echo input back so the app can prove the
    /// input→io round-trip (M5).
    async fn push_io_rec(
        &mut self,
        sid: &str,
        bytes: &[u8],
        sink: &mut WsSink,
    ) -> Result<(), String> {
        let Some(keys) = self.session_keys.as_ref() else {
            return Ok(());
        };
        let seq = self.io_seq;
        self.io_seq += 1;
        let rec = json!({
            "t": "rec",
            "sid": sid,
            "seq": seq,
            "k": "io",
            "ns": "runner",
            "d": b64(bytes),
            "ts": FAKE_TS,
        });
        let tx = keys.tx;
        self.pub_on_sid(sid, &rec, &tx, sink).await?;
        eprintln!("[loopback:daemon] io rec pushed sid={sid} seq={seq}");
        Ok(())
    }

    /// Seal a sealed app-level frame on a session sid and publish it. Mirrors the
    /// real daemon's sendEncrypted path (the app subscribed to this sid).
    async fn pub_on_sid(
        &mut self,
        sid: &str,
        payload: &Value,
        tx: &[u8; 32],
        sink: &mut WsSink,
    ) -> Result<(), String> {
        let ct = seal_json(payload, tx)?;
        let seq = self.meta_seq;
        self.meta_seq += 1;
        send_json(
            sink,
            &json!({ "t": "relay.pub", "sid": sid, "ct": ct, "seq": seq }),
        )
        .await
    }
}

type WsSink = futures_util::stream::SplitSink<Ws, Message>;

/// Send a JSON value as a text frame.
async fn send_json(sink: &mut WsSink, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string(v).map_err(|e| format!("json encode: {e}"))?;
    sink.send(Message::Text(text.into()))
        .await
        .map_err(|e| format!("ws send: {e}"))
}

/// Seal a JSON value with a 32-byte key and a fresh random 24-byte nonce →
/// base64(nonce || ct || tag). Matches the TS `encrypt(bytes, key)`.
fn seal_json(v: &Value, key: &[u8; 32]) -> Result<String, String> {
    let bytes = serde_json::to_vec(v).map_err(|e| format!("json encode: {e}"))?;
    let nonce = random_nonce();
    seal(&bytes, key, &nonce).map_err(|e| format!("seal: {e}"))
}

/// 24 random bytes for the `XChaCha20` nonce (the `seal` API takes an explicit
/// nonce; the loopback's ciphertexts are ephemeral so a fresh random nonce is
/// correct and not a golden-vector concern).
fn random_nonce() -> [u8; 24] {
    use rand_core::RngCore;
    let mut n = [0u8; 24];
    rand_core::OsRng.fill_bytes(&mut n);
    n
}

/// base64(STANDARD) encode, matching tp-core's `b64_encode` / the TS `toBase64`.
fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode a 32-byte X25519 pubkey from base64, rejecting the wrong length.
fn decode_pk(b64url: &str) -> Result<[u8; 32], String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64url)
        .map_err(|e| format!("pubkey base64: {e}"))?;
    raw.try_into()
        .map_err(|_| "pubkey must be 32 bytes".to_string())
}

/// Resolve on SIGINT (Ctrl-C) or SIGTERM (`kill`).
async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
