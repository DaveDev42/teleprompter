//! Native `tp <claude args>` passthrough (task #17 PR-4) — the de-trampolined
//! interactive claude REPL path.
//!
//! Replaces the Bun `passthroughCommand` (`apps/cli/src/commands/passthrough.ts`)
//! for the `Route::Passthrough` arm. Runs claude through a Runner connected to
//! the daemon, proxying the local terminal: the Runner owns the claude PTY and
//! streams io/hooks to the daemon (which fans them out to paired phones via its
//! `RelayClient`); this process mirrors that PTY output to the local terminal by
//! polling the shared session-db, and forwards local stdin + terminal resize to
//! the Runner PTY over the daemon IPC socket.
//!
//! # Path A only (service-daemon proxy)
//!
//! The Bun version had two sub-paths: a service-daemon proxy and an in-process
//! ephemeral-daemon fallback. This native port **collapses to Path A** (a
//! resolved design decision): [`ensure_daemon`](crate::ensure_daemon::ensure_daemon)
//! guarantees a daemon is up (starting one if absent), so the ephemeral fallback
//! is unreachable. If a daemon genuinely can't be brought up we fail loud — we
//! never embed a daemon in `tp-cli`, keeping the CLI decoupled from the daemon
//! crate.
//!
//! # Runner spawn (still the blob runner — task #8's job to flip)
//!
//! The Runner is spawned as `<current_exe> run --sid … --cwd … --socket-path …
//! --cols … --rows … -- <claude args>`. `tp run` is a `Route::Forward` that
//! trampolines to the Bun blob runner; that is intentional — de-trampolining the
//! *runner* is task #8 (flip default runner to Rust `tp-runner`), out of scope
//! here. This PR de-trampolines the passthrough *control logic*, not the runner.
//!
//! # Terminal proxy (mirror of passthrough.ts:101-217)
//!
//! - **stdout**: poll `sessions/<sid>.sqlite` every 50 ms (WAL, safe concurrent
//!   read) via [`store::records_from`], write `kind=="io"` payloads to stdout.
//! - **stdin**: raw mode; a reader thread forwards raw bytes as base64 in
//!   `IpcMessage::Input` frames over the daemon IPC socket.
//! - **resize**: the poll loop samples `crossterm::terminal::size()` and, when it
//!   changes, sends an `IpcMessage::Resize` (dep-free equivalent of the Bun
//!   `process.stdout.on("resize")` SIGWINCH handler — folded into the existing
//!   poll cadence rather than adding a signal-hook dependency).
//! - **exit**: wait for the Runner process, do a final drain poll so the last
//!   output lines aren't lost in the 50 ms gap, restore the terminal, and exit
//!   with the Runner's code.

use std::io::{IsTerminal as _, Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::process::{Command, ExitCode, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use tp_proto::ipc::IpcMessage;

use crate::codec::encode_frame;
use crate::ensure_daemon::ensure_daemon;
use crate::format::error_with_hints;
use crate::ipc_session::IpcSession;
use crate::socket::socket_path;
use crate::tui::raw_mode::RawModeGuard;
use crate::{store, util};

/// Fallback terminal size when the local stdout is not a TTY (piped / non-
/// interactive), matching the Bun `process.stdout.columns || 120` /
/// `process.stdout.rows || 40` defaults (passthrough.ts:108-109).
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 40;

/// io-record poll interval — the Bun `setInterval(poll, 50)` (passthrough.ts:189).
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Run the native passthrough for `argv` (the args after the `tp` binary name).
///
/// Returns the Runner's exit code on a clean session, or a non-zero
/// `ExitCode::FAILURE` for a fatal setup error (claude missing, bad `--tp-cwd`,
/// daemon un-startable).
pub fn run(argv: &[String]) -> ExitCode {
    // Preflight: claude must be on PATH (passthrough.ts:44-56). A missing claude
    // is the single most common first-run failure, so surface it with a hint
    // instead of a raw runner spawn error.
    if !claude_available() {
        eprintln!(
            "{}",
            error_with_hints(
                "claude command not found.",
                &[
                    "Install Claude Code: https://claude.com/product/claude-code",
                    "Then re-run: tp",
                ],
            )
        );
        return ExitCode::FAILURE;
    }

    // Split off the --tp-* flags (PR-2). A usage error (missing/flag-like value)
    // prints the same message the Bun CLI did and exits 1.
    let split = match crate::commands::passthrough_split::split_args(argv) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}", e.usage_message());
            return ExitCode::FAILURE;
        }
    };

    let sid = split
        .tp_args
        .sid
        .unwrap_or_else(|| format!("session-{}", util::now_ms()));
    let cwd = split.tp_args.cwd.unwrap_or_else(|| {
        std::env::current_dir().map_or_else(|_| ".".into(), |p| p.display().to_string())
    });
    let claude_args = split.claude_args;

    // Guarantee a daemon is up (Path A). A loud failure here is fatal — we do not
    // fall back to an embedded ephemeral daemon (resolved design decision).
    match ensure_daemon() {
        Ok(true) => {}
        Ok(false) => {
            eprintln!(
                "{}",
                error_with_hints(
                    "Failed to start the daemon.",
                    &["Start it manually: tp daemon start", "Diagnose: tp doctor"],
                )
            );
            return ExitCode::FAILURE;
        }
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    }

    run_service_proxy(&sid, &cwd, &claude_args)
}

