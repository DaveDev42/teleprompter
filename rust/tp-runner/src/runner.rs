//! Runner orchestration — tokio port of `packages/runner/src/runner.ts`.
//!
//! Ties the IPC client ([`crate::ipc`]), hook receiver ([`crate::hooks`]), and
//! PTY ([`crate::pty`]) together via a single `select!` loop (the Rust idiom
//! that replaces the Bun callback wiring). Lifecycle mirrors the TS state
//! machine: connect IPC → send `hello` → start hook receiver → build settings →
//! spawn claude in a PTY → pump io/hooks to the daemon → on stop, send `bye`,
//! kill the PTY child, remove the hook socket.
//!
//! # Invariants preserved from the Bun Runner
//!
//! The Bun Runner tracks an explicit `created→…→stopped` state and gates io/hooks
//! on `state === "running"`. This port expresses the same gating *structurally*:
//! io + hook records are produced only inside the `select!` loop, and the loop
//! `break`s the instant a terminal branch (PTY exit / signal / IPC close) fires —
//! so once teardown begins, no further records are produced. Concretely:
//!
//! - **io/hooks only while running**: both are built inside the loop body; the
//!   PTY is spawned *before* the loop, so claude's early `SessionStart` hook is
//!   already handled in the running phase (the Bun "spawning accepts hooks" gap
//!   collapses to "the loop is running").
//! - **hooks dropped during teardown**: breaking out of the loop stops consuming
//!   `hook_rx`, so a hook racing daemon teardown is not forwarded.
//! - **bye carries pid + reason**: the `pid` is the daemon's generation guard
//!   (a stale bye from an old runner generation must not tear down a restarted
//!   session); `reason` disambiguates a signal-kill exit code from a real crash.
//! - **stop kills the PTY child**: reached from the PTY's own exit (no-op kill)
//!   AND from a signal / IPC-close teardown (claude still alive) — without the
//!   kill the child is orphaned to init, leaking the process + its cwd/worktree
//!   hold.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::collector::Collector;
use crate::hooks::HookReceiver;
use crate::ipc::{Inbound, IpcClient};
use crate::pty::{Pty, PtyOptions};
use crate::settings::build_settings;
use crate::socket::{daemon_socket_path, hook_socket_path};
use crate::wire::{Bye, ByeReason, Hello};

/// Options for [`run`], mirroring the TS `RunnerOptions`.
pub struct RunnerOptions {
    pub sid: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub socket_path: Option<PathBuf>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub claude_args: Vec<String>,
}

