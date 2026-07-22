//! `tp-e2e-holder` — Rust real-daemon E2E holder (Bun-deletion cascade #5,
//! PR2b; replaces `scripts/real-daemon-pair.ts`).
//!
//! Starts a REAL relay (in-process on a free port, or external via
//! `--relay-url`), spawns the REAL Rust `tp-daemon` into the harness's isolated
//! XDG sandbox, optionally spawns/drives a REAL claude session, performs the
//! `pair.begin` pairing handshake over daemon IPC, then holds relay + daemon
//! open until SIGTERM. `scripts/ios.sh start_real_daemon_relay` launches this
//! binary and greps the stdout contract lines.
//!
//! Stdout contract (each line a single flushed write — see `out.rs`):
//!   1. `RUNNER_PARITY_BIN=<path>`   iff TP_RUNNER_BIN non-empty
//!   2. `DAEMON_PARITY_BIN=<path>`   iff TP_DAEMON_BIN non-empty
//!   3. `REAL_SESSION_SID=<sid>`     per claude spawn
//!   4. `pairing begun (id <pairingId>, daemon <daemonId>)`
//!   5. `REAL_PAIR_URL=<qrString>`
//!   6. `REAL_PAIR_READY`
//!
//! Line 4 is a deliberate contract delta vs the Bun holder (where it was
//! stderr): the harness's daemon-id grep (`daemon daemon-[a-z0-9]+`) raced the
//! two-fd `>rp_out 2>>rp_out` redirect there; emitting it on stdout BEFORE
//! REAL_PAIR_URL makes it structurally present by the time the harness's
//! REAL_PAIR_URL poll succeeds. The grep itself is unchanged.
//!
//! Spawn-flag precedence: `--run-claude-webpage` > `--run-claude-coding` >
//! `--run-claude-interactive` > `--run-claude`. `--emit-push-notification` is
//! additive (composes with print mode under TP_E2E_PUSH).
//!
//! LOCAL-ONLY (never CI): real claude auth/credits; the operator's own token is
//! reused by the harness for the operator's own sandbox (unattended-CI
//! plumbing, not credential theft).

mod claude;
mod db;
mod envcfg;
mod ipc;
mod out;
mod push;
mod relay;
mod spawn;

use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tp_proto::ipc::{IpcMessage, IpcPairBeginErrReason, IpcPairErrorReason};

use crate::envcfg::{ensure_isolation_dirs, env_nonempty};
use crate::out::{contract, die, log};
use crate::spawn::{kill_children, spawn_daemon, Children, SharedChildren};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let has_flag = |flag: &str| argv.iter().any(|a| a == flag);

    ensure_isolation_dirs();

    // Tokio runtime: ONLY the embedded relay + the signal listener live on it;
    // all orchestration below is blocking std threads.
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => die(&format!("failed to start tokio runtime: {err}")),
    };

    // 1. Relay endpoint. Default: real in-process relay on a free port. With
    //    `--relay-url`, an external relay — the daemon's proof-carrying
    //    relay.register is accepted by either (no token pre-seed anywhere).
    let relay_url = match parse_relay_url_arg(&argv) {
        Some(url) => {
            log(&format!(
                "using EXTERNAL relay at {url} (no in-process relay started)"
            ));
            url
        }
        None => {
            let url = relay::start_embedded(&rt);
            log(&format!("relay up on {url}"));
            url
        }
    };

    // Parity gate proofs: name the exact binaries serving this run. MUST be
    // stdout (see out.rs) — `assert_runner_parity`/`assert_daemon_parity` grep
    // these lines literally. Gate off ⇒ no line, byte-identical.
    if let Some(p) = env_nonempty("TP_RUNNER_BIN") {
        contract(&format!("RUNNER_PARITY_BIN={p}"));
    }
    if let Some(p) = env_nonempty("TP_DAEMON_BIN") {
        contract(&format!("DAEMON_PARITY_BIN={p}"));
    }

    // 2. Real daemon subprocess, isolated via the inherited XDG_* env.
    let children: SharedChildren = Arc::new(Mutex::new(Children::default()));
    spawn_daemon(&children);
    install_signal_handler(&rt, Arc::clone(&children));

    // 3. Wait for the daemon IPC socket, then connect as the CLI would.
    let socket_path = match tp_proto::socket_path() {
        Ok(p) => p,
        Err(err) => die(&format!("cannot resolve daemon socket path: {err}")),
    };
    wait_for_socket(&socket_path, Duration::from_millis(10_000));
    let (writer, rx) = match ipc::connect(&socket_path) {
        Ok(pair) => pair,
        Err(err) => die(&format!("IPC connect failed: {err}")),
    };
    log(&format!("IPC connected at {}", socket_path.display()));

    // 3b. Spawn the real claude session NOW — before pairing — so the daemon
    //     has registered (and stored) the session by the time the app sends its
    //     `hello` (race-free: a stopped print session still lists; spawning
    //     post-`pair.completed` raced the app's first hello). Pairing does not
    //     depend on the session, so the two proceed concurrently.
    let socket_str = socket_path.to_string_lossy().to_string();
    if has_flag("--run-claude-webpage") {
        claude::start_webpage(&children, writer.clone(), &socket_str);
    } else if has_flag("--run-claude-coding") {
        claude::start_coding(&children, writer.clone(), &socket_str);
    } else if has_flag("--run-claude-interactive") {
        claude::start_interactive(&children, writer.clone(), &socket_str);
    } else if has_flag("--run-claude") {
        claude::start_print(&children, &socket_str);
    }

    // 4. pair.begin → contract lines on pair.begin.ok → REAL_PAIR_READY on
    //    pair.completed.
    let begin = IpcMessage::PairBegin {
        relay_url: relay_url.clone(),
        daemon_id: None,
        label: None,
    };
    if let Err(err) = writer.send(&begin) {
        die(&format!("pair.begin send failed: {err}"));
    }
    wait_for_pairing(&rx);

    // 5b. PUSH E2E: detached so it does not block the hold-open loop; the
    //     session DB it targets is created by the --run-claude session above.
    if has_flag("--emit-push-notification") {
        let sid = claude::claude_sid();
        let push_writer = writer.clone();
        std::thread::spawn(move || push::emit_push_notification(&sid, &push_writer));
    }

    // 6. Stay alive — relay + daemon must keep serving the app until the
    //    harness kills us (exit happens in the signal handler).
    log("paired; holding relay + daemon open until SIGTERM");
    loop {
        std::thread::sleep(Duration::from_secs(3_600));
    }
}