/// Whether `claude --version` runs successfully (PATH probe). Mirrors the Bun
/// `Bun.spawnSync(["claude","--version"])` preflight (passthrough.ts:44-51).
fn claude_available() -> bool {
    Command::new("claude")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Current terminal size, falling back to the Bun defaults when stdout is not a
/// TTY.
fn terminal_size() -> (u16, u16) {
    if std::io::stdout().is_terminal() {
        crossterm::terminal::size().unwrap_or((DEFAULT_COLS, DEFAULT_ROWS))
    } else {
        (DEFAULT_COLS, DEFAULT_ROWS)
    }
}

/// The service-daemon proxy path (passthrough.ts:101-217): spawn the Runner
/// pointed at the service daemon socket, then proxy stdout (poll) + stdin/resize
/// (IPC) locally until the Runner exits.
fn run_service_proxy(sid: &str, cwd: &str, claude_args: &[String]) -> ExitCode {
    let sock = socket_path();
    let (cols, rows) = terminal_size();

    // Spawn the runner as `<current_exe> run --sid … -- <claude args>`. Spawn
    // errors (e.g. ENOENT for a bad --tp-cwd) get a friendly hint, mirroring the
    // Bun spawnRunner try/catch (passthrough.ts:117-134).
    let mut runner = match spawn_runner(sid, cwd, &sock, cols, rows, claude_args) {
        Ok(child) => child,
        Err(e) => {
            eprintln!(
                "{}",
                error_with_hints(
                    &format!("Failed to start passthrough session: {e}"),
                    &[
                        "Check that --tp-cwd exists and is accessible",
                        "Try: tp doctor"
                    ],
                )
            );
            return ExitCode::FAILURE;
        }
    };

    // Connect to the daemon IPC socket to forward stdin/resize. Non-fatal on
    // failure: the session still runs (useful for non-interactive -p/--print),
    // stdin just isn't forwarded (passthrough.ts:140-146). The `IpcSession`
    // stays on this thread (it owns a `!Sync` reader channel); the stdin thread
    // gets only the writer handle (`Arc<Mutex<UnixStream>>`, `Send + Sync`).
    let ipc = IpcSession::connect(&sock).ok();

    // Enable raw mode so keystrokes (incl. Ctrl+C = 0x03) flow to the runner PTY
    // as raw bytes rather than being interpreted by the local terminal. The RAII
    // guard restores cooked mode on every return path.
    let _raw = if std::io::stdin().is_terminal() {
        RawModeGuard::enable().ok()
    } else {
        None
    };

    // Shared "session over" flag: set when the runner exits so the stdin reader
    // thread stops.
    let done = Arc::new(AtomicBool::new(false));

    // stdin → IPC input forwarding thread. Reads raw bytes and frames them as
    // base64 IpcMessage::Input over the writer handle. Only started when stdin is
    // a TTY and IPC is up.
    let stdin_thread = match (&ipc, std::io::stdin().is_terminal()) {
        (Some(ipc), true) => {
            let writer = ipc.writer_handle();
            let sid = sid.to_string();
            let done = done.clone();
            Some(thread::spawn(move || {
                forward_stdin(&writer, &sid, &done);
            }))
        }
        _ => None,
    };

    // Poll loop: drain io records → stdout, sample resize → IPC. Runs on this
    // (main) thread until the runner exits.
    let mut last_seq: i64 = 0;
    let mut last_size = (cols, rows);
    loop {
        drain_io(sid, &mut last_seq);

        // Resize sampling — dep-free SIGWINCH equivalent.
        if let Some(ipc) = &ipc {
            let size = terminal_size();
            if size != last_size {
                last_size = size;
                let _ = ipc.send(&IpcMessage::Resize {
                    sid: sid.to_string(),
                    cols: u64::from(size.0),
                    rows: u64::from(size.1),
                });
            }
        }

        // Has the runner exited?
        match runner.try_wait() {
            Ok(Some(status)) => {
                // Final drain so the last output lines aren't lost in the poll gap
                // (passthrough.ts:213-215).
                drain_io(sid, &mut last_seq);
                // Signal the stdin reader to stop. It may still be parked in a
                // blocking `read()`; we don't join it — the process is about to
                // exit and the OS reaps the thread. Dropping the handle detaches
                // it so we never hang shutdown on a stdin read that never returns.
                done.store(true, Ordering::SeqCst);
                drop(stdin_thread);
                return exit_code_of(status);
            }
            Ok(None) => {}
            Err(_) => {
                // Can't reap the child — treat as done to avoid a spin.
                done.store(true, Ordering::SeqCst);
                drop(stdin_thread);
                return ExitCode::FAILURE;
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}

/// Spawn `<current_exe> run --sid <sid> --cwd <cwd> --socket-path <sock>
/// --cols <c> --rows <r> [-- <claude args>]`. The runner inherits stdio's
/// stderr for its own diagnostics but does NOT inherit stdin/stdout — this
/// process owns the terminal and proxies I/O.
fn spawn_runner(
    sid: &str,
    cwd: &str,
    sock: &std::path::Path,
    cols: u16,
    rows: u16,
    claude_args: &[String],
) -> std::io::Result<std::process::Child> {
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    cmd.arg("run")
        .arg("--sid")
        .arg(sid)
        .arg("--cwd")
        .arg(cwd)
        .arg("--socket-path")
        .arg(sock)
        .arg("--cols")
        .arg(cols.to_string())
        .arg("--rows")
        .arg(rows.to_string());
    if !claude_args.is_empty() {
        cmd.arg("--");
        cmd.args(claude_args);
    }
    // The runner talks to the daemon over IPC, not our stdio. Keep its stderr on
    // ours so runner-level fatals are visible; null its stdin/stdout so it never
    // fights us for the terminal.
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    cmd.spawn()
}

/// Drain new io records since `last_seq` and write their raw payloads to stdout.
/// Mirrors the Bun `poll()` (passthrough.ts:178-188): only `kind=="io"` records
/// go to the local terminal (event records are the daemon/phone's concern).
fn drain_io(sid: &str, last_seq: &mut i64) {
    let Some(conn) = store::open_session_db_readonly(sid) else {
        return; // runner hasn't sent hello / created the db yet
    };
    let recs = store::records_from(&conn, *last_seq, 1000);
    if recs.is_empty() {
        return;
    }
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for r in recs {
        if r.kind == "io" {
            let _ = out.write_all(&r.payload);
        }
        *last_seq = r.seq;
    }
    let _ = out.flush();
}

/// Read raw stdin bytes and forward each chunk as a base64 `IpcMessage::Input`
/// over the daemon IPC socket, until `done` is set or stdin hits EOF. Mirrors
/// the Bun `process.stdin.on("data", …)` forwarding (passthrough.ts:194-200).
///
/// Writes directly to the shared `Arc<Mutex<UnixStream>>` writer handle rather
/// than holding the `IpcSession` (whose reader channel is `!Sync` and cannot
/// cross the thread boundary). This mirrors `IpcSession::send`'s framing.
fn forward_stdin(writer: &Arc<Mutex<UnixStream>>, sid: &str, done: &AtomicBool) {
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 4096];
    loop {
        if done.load(Ordering::SeqCst) {
            return;
        }
        match stdin.read(&mut buf) {
            // n > 0: a chunk to forward. 0 (EOF) and Err both mean "stop reading".
            Ok(n) if n > 0 => {
                let msg = IpcMessage::Input {
                    sid: sid.to_string(),
                    data: STANDARD.encode(&buf[..n]),
                };
                if send_frame(writer, &msg).is_err() {
                    return; // socket gone
                }
            }
            _ => return, // EOF (Ok(0)) or read error — end the forwarding loop.
        }
    }
}

/// Serialize and write one framed `IpcMessage` to the shared writer handle —
/// the standalone form of `IpcSession::send` (which needs `&self`). Used by the
/// stdin thread, which only has the writer half.
fn send_frame(writer: &Arc<Mutex<UnixStream>>, msg: &IpcMessage) -> std::io::Result<()> {
    let json = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    let frame = encode_frame(&json);
    let mut guard = writer
        .lock()
        .map_err(|_| std::io::Error::other("writer mutex poisoned"))?;
    guard.write_all(&frame)?;
    guard.flush()
}

/// Map a `std::process::ExitStatus` to an `ExitCode`, propagating the child's
/// numeric code (0-255) where available (passthrough.ts:217).
fn exit_code_of(status: std::process::ExitStatus) -> ExitCode {
    match status.code() {
        Some(code) => ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1)),
        // Killed by signal — no exit code. Report failure.
        None => ExitCode::FAILURE,
    }
}
