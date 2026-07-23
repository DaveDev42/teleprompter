//! Native `tp run`: exec the bundled Rust `tp-runner` with the caller's argv.
//!
//! # Architecture
//!
//! `tp run` starts a per-session Runner (opens a claude PTY, connects to the
//! daemon over the IPC unix socket, streams io + hooks Records). Before task #8
//! it trampolined through the Bun blob (`tpd` — blob + forwarder deleted in
//! #5 PR6); this module execs the shipped Rust `tp-runner` natively,
//! exactly mirroring the `tp relay` → `tp-relay` flip (`commands::relay`, #25).
//!
//! Unlike `relay`, **no flag translation is needed**: the Bun `run` argv contract
//! (`--sid`/`--cwd`/`--worktree-path`/`--socket-path`/`--cols`/`--rows` +
//! `-- <claude args>`, `apps/cli/src/commands/run.ts`) is byte-for-byte the argv
//! `tp-runner` already parses (`rust/tp-runner/src/cli.rs::parse_args`) — it is
//! the same argv the daemon spawns `tp-runner` with (`tp-daemon`
//! `SessionManager::spawn_runner`). So `run` forwards the caller's remaining argv
//! verbatim.
//!
//! Standalone `tp run` requires nothing the daemon-spawned runner path doesn't:
//! there is no `ensureDaemon()` and no session-store write in the Bun `run`
//! handler either — both assume a live daemon IPC socket and let the runner
//! register the session on its `hello` frame. So this native exec has no missing
//! prerequisite to backfill.
//!
//! # Why `exec()` instead of `.status()`
//!
//! Same rationale as `relay::exec_relay` / `forward_claude`:
//! `CommandExt::exec()` is a safe fn (returns `io::Error`, never returns on
//! success), satisfying `unsafe_code = "forbid"`, and gives true process-image
//! replacement — `tp-runner` inherits stdio, the controlling TTY, and all
//! signals, and its exit code becomes `tp`'s. No Rust parent is left in the
//! signal path.
//!
//! Note the interactive-passthrough path (`commands::passthrough::spawn_runner`)
//! self-recursively shells `<current_exe> run …` with `.spawn()` (it must stay
//! alive to proxy the terminal). That path benefits from this flip with no edit —
//! it now reaches the native `tp-runner` instead of the blob.

use crate::format::error_with_hints;
use std::process::ExitCode;
use tp_proto::locate_tp_runner;

/// Exec `tp-runner` with the given args (the original argv after `tp`, i.e.
/// starting at the `run` token). `run` is forwarded verbatim as `tp-runner`
/// ignores a leading non-flag positional — but to match the daemon's argv shape
/// exactly we strip the leading `run` token so `tp-runner` sees only its flags.
///
/// On success this **never returns** — `tp-runner` takes over the process image.
/// On failure (binary not found or exec syscall error) it prints to stderr and
/// returns `ExitCode::FAILURE`.
pub fn run(args: &[String]) -> ExitCode {
    // `args` is argv after the binary name, so `args[0] == "run"`. Strip it — the
    // runner's parser expects only its own flags (`--sid`, …), never a `run`
    // subcommand token (the daemon spawns `tp-runner --sid …`, no `run`).
    let runner_argv: &[String] = match args.split_first() {
        Some((first, rest)) if first == "run" => rest,
        // Defensive: dispatched only for `run`, but if called without it, forward
        // everything rather than silently dropping an arg.
        _ => args,
    };

    let bin = match locate_tp_runner() {
        Ok(p) => p,
        Err(msg) => {
            eprintln!(
                "{}",
                error_with_hints(
                    &msg,
                    &["Reinstall tp, or set TP_RUNNER_BIN to a tp-runner binary."]
                )
            );
            return ExitCode::FAILURE;
        }
    };

    exec_runner(&bin, runner_argv)
}

/// Exec `tp-runner <argv>`, replacing the process image (inherits stdio + TTY +
/// signals). Returns only on an exec syscall error.
#[cfg(unix)]
fn exec_runner(bin: &std::path::Path, argv: &[String]) -> ExitCode {
    use std::os::unix::process::CommandExt;

    // exec() replaces the process image — tp-runner inherits our stdio + TTY, and
    // its exit code becomes ours. Returns only on an exec syscall failure.
    let err = std::process::Command::new(bin).args(argv).exec();
    eprintln!("tp: failed to exec {}: {err}", bin.display());
    ExitCode::FAILURE
}

/// Stub for non-Unix targets (tp is POSIX-only).
#[cfg(not(unix))]
fn exec_runner(_bin: &std::path::Path, _argv: &[String]) -> ExitCode {
    eprintln!(
        "tp: `run` requires a POSIX system. tp does not support native Windows — \
         run inside WSL (Ubuntu/Debian) with the Linux build."
    );
    ExitCode::FAILURE
}
