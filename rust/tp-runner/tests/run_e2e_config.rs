//! End-to-end proof that `tp_runner::runner::run` honors `config.json`'s
//! `claudeCommand` (user-configurable claude launch command) when no
//! `TP_RUNNER_CLAUDE_BIN` override is present.
//!
//! A SEPARATE integration test binary (own OS process) from `run_e2e.rs` /
//! `run_e2e_signal.rs` — same SAFETY rationale as `run_e2e_signal.rs`'s module
//! doc: this test mutates process-global env (`XDG_CONFIG_HOME`, and
//! defensively unsets `TP_RUNNER_CLAUDE_BIN`), and `cargo test` runs each
//! integration test *file* as its own process, so there is no parallel
//! reader/writer within this binary to race with.

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::net::UnixListener;

use tp_runner::runner::{run, RunnerOptions};

/// Read every complete framed-JSON message the runner sends on `conn` until it
/// closes, returning the parsed JSON values in order. Mirrors `run_e2e.rs`'s
/// helper (daemon frame reading: `u32_be jsonLen + u32_be binLen + json + bin`).
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
async fn run_spawns_configured_claude_command_from_config_json() {
    // Unique sid — see `run_e2e.rs`'s comment on why the hook-socket path
    // (derived only from sid, under a per-user runtime dir shared across
    // worktrees) needs a nonce, not just a hardcoded literal.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock should be after the epoch")
        .as_nanos();
    let sid = format!("e2e-cfg-sess-{}-{nonce}", std::process::id());

    let dir = tempfile::tempdir().unwrap();
    let daemon_sock = dir.path().join("daemon.sock");
    let listener = UnixListener::bind(&daemon_sock).unwrap();

    // The wrapper `config.json` points `claudeCommand` at — deliberately NOT
    // named "claude" and prints a DIFFERENT marker than `run_e2e.rs`'s fake,
    // so a clean hello→io→bye(reason=exit,exitCode=0) sequence can only be
    // explained by `run()` actually resolving+spawning THIS script (a real
    // interactive `claude`, if mistakenly spawned instead, would not exit on
    // its own within the timeout below).
    let wrapper = dir.path().join("fake-wrapper.sh");
    {
        let mut f = std::fs::File::create(&wrapper).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "echo TP_RUNNER_E2E_CONFIG_MARKER").unwrap();
        writeln!(f, "exit 0").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // `$XDG_CONFIG_HOME/teleprompter/config.json` with `claudeCommand` set to
    // the wrapper's absolute path (matches `tp_proto::user_config::config_file_path`'s
    // resolution algorithm).
    let config_home = dir.path().join("xdg-config");
    let config_dir = config_home.join("teleprompter");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("config.json"),
        format!(r#"{{"claudeCommand":["{}"]}}"#, wrapper.display()),
    )
    .unwrap();

    // SAFETY seam (own process — see module doc): `TP_RUNNER_CLAUDE_BIN` must
    // be ABSENT for config resolution to take effect (env override wins over
    // config, by design).
    std::env::remove_var("TP_RUNNER_CLAUDE_BIN");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Daemon stub: accept one runner connection, read all its frames to EOF.
    let server = tokio::spawn(async move {
        let (conn, _) = listener.accept().await.unwrap();
        read_all_frames(conn).await
    });

    // A shutdown future that never fires — the wrapper's own exit drives
    // teardown, not a signal.
    let never = std::future::pending::<i32>();

    let opts = RunnerOptions {
        sid: sid.clone(),
        cwd: dir.path().display().to_string(),
        worktree_path: None,
        socket_path: Some(daemon_sock.clone()),
        cols: Some(80),
        rows: Some(24),
        claude_args: vec![],
    };

    tokio::time::timeout(Duration::from_secs(10), run(opts, never))
        .await
        .expect("run() should complete when the configured wrapper exits")
        .expect("run() should return Ok");

    let msgs = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("daemon stub should finish")
        .expect("join");

    std::env::remove_var("XDG_CONFIG_HOME");

    assert!(!msgs.is_empty(), "expected at least hello + bye");
    assert_eq!(msgs[0]["t"], "hello", "first frame is hello");
    assert_eq!(msgs[0]["sid"], sid);

    let bye = msgs.last().unwrap();
    assert_eq!(bye["t"], "bye", "last frame is bye");
    assert_eq!(bye["sid"], sid);
    assert_eq!(
        bye["reason"], "exit",
        "the configured wrapper's own exit → reason=exit"
    );
    assert_eq!(bye["exitCode"], 0);

    let io_msgs: Vec<_> = msgs
        .iter()
        .filter(|m| m["t"] == "rec" && m["kind"] == "io")
        .collect();
    assert!(
        !io_msgs.is_empty(),
        "expected at least one io record from the configured wrapper's PTY output"
    );
}
