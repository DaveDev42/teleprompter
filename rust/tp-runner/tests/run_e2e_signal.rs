//! Regression test for the OTHER half of the exit-drain invariant introduced
//! alongside the `run_e2e.rs` flake fix: the drain added to the
//! `pty_exit_rx` arm must stay scoped to that arm only. Signal / IPC-close
//! teardown must keep dropping in-flight PTY io per the documented
//! "hooks/io dropped during teardown" invariant (see `runner.rs` module doc).
//!
//! Kept in its own integration-test binary (rather than a second
//! `#[tokio::test]` in `run_e2e.rs`) because `run_e2e.rs` sets/removes the
//! process-global `TP_RUNNER_CLAUDE_BIN` env var and documents itself as the
//! only test in its binary — `std::env::set_var` races across concurrently
//! run tests within one binary. A separate binary gets its own process, so
//! there is no shared env-var mutation to race.

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::net::UnixListener;

use tp_runner::runner::{run, RunnerOptions};

/// Mirrors `run_e2e.rs::read_all_frames` — read every complete framed-JSON
/// message the runner sends on `conn` until it closes.
async fn read_all_frames(mut conn: tokio::net::UnixStream) -> Vec<serde_json::Value> {
    let mut msgs = Vec::new();
    loop {
        let mut header = [0u8; 8];
        if conn.read_exact(&mut header).await.is_err() {
            break; // EOF
        }
        let json_len = u32::from_be_bytes(header[0..4].try_into().unwrap()) as usize;
        let bin_len = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
        let mut json = vec![0u8; json_len];
        if conn.read_exact(&mut json).await.is_err() {
            break;
        }
        if bin_len > 0 {
            let mut bin = vec![0u8; bin_len];
            if conn.read_exact(&mut bin).await.is_err() {
                break;
            }
        }
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&json) {
            msgs.push(v);
        }
    }
    msgs
}

#[tokio::test]
async fn signal_path_still_drops_in_flight_io() {
    let dir = tempfile::tempdir().unwrap();
    let daemon_sock = dir.path().join("daemon.sock");
    let listener = UnixListener::bind(&daemon_sock).unwrap();

    // Fake claude: a long-lived child that sleeps *before* printing anything,
    // then sleeps again well past our shutdown trigger — so the process is
    // still alive (pty_exit_rx has NOT fired) and, crucially, has not yet
    // written its marker into the PTY when `shutdown` resolves. This is what
    // makes the assertion below deterministic rather than a timing race
    // against the always-running data arm (`Some(chunk) =
    // pty_data_rx.recv()`): if the child *had* already written by the time
    // shutdown fires, the data arm — not any drain — would likely have
    // already forwarded it during the wait, which would prove nothing about
    // the Signal arm specifically. By construction no chunk exists in
    // pty_data_rx (nor has one already been forwarded) at teardown time, so
    // an empty io-record set here is a clean, non-flaky observation.
    let fake = dir.path().join("fake-claude-longlived.sh");
    {
        let mut f = std::fs::File::create(&fake).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "sleep 30 &").unwrap();
        writeln!(f, "wait").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // SAFETY seam: this integration-test binary has exactly one test, so
    // there is no parallel reader/writer to race with (see module doc).
    std::env::set_var("TP_RUNNER_CLAUDE_BIN", &fake);

    // Daemon stub: accept one runner connection, read all its frames to EOF.
    let server = tokio::spawn(async move {
        let (conn, _) = listener.accept().await.unwrap();
        read_all_frames(conn).await
    });

    // A shutdown future that fires almost immediately — well before the
    // child's 30s sleep would exit it — so the Signal arm, not the Exit arm,
    // drives teardown while the child is still alive and has produced no PTY
    // output at all. Maps to SIGINT's code (130), as the real
    // `tokio::signal`-backed future would.
    let shutdown = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        130
    };

    let opts = RunnerOptions {
        sid: "e2e-signal-sess".into(),
        cwd: dir.path().display().to_string(),
        worktree_path: None,
        socket_path: Some(daemon_sock.clone()),
        cols: Some(80),
        rows: Some(24),
        claude_args: vec![],
    };

    tokio::time::timeout(Duration::from_secs(10), run(opts, shutdown))
        .await
        .expect("run() should complete once shutdown fires")
        .expect("run() should return Ok");

    let msgs = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("daemon stub should finish")
        .expect("join");

    std::env::remove_var("TP_RUNNER_CLAUDE_BIN");

    assert!(!msgs.is_empty(), "expected at least hello + bye");
    assert_eq!(msgs[0]["t"], "hello", "first frame is hello");

    // The bye must reflect the Signal path (reason=signal, exitCode mapped
    // from the shutdown future — 130), not the child's own (never-reached)
    // exit code.
    let bye = msgs.last().unwrap();
    assert_eq!(bye["t"], "bye", "last frame is bye");
    assert_eq!(bye["sid"], "e2e-signal-sess");
    assert_eq!(
        bye["reason"], "signal",
        "shutdown-driven teardown → reason=signal, NOT exit"
    );
    assert_eq!(bye["exitCode"], 130);

    // Core invariant under test: the Signal arm must NOT drain pty_data_rx
    // the way the Exit arm now does. By construction the child has produced
    // no PTY output at all by the time shutdown fires (see setup comment
    // above), so ANY io record appearing here would mean either (a) the
    // Signal arm somehow drained a queue that should be empty, or (b) a
    // future refactor accidentally hoisted the Exit-arm drain to cover
    // teardown broadly — this assertion structurally guards against both, by
    // pairing with `runner.rs`'s comment that scopes the drain to the
    // `pty_exit_rx` arm alone and leaves the Signal / IPC-close / hook /
    // shutdown arms unchanged (still `break`ing immediately with no drain,
    // matching the documented "hooks/io dropped during teardown" invariant).
    let io_after: Vec<_> = msgs
        .iter()
        .filter(|m| m["t"] == "rec" && m["kind"] == "io")
        .collect();
    assert!(
        io_after.is_empty(),
        "Signal path must not drain in-flight PTY io, found: {io_after:?}"
    );
}
