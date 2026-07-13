//! End-to-end orchestration test for `tp_runner::runner::run`.
//!
//! Proves the whole loop wires together against a stub daemon: connect → send
//! `hello` → spawn the (faked) claude in a PTY → the child's PTY output flows as
//! io records → the child exits → a `bye` is sent with the child's exit code and
//! `reason="exit"`. This is the increment-2 counterpart to the increment-1 unit
//! tests: it exercises the real `UnixStream`/`UnixListener`/PTY/select-loop path,
//! not just the pure pieces.
//!
//! The claude program is faked via `TP_RUNNER_CLAUDE_BIN` (a shell script that
//! ignores its `--settings …` args, prints a marker, and exits 0). No real
//! `claude` binary is needed, so this runs anywhere.

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::net::UnixListener;

use tp_runner::runner::{run, RunnerOptions};

/// Read every complete framed-JSON message the runner sends on `conn` until it
/// closes, returning the parsed JSON values in order. Mirrors the daemon's frame
/// reading (`u32_be jsonLen + u32_be binLen + json + bin`).
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
async fn run_sends_hello_then_bye_around_a_faked_claude() {
    let dir = tempfile::tempdir().unwrap();
    let daemon_sock = dir.path().join("daemon.sock");
    let listener = UnixListener::bind(&daemon_sock).unwrap();

    // Fake claude: a script that prints a recognisable marker to its PTY (so an
    // io record flows) and exits 0. It ignores the `--settings <json>` args.
    let fake = dir.path().join("fake-claude.sh");
    {
        let mut f = std::fs::File::create(&fake).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "echo TP_RUNNER_E2E_MARKER").unwrap();
        writeln!(f, "exit 0").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // SAFETY seam: the env var is read inside run(); this test is the only one in
    // this integration binary, so there is no parallel reader to race with.
    std::env::set_var("TP_RUNNER_CLAUDE_BIN", &fake);

    // Daemon stub: accept one runner connection, read all its frames to EOF.
    let server = tokio::spawn(async move {
        let (conn, _) = listener.accept().await.unwrap();
        read_all_frames(conn).await
    });

    // A shutdown future that never fires — we want the faked claude's own exit to
    // drive teardown, not a signal.
    let never = std::future::pending::<i32>();

    let opts = RunnerOptions {
        sid: "e2e-sess".into(),
        cwd: dir.path().display().to_string(),
        worktree_path: None,
        socket_path: Some(daemon_sock.clone()),
        cols: Some(80),
        rows: Some(24),
        claude_args: vec![],
    };

    // Run to completion (the faked claude exits ~immediately). Bounded so a hang
    // fails the test rather than blocking forever.
    tokio::time::timeout(Duration::from_secs(10), run(opts, never))
        .await
        .expect("run() should complete when the child exits")
        .expect("run() should return Ok");

    let msgs = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("daemon stub should finish")
        .expect("join");

    std::env::remove_var("TP_RUNNER_CLAUDE_BIN");

    // First frame must be the hello.
    assert!(!msgs.is_empty(), "expected at least hello + bye");
    assert_eq!(msgs[0]["t"], "hello", "first frame is hello");
    assert_eq!(msgs[0]["sid"], "e2e-sess");
    assert!(msgs[0]["pid"].is_number());

    // Last frame must be the bye with reason=exit and exitCode 0.
    let bye = msgs.last().unwrap();
    assert_eq!(bye["t"], "bye", "last frame is bye");
    assert_eq!(bye["sid"], "e2e-sess");
    assert_eq!(bye["reason"], "exit", "child's own exit → reason=exit");
    assert_eq!(bye["exitCode"], 0);
    assert!(
        bye["pid"].is_number(),
        "bye carries the generation-guard pid"
    );

    // At least one io record should have carried the child's PTY output. io
    // records have kind="io" and an empty payload (bytes rode as a binary
    // sidecar — the Stage 4 parity gate).
    //
    // This assertion used to be the flaky one: the child's PTY output and its
    // exit code race across two independent layers (separate OS threads in
    // pty.rs, then an unbiased select! in runner.rs), so on a slow CI box the
    // exit arm could win before the data arm drained the queued chunk. The
    // runner now drains any already-queued PTY output when the exit arm fires
    // (before sending bye), which closes that race — this assertion is the
    // regression lock for that fix (invariant (a): Exit-path drain).
    let io_msgs: Vec<_> = msgs
        .iter()
        .filter(|m| m["t"] == "rec" && m["kind"] == "io")
        .collect();
    assert!(
        !io_msgs.is_empty(),
        "expected at least one io record from the PTY"
    );
    assert_eq!(
        io_msgs[0]["payload"], "",
        "io payload is empty (binary sidecar)"
    );

    // The io record(s) must be ordered strictly before bye — the drain sends
    // into the same FIFO IPC outbound queue ahead of the post-loop bye send,
    // so bye must remain the last frame observed by the daemon.
    let bye_idx = msgs.len() - 1;
    let last_io_idx = msgs
        .iter()
        .rposition(|m| m["t"] == "rec" && m["kind"] == "io")
        .expect("an io record exists");
    assert!(
        last_io_idx < bye_idx,
        "io records must be drained before bye, not after"
    );
}