/// Optional `--relay-url <ws://…>` / `--relay-url=<ws://…>`.
fn parse_relay_url_arg(argv: &[String]) -> Option<String> {
    for (i, arg) in argv.iter().enumerate() {
        if arg == "--relay-url" {
            return argv.get(i + 1).cloned();
        }
        if let Some(rest) = arg.strip_prefix("--relay-url=") {
            return Some(rest.to_string());
        }
    }
    None
}

fn wait_for_socket(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    die(&format!(
        "daemon socket never appeared at {} within {}ms",
        path.display(),
        timeout.as_millis()
    ));
}

/// SIGINT/SIGTERM → SIGTERM the runner (it owns the claude PTY) then the
/// daemon, then exit(0). The embedded relay dies with the process.
fn install_signal_handler(rt: &tokio::runtime::Runtime, children: SharedChildren) {
    rt.spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            log("WARN — failed to install signal handlers");
            return;
        };
        tokio::select! {
            _ = term.recv() => {},
            _ = int.recv() => {},
        }
        log("shutdown signal received — tearing down runner + daemon");
        kill_children(&children);
        std::process::exit(0);
    });
}

/// Drain IPC until `pair.completed`. Contract-line ordering per module docs.
fn wait_for_pairing(rx: &Receiver<IpcMessage>) {
    loop {
        match rx.recv() {
            Ok(IpcMessage::PairBeginOk {
                pairing_id,
                qr_string,
                daemon_id,
            }) => {
                contract(&format!(
                    "pairing begun (id {pairing_id}, daemon {daemon_id})"
                ));
                contract(&format!("REAL_PAIR_URL={qr_string}"));
            }
            Ok(IpcMessage::PairCompleted { daemon_id, .. }) => {
                contract("REAL_PAIR_READY");
                log(&format!("pairing completed (daemon {daemon_id})"));
                return;
            }
            Ok(IpcMessage::PairBeginErr { reason, message }) => die(&format!(
                "pair.begin.err: {} {}",
                begin_err_str(&reason),
                message.unwrap_or_default()
            )),
            Ok(IpcMessage::PairError {
                reason, message, ..
            }) => die(&format!(
                "pair.error: {} {}",
                pair_err_str(&reason),
                message.unwrap_or_default()
            )),
            Ok(IpcMessage::PairCancelled { .. }) => die("pair.cancelled"),
            Ok(_) => {} // acks / state broadcasts — irrelevant here
            Err(_) => die("daemon IPC closed before pairing completed"),
        }
    }
}

/// Wire-string form of the reason enums (serde rename values), for die
/// messages matching the Bun holder's `${msg.reason}` interpolation.
fn begin_err_str(reason: &IpcPairBeginErrReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| format!("{reason:?}"))
}

fn pair_err_str(reason: &IpcPairErrorReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| format!("{reason:?}"))
}
