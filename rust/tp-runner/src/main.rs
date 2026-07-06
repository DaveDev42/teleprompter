//! `tp-runner` binary entry point (ADR-0003 Stage 4).
//!
//! Increment 1 scaffolds the crate's pure/testable slices (settings, collector)
//! and the PTY spike ([`tp_runner::pty`]); the full orchestration — tokio IPC
//! client, hook receiver, and the `Runner` state machine that wires them to the
//! PTY — lands in the next increment. Until then this binary is not wired for
//! production use: the dual-run seam (`TP_RUNNER_BIN`) still points sessions at
//! the Bun runner (`tpd run`), so this entry point is never invoked by the
//! daemon. It exits non-zero with a clear message rather than pretending to run.

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!(
        "tp-runner: not yet wired for production (ADR-0003 Stage 4, increment 1 — \
         pure slices + PTY spike only). The daemon runs sessions via the Bun \
         runner (`tpd run`); TP_RUNNER_BIN has not been cut over to this binary."
    );
    ExitCode::FAILURE
}
