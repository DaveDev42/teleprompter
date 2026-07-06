//! `tp-runner` binary entry point (ADR-0003 Stage 4) — tokio port of
//! `packages/runner/src/index.ts`.
//!
//! Parses the argv the daemon's SessionManager passes
//! (`--sid <s> --cwd <c> [--socket-path <p>] [--worktree-path <w>]
//! [--cols <n>] [--rows <n>] [-- <claude args...>]`), then runs the session to
//! completion under a single-threaded tokio runtime with SIGINT/SIGTERM graceful
//! shutdown.
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

use std::path::PathBuf;
use std::process::ExitCode;

use tp_runner::runner::{self, RunnerOptions};

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

/// Resolve when a SIGINT or SIGTERM arrives, returning the mapped exit code
/// (130 for SIGINT, 143 for SIGTERM — the shell's `128 + signo` convention that
/// the daemon's `reason="signal"` handling expects). Mirrors the Bun
/// `gracefulShutdown` signal→code mapping.
async fn wait_for_signal() -> i32 {
    use tokio::signal::unix::{signal, SignalKind};
    // If either handler fails to install, fall back to a future that never
    // resolves for that signal (the other still works; the PTY-exit / IPC-close
    // branches still drive teardown).
    let mut sigint = signal(SignalKind::interrupt()).ok();
    let mut sigterm = signal(SignalKind::terminate()).ok();

    // Poll whichever is installed.
    match (sigint.as_mut(), sigterm.as_mut()) {
        (Some(int), Some(term)) => tokio::select! {
            _ = int.recv() => 130,
            _ = term.recv() => 143,
        },
        (Some(int), None) => {
            int.recv().await;
            130
        }
        (None, Some(term)) => {
            term.recv().await;
            143
        }
        (None, None) => std::future::pending().await,
    }
}

/// Parse the runner argv into [`RunnerOptions`]. Matches the Bun `parseArgs`
/// options (string flags + positionals after `--`), with the same defaults
/// (`cwd` = current dir, `cols`/`rows` = 120/40 clamped to ≥1) and the same
/// auto-generated `sid` fallback shape (`session-<ms>`), and NaN-safe int parsing.
fn parse_args(args: impl Iterator<Item = String>) -> Result<RunnerOptions, String> {
    let mut sid: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut worktree_path: Option<String> = None;
    let mut socket_path: Option<String> = None;
    let mut cols: Option<u16> = None;
    let mut rows: Option<u16> = None;
    let mut claude_args: Vec<String> = Vec::new();

    let mut it = args.peekable();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--" => {
                // Everything after `--` is a claude arg (positional).
                claude_args.extend(it.by_ref());
                break;
            }
            "--sid" => sid = Some(take_value(&mut it, "--sid")?),
            "--cwd" => cwd = Some(take_value(&mut it, "--cwd")?),
            "--worktree-path" => worktree_path = Some(take_value(&mut it, "--worktree-path")?),
            "--socket-path" => socket_path = Some(take_value(&mut it, "--socket-path")?),
            "--cols" => cols = Some(parse_dim(&take_value(&mut it, "--cols")?, 120)),
            "--rows" => rows = Some(parse_dim(&take_value(&mut it, "--rows")?, 40)),
            other => {
                // Unknown flag / stray positional before `--`. The Bun parser
                // allows positionals; treat as a claude arg for forward-compat.
                claude_args.push(other.to_string());
            }
        }
    }

    let sid = sid.unwrap_or_else(|| format!("session-{}", now_ms_u128()));
    let cwd = cwd
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.display().to_string())
        })
        .ok_or("could not determine cwd")?;

    Ok(RunnerOptions {
        sid,
        cwd,
        worktree_path,
        socket_path: socket_path.map(PathBuf::from),
        cols,
        rows,
        claude_args,
    })
}

/// Consume the value following a `--flag`, erroring if it is absent or itself
/// looks like a flag (mirrors the CLI's `--tp-*` value guard rationale — a real
/// sid/cwd never starts with `-`).
fn take_value(
    it: &mut std::iter::Peekable<impl Iterator<Item = String>>,
    flag: &str,
) -> Result<String, String> {
    match it.peek() {
        Some(v) if !v.starts_with('-') || v == "-" => Ok(it.next().unwrap()),
        _ => Err(format!("missing value for {flag}")),
    }
}

/// Parse a terminal dimension, clamping to ≥1 and falling back to `default` on a
/// non-numeric value (the Bun `Math.max(1, parseInt(...) || default)` parity).
fn parse_dim(s: &str, default: u16) -> u16 {
    let n = s.trim().parse::<u32>().unwrap_or(u32::from(default));
    n.clamp(1, u32::from(u16::MAX)) as u16
}

/// Milliseconds since the Unix epoch for the `session-<ms>` fallback sid.
fn now_ms_u128() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<RunnerOptions, String> {
        parse_args(args.iter().map(|s| (*s).to_string()))
    }

    #[test]
    fn parses_all_flags_and_claude_args() {
        let o = parse(&[
            "--sid",
            "sess-1",
            "--cwd",
            "/work",
            "--socket-path",
            "/run/d.sock",
            "--worktree-path",
            "/wt",
            "--cols",
            "100",
            "--rows",
            "50",
            "--",
            "--permission-mode",
            "bypassPermissions",
        ])
        .unwrap();
        assert_eq!(o.sid, "sess-1");
        assert_eq!(o.cwd, "/work");
        assert_eq!(
            o.socket_path.as_deref(),
            Some(std::path::Path::new("/run/d.sock"))
        );
        assert_eq!(o.worktree_path.as_deref(), Some("/wt"));
        assert_eq!(o.cols, Some(100));
        assert_eq!(o.rows, Some(50));
        assert_eq!(
            o.claude_args,
            vec!["--permission-mode", "bypassPermissions"]
        );
    }

    #[test]
    fn defaults_sid_and_clamps_dims() {
        let o = parse(&["--cwd", "/x", "--cols", "0", "--rows", "notanum"]).unwrap();
        assert!(o.sid.starts_with("session-"));
        assert_eq!(o.cols, Some(1)); // clamped up from 0
        assert_eq!(o.rows, Some(40)); // fallback default on non-numeric
    }

    #[test]
    fn missing_flag_value_errors() {
        assert!(parse(&["--sid"]).is_err());
        // A flag-like value is rejected (a real sid never starts with '-').
        assert!(parse(&["--sid", "--cwd"]).is_err());
    }
}
