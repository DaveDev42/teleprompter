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
//! # Dual-run, no cutover
//!
//! The binary is fully wired AND selectable: setting `TP_RUNNER_BIN` to this
//! binary's absolute path makes the daemon's CLI (`resolveRunnerCommandWithOverride`)
//! spawn it per-session instead of the Bun runner. The **default** is still the
//! Bun runner (`tpd run`) — the opt-in seam does not flip it. A differential
//! wire-parity gate (`packages/daemon/src/session/runner-parity.test.ts`) drives
//! both runners with the same fake claude (via `TP_RUNNER_CLAUDE_BIN`) and asserts
//! byte-identical hello/io/bye frames, with the io-record binary sidecar as the
//! load-bearing check. Cutting the default over to this binary is the next step
//! (increment 4), gated on dogfood parity.

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
