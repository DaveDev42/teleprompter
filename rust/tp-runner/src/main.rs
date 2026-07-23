//! `tp-runner` binary entry point (ADR-0003 Stage 4) — tokio port of
//! `packages/runner/src/index.ts`.
//!
//! Parses the argv the daemon's `SessionManager` passes
//! (`--sid <s> --cwd <c> [--socket-path <p>] [--worktree-path <w>]
//! [--cols <n>] [--rows <n>] [-- <claude args...>]`), then runs the session to
//! completion under a single-threaded tokio runtime with SIGINT/SIGTERM graceful
//! shutdown.
//!
//! # Thin wrapper
//!
//! The argv parser and signal→exit-code mapping live in [`tp_runner::cli`] so the
//! native `tp` passthrough path (`tp-cli`, task #17) can reuse them verbatim when
//! it drives [`runner::run`] in-process. This binary is just the runtime bootstrap
//! around those helpers.
//!
//! # Default runner
//!
//! This binary is the **default** runner: the Rust `tp-daemon` spawns it
//! per-session via `tp_proto::locate_tp_runner()` (task #4 flip,
//! `rust/tp-daemon/src/session/manager.rs` `default_runner_command`). The
//! retired Bun daemon and Bun runner were deleted in the #5 zero-Bun cascade
//! PR6 (#933) — this is now the sole implementation. A `TP_RUNNER_BIN` env
//! seam still exists, but only in `rust/tp-e2e-holder/src/spawn.rs`, which
//! pins an exact binary path for its own standalone runner spawns (E2E
//! parity gates) and deliberately never calls `locate_tp_runner()`. The
//! Bun↔Rust differential wire-parity gate that once proved hello/io/bye
//! byte-identical (with the io-record binary sidecar as the load-bearing
//! check) was removed in PR4 (#5 cascade); byte-exactness is now held by
//! `cargo test` + the tp-core golden vectors, with the local
//! `TP_E2E_RUNNER_BIN=1` real-claude gate as the E2E backstop.

use std::process::ExitCode;

use tp_runner::cli::{parse_args, wait_for_signal};
use tp_runner::runner;

fn main() -> ExitCode {
    let opts = match parse_args(std::env::args().skip(1)) {
        Ok(opts) => opts,
        Err(msg) => {
            eprintln!("[Runner] fatal: {msg}");
            return ExitCode::FAILURE;
        }
    };

    // Single-threaded runtime: the runner is I/O-bound (one PTY, one IPC socket,
    // one hook listener) and the PTY's blocking reader lives on its own std
    // thread, so a multi-thread scheduler buys nothing.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[Runner] fatal: failed to start async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    match rt.block_on(async move {
        let shutdown = wait_for_signal();
        runner::run(opts, shutdown).await
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[Runner] fatal: {e}");
            ExitCode::FAILURE
        }
    }
}