/// `Date.now()` equivalent — milliseconds since the Unix epoch, as an `f64` (the
/// JS `number` the record `ts` field carries).
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Run a session to completion. Connects, spawns claude, pumps the session, and
/// returns once the session has stopped (claude exited, a signal arrived, or the
/// IPC connection tore down). The `bye` frame is sent before returning.
///
/// `shutdown` resolves when the process receives SIGINT/SIGTERM (the caller wires
/// it to `tokio::signal`); its receipt triggers a graceful stop with the mapped
/// exit code (130 for SIGINT, 143 for SIGTERM) and `reason = signal`.
pub async fn run(
    opts: RunnerOptions,
    shutdown: impl std::future::Future<Output = i32>,
) -> std::io::Result<()> {
    let collector = Collector::new(opts.sid.clone());

    // ── Connect IPC ──────────────────────────────────────────────────────────
    let socket_path = match opts.socket_path.clone() {
        Some(p) => p,
        None => daemon_socket_path()?,
    };
    let mut ipc = IpcClient::connect(&socket_path).await?;

    // Send hello.
    let pid = std::process::id();
    let hello = Hello::new(
        opts.sid.clone(),
        opts.cwd.clone(),
        opts.worktree_path.clone(),
        pid,
    );
    let hello_json = serde_json::to_vec(&hello).expect("hello serialises");
    let _ = ipc.handle.send(&hello_json, None);

    // ── Start hook receiver ──────────────────────────────────────────────────
    let hook_path = hook_socket_path(&opts.sid)?;
    let (hook_tx, mut hook_rx) = mpsc::channel::<Value>(1024);
    let mut hook_receiver = HookReceiver::start(hook_path.clone(), hook_tx)?;

    // Build settings referencing the hook socket.
    let settings_json = build_settings(
        &hook_path.to_string_lossy(),
        Some(std::path::Path::new(&opts.cwd)),
    );

    // ── Spawn claude in a PTY ────────────────────────────────────────────────
    // The program is `claude` in production; `TP_RUNNER_CLAUDE_BIN` overrides it
    // (a test/debug seam — unset in production, so this resolves to "claude").
    let claude_bin = std::env::var("TP_RUNNER_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());
    let mut command = vec![claude_bin, "--settings".to_string(), settings_json];
    command.extend(opts.claude_args.iter().cloned());

    // Bridge the PTY's thread callbacks into the async select loop over channels
    // (the reader-task hop): data chunks and the single exit code.
    let (pty_data_tx, mut pty_data_rx) = mpsc::channel::<Vec<u8>>(1024);
    let (pty_exit_tx, mut pty_exit_rx) = mpsc::channel::<i32>(1);
    let pty = Pty::spawn(
        PtyOptions {
            command,
            cwd: opts.cwd.clone(),
            cols: opts.cols,
            rows: opts.rows,
        },
        move |bytes| {
            // Non-blocking: if the loop fell behind we drop rather than block the
            // reader thread (bounded queue; PTY io is best-effort under teardown).
            let _ = pty_data_tx.try_send(bytes.to_vec());
        },
        move |code| {
            let _ = pty_exit_tx.try_send(code);
        },
    )
    .map_err(|e| std::io::Error::other(e.to_string()))?;

    tokio::pin!(shutdown);

    // The loop runs while the session is "running"; it breaks with the stop
    // (exit_code, reason) once a terminal branch fires. Because io/hook records
    // are only produced inside the loop, they are implicitly gated to the running
    // phase — the moment a terminal branch breaks, no further records are sent
    // (the Bun `state === "running"` gate + hooks-dropped-in-teardown, expressed
    // structurally). claude's `SessionStart` hook that the Bun runner accepts
    // during "spawning" is likewise handled: the PTY is spawned before the loop,
    // so any hook arriving here is already in the running phase.
    let (exit_code, reason): (i32, ByeReason) = loop {
        tokio::select! {
            // Inbound IPC: ack (no-op), input (write PTY), resize.
            maybe = ipc.inbound.recv() => {
                match maybe {
                    Some(Inbound::Ack { .. }) => { /* informational */ }
                    Some(Inbound::Input { data }) => {
                        if let Ok(bytes) = STANDARD.decode(data.as_bytes()) {
                            // Routed through `&self` (write_shared) — the loop holds
                            // the Pty by shared ref (also for resize/kill).
                            pty_write(&pty, &bytes);
                        }
                    }
                    Some(Inbound::Resize { cols, rows }) => {
                        let _ = pty.resize(cols as u16, rows as u16);
                    }
                    None => { /* inbound channel closed; ipc.closed() will fire */ }
                }
            }

            // Hook event → event record.
            Some(event) = hook_rx.recv() => {
                if let Some(rec) = collector.event_record(&event, now_ms()) {
                    let json = serde_json::to_vec(&rec).expect("rec serialises");
                    if !ipc.handle.send(&json, None) {
                        // overflow/closed → stop (transport teardown, not a crash)
                        break (-1, ByeReason::Signal);
                    }
                }
            }

            // PTY output → io record (binary sidecar).
            Some(chunk) = pty_data_rx.recv() => {
                let rec = collector.io_record(chunk, now_ms());
                let json = serde_json::to_vec(&rec.msg).expect("io rec serialises");
                if !ipc.handle.send(&json, Some(&rec.binary)) {
                    break (-1, ByeReason::Signal);
                }
            }

            // claude's PTY child exited on its own — meaningful exit code.
            Some(code) = pty_exit_rx.recv() => {
                break (code, ByeReason::Exit);
            }

            // IPC connection tore down (writer error / reader EOF / decode error).
            () = ipc.handle.closed() => {
                break (-1, ByeReason::Signal);
            }

            // SIGINT/SIGTERM graceful shutdown.
            code = &mut shutdown => {
                break (code, ByeReason::Signal);
            }
        }
    };

    // ── Stop: send bye, kill PTY child, remove hook socket ───────────────────
    let bye = Bye::new(opts.sid.clone(), exit_code, pid, reason);
    let bye_json = serde_json::to_vec(&bye).expect("bye serialises");
    let _ = ipc.handle.send(&bye_json, None);

    // Kill the PTY child (idempotent — no-op if it already exited). Prevents
    // orphaning claude to init when we stop for a signal / IPC-close rather than
    // the child's own exit.
    pty.kill(None);

    hook_receiver.stop();
    ipc.handle.close();

    // Give the writer task a tick to flush the bye before the runtime unwinds
    // (the Bun `setImmediate` bye-flush tick analogue). The daemon's proc.exited
    // monitor compensates if it's still lost, so this only removes cosmetic
    // latency — but it makes the clean-exit path actually clean.
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    Ok(())
}

/// Write bytes to the PTY. `Pty::write` takes `&mut self`, but the select loop
/// holds the `Pty` by shared ref (it also calls `resize`/`kill` through `&self`).
/// The writer half of portable-pty is internally a `Box<dyn Write + Send>` behind
/// the master; we route the write through a small interior-mutability shim on the
/// Pty rather than threading `&mut` through the loop.
fn pty_write(pty: &Pty, bytes: &[u8]) {
    pty.write_shared(bytes);
}
