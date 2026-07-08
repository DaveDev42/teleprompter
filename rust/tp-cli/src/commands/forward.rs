//! Thin forwarder: exec the bundled Bun blob (`tpd`) with the caller's argv.
//!
//! # Architecture
//!
//! Tranche 5 (ADR-0003 Amendment 2, A2.4 decision #1 — Option A thin forwarder).
//! For `run` and `relay` the Rust `tp` does NOT reimplement the logic: it locates
//! the bundled Bun SEA (`tpd`) via [`crate::locate::locate_bun_blob`] and
//! **replaces its own process image** with the blob via `exec()`. (De-trampolining
//! these two is tracked by task #8 for the runner and #25 for the relay.)
//!
//! Passthrough (bare `tp` / `tp <claude args>`), the claude-utility forwards, and
//! `tp -- <args>` are **no longer** blob forwards — they were de-trampolined to
//! native Rust handlers (`commands::passthrough` in task #17 PR-4,
//! `commands::forward_claude` in PR-6). `decide_route` routes them to
//! `Route::Passthrough` / `Route::ForwardClaude`, not `Route::Forward`.
//!
//! # Why `exec()` instead of `.status()`
//!
//! `CommandExt::exec()` is a **safe fn** (returns `io::Error`; never returns on
//! success), so it satisfies `unsafe_code = "forbid"`. It gives true
//! process-image replacement: the Bun blob inherits the controlling TTY, all
//! signals (SIGINT / SIGWINCH for PTY resize), stdin/stdout/stderr, and its exit
//! code becomes `tp`'s exit code. This is better than `.status()` for interactive
//! `claude` passthrough sessions: there is no Rust parent process left in the
//! signal path.
//!
//! # Architecture invariants (A2.4 #2 posture preserved)
//!
//! The blob forward path (now only `run` / `relay`) opens **zero** IPC sockets,
//! relay WebSockets, or SQLite connections from Rust. The blob (Bun CLI) handles:
//! - `run` → daemon IPC → Runner PTY
//! - `relay start` → `RelayServer` (Bun)
//!
//! # Windows note
//!
//! `CommandExt::exec()` is POSIX-only (`#[cfg(unix)]`). `tp` is documented as
//! POSIX-only (CLAUDE.md "Windows is unsupported natively"; `index.ts:8-14`
//! mirrors this). The `#[cfg(not(unix))]` stub below provides a compile-time
//! error rather than a silent runtime failure on Windows.

use std::process::ExitCode;

/// Exec the Bun blob with the given args (original argv after the binary name).
///
/// On success this function **never returns** — the blob takes over the process
/// image entirely, inheriting stdio, the TTY, and signals.
///
/// On failure (blob not found or exec syscall error) it prints a message to
/// stderr and returns `ExitCode::FAILURE`.
///
/// `forward_args` is the FULL original argv after the binary name, verbatim.
/// After PR-4/PR-6 the only routes that still reach `exec_blob` are `run` and
/// `relay` (`Route::Forward`):
/// - `tp run --tp-sid x` → `forward_args = ["run", "--tp-sid", "x"]`
/// - `tp relay start`    → `forward_args = ["relay", "start"]`
///
/// (`tp -p hello` / bare `tp` are now `Route::Passthrough`; `tp auth login` /
/// `tp -- echo hi` are now `Route::ForwardClaude` — none reach `exec_blob`.)
#[cfg(unix)]
pub fn exec_blob(forward_args: &[String]) -> ExitCode {
    use std::os::unix::process::CommandExt;

    let blob = match crate::locate::locate_bun_blob() {
        Ok(p) => p,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    };

    // exec() replaces the process image. The Bun blob inherits stdio + TTY.
    // Returns only on error (exec syscall failed — e.g. EACCES, ENOEXEC).
    let err = std::process::Command::new(&blob).args(forward_args).exec();
    eprintln!("tp: failed to exec {}: {err}", blob.display());
    ExitCode::FAILURE
}

/// Stub for non-Unix targets (tp is POSIX-only; see module doc).
#[cfg(not(unix))]
pub fn exec_blob(_forward_args: &[String]) -> ExitCode {
    eprintln!(
        "tp: passthrough and run/relay forwarding require a POSIX system. \
         tp does not support native Windows — run inside WSL (Ubuntu/Debian) \
         with the Linux build."
    );
    ExitCode::FAILURE
}

/// Classification returned by [`decide_route`].
///
/// Mirrors `Route` in `apps/cli/src/router.ts`, collapsed to the outcomes that
/// matter for the pre-clap dispatch in `main()`:
/// - `Forward`      → call `exec_blob` with the original argv (`run` / `relay` —
///   the remaining blob-dispatched routes; de-trampolined by tasks #8 / #25).
/// - `Native`       → fall through to `Cli::parse()` + the existing match dispatch.
/// - `Passthrough`  → the interactive claude REPL path (bare `tp`, `tp <claude
///   args>`). Native terminal-proxy (`commands::passthrough::run`, task #17 PR-4).
/// - `ForwardClaude`→ direct `claude` exec, daemon-bypass (claude-utility
///   subcommands + `tp -- <args>`). Native (`commands::forward_claude::run`,
///   task #17 PR-6) — no longer execs the blob.
///
/// Note `--` is `ForwardClaude`, NOT `Passthrough`: `tp -- <args>` forwards
/// **directly** to claude (daemon-bypass, the same handler as the utility
/// forwards) — it does not go through the daemon+runner pipeline the way
/// bare-`tp` passthrough does.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Forward to the Bun blob (`run` / `relay` — the last blob-dispatched
    /// routes, pending tasks #8 / #25).
    Forward,
    /// Handle natively in the Rust CLI (clap parses the rest).
    Native,
    /// Interactive claude passthrough (bare `tp`, `tp <claude args>`) — native
    /// terminal-proxy (`commands::passthrough::run`, task #17 PR-4).
    Passthrough,
    /// Direct `claude` exec, daemon-bypass (claude-utility subcommands +
    /// `tp -- <args>`) — native (`commands::forward_claude::run`, task #17 PR-6).
    ForwardClaude,
}

/// Known `tp` subcommands that the Rust CLI handles natively (clap-parsed).
///
/// Mirrors `TP_SUBCOMMANDS` in `apps/cli/src/router.ts:19-31` MINUS `run` and
/// `relay` — those two are in the Bun set but the Rust thin-forwarder execs the
/// blob for them (the blob's `index.ts` dispatches `run`→`runCommand`,
/// `relay`→`relayCommand`).
const NATIVE_SUBCOMMANDS: &[&str] = &[
    "daemon",
    "pair",
    "session",
    "status",
    "logs",
    "doctor",
    "upgrade",
    "completions",
    "version",
];

/// Claude-only utility subcommands — routed to `Route::ForwardClaude` (native
/// `claude` exec, task #17 PR-6), no longer the blob.
///
/// Mirrors `CLAUDE_UTILITY_SUBCOMMANDS` in
/// `apps/cli/src/claude-subcommands.ts:5-15`.
const CLAUDE_UTILITY_SUBCOMMANDS: &[&str] = &[
    "auth",
    "mcp",
    "install",
    "update",
    "agents",
    "auto-mode",
    "plugin",
    "plugins",
    "setup-token",
];

/// Classify the first CLI arg (the token after the binary name) into a routing
/// decision.
///
/// This is a Rust port of `decideRoute` in `apps/cli/src/router.ts:39-49`.
/// It runs on raw `std::env::args()` BEFORE `Cli::parse()` so that clap never
/// sees unrecognized subcommands or flags.
///
/// Decision table (first match wins):
///
/// | `first` | Route |
/// |---|---|
/// | `None` (bare `tp`) | `Passthrough` — claude REPL |
/// | `--help` / `-h` | `Native` — clap renders help |
/// | `--version` / `-v` | `Native` — native version handler |
/// | in `NATIVE_SUBCOMMANDS` | `Native` |
/// | `run` / `relay` | `Forward` — blob dispatches these |
/// | in `CLAUDE_UTILITY_SUBCOMMANDS` | `ForwardClaude` — native `claude` exec |
/// | `--` | `ForwardClaude` — native `claude` direct-forward (daemon-bypass) |
/// | anything else (unknown subcmd, flag like `-p`) | `Passthrough` |
pub fn decide_route(first: Option<&str>) -> Route {
    let Some(cmd) = first else {
        // Bare `tp` → interactive claude REPL passthrough.
        // The Bun CLI's decideRoute:40 returns passthrough for undefined.
        return Route::Passthrough;
    };

    // --help / -h: native clap help.
    if cmd == "--help" || cmd == "-h" {
        return Route::Native;
    }

    // --version / -v: native version handler.
    if cmd == "--version" || cmd == "-v" {
        return Route::Native;
    }

    // Native subcommands (TP_SUBCOMMANDS minus run/relay).
    if NATIVE_SUBCOMMANDS.contains(&cmd) {
        return Route::Native;
    }

    // `run` and `relay` are in TP_SUBCOMMANDS but forward to the blob (its
    // `index.ts` dispatches `run`→`runCommand`, `relay`→`relayCommand`). They
    // must be `Forward`, NOT the `Passthrough` catch-all below — an explicit
    // check is now required because the catch-all changed from `Forward` to
    // `Passthrough` (task #17 PR-2).
    if cmd == "run" || cmd == "relay" {
        return Route::Forward;
    }

    // Claude utility forwards → native `claude <subcmd>` exec (task #17 PR-6).
    // No longer execs the blob — these never needed the daemon or the pipeline.
    if CLAUDE_UTILITY_SUBCOMMANDS.contains(&cmd) {
        return Route::ForwardClaude;
    }

    // `--` double-dash: direct claude forward, daemon-bypass — the same native
    // `claude` exec as the utility forwards (NOT the daemon+runner passthrough
    // pipeline), task #17 PR-6.
    if cmd == "--" {
        return Route::ForwardClaude;
    }

    // Unknown subcommand, any unrecognised flag (e.g. `-p`), or bare
    // passthrough args → interactive claude passthrough.
    Route::Passthrough
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── bare tp ─────────────────────────────────────────────────────────────

    #[test]
    fn bare_tp_is_passthrough() {
        assert_eq!(decide_route(None), Route::Passthrough);
    }

    // ── help / version flags stay native ────────────────────────────────────

    #[test]
    fn help_long_native() {
        assert_eq!(decide_route(Some("--help")), Route::Native);
    }

    #[test]
    fn help_short_native() {
        assert_eq!(decide_route(Some("-h")), Route::Native);
    }

    #[test]
    fn version_long_native() {
        assert_eq!(decide_route(Some("--version")), Route::Native);
    }

    #[test]
    fn version_short_native() {
        assert_eq!(decide_route(Some("-v")), Route::Native);
    }

    // ── native subcommands ───────────────────────────────────────────────────

    #[test]
    fn daemon_native() {
        assert_eq!(decide_route(Some("daemon")), Route::Native);
    }

    #[test]
    fn pair_native() {
        assert_eq!(decide_route(Some("pair")), Route::Native);
    }

    #[test]
    fn session_native() {
        assert_eq!(decide_route(Some("session")), Route::Native);
    }

    #[test]
    fn status_native() {
        assert_eq!(decide_route(Some("status")), Route::Native);
    }

    #[test]
    fn logs_native() {
        assert_eq!(decide_route(Some("logs")), Route::Native);
    }

    #[test]
    fn doctor_native() {
        assert_eq!(decide_route(Some("doctor")), Route::Native);
    }

    #[test]
    fn upgrade_native() {
        assert_eq!(decide_route(Some("upgrade")), Route::Native);
    }

    #[test]
    fn completions_native() {
        assert_eq!(decide_route(Some("completions")), Route::Native);
    }

    #[test]
    fn version_subcmd_native() {
        assert_eq!(decide_route(Some("version")), Route::Native);
    }

    // ── run / relay forward to blob ──────────────────────────────────────────

    #[test]
    fn run_forwards() {
        assert_eq!(decide_route(Some("run")), Route::Forward);
    }

    #[test]
    fn relay_forwards() {
        assert_eq!(decide_route(Some("relay")), Route::Forward);
    }

    // ── claude utility subcommands → native claude exec (PR-6) ───────────────

    #[test]
    fn auth_forwards() {
        assert_eq!(decide_route(Some("auth")), Route::ForwardClaude);
    }

    #[test]
    fn mcp_forwards() {
        assert_eq!(decide_route(Some("mcp")), Route::ForwardClaude);
    }

    #[test]
    fn install_forwards() {
        assert_eq!(decide_route(Some("install")), Route::ForwardClaude);
    }

    #[test]
    fn update_forwards() {
        assert_eq!(decide_route(Some("update")), Route::ForwardClaude);
    }

    #[test]
    fn agents_forwards() {
        assert_eq!(decide_route(Some("agents")), Route::ForwardClaude);
    }

    #[test]
    fn auto_mode_forwards() {
        assert_eq!(decide_route(Some("auto-mode")), Route::ForwardClaude);
    }

    #[test]
    fn plugin_forwards() {
        assert_eq!(decide_route(Some("plugin")), Route::ForwardClaude);
    }

    #[test]
    fn plugins_forwards() {
        assert_eq!(decide_route(Some("plugins")), Route::ForwardClaude);
    }

    #[test]
    fn setup_token_forwards() {
        assert_eq!(decide_route(Some("setup-token")), Route::ForwardClaude);
    }

    // ── double-dash → native claude exec (PR-6) ──────────────────────────────

    #[test]
    fn double_dash_forwards() {
        assert_eq!(decide_route(Some("--")), Route::ForwardClaude);
    }

    // ── unknown / unrecognised → passthrough ─────────────────────────────────

    #[test]
    fn unknown_subcommand_is_passthrough() {
        assert_eq!(decide_route(Some("foobar")), Route::Passthrough);
    }

    #[test]
    fn unknown_flag_is_passthrough() {
        // A bare -p flag (e.g. `tp -p hello`) is passthrough, not an error.
        assert_eq!(decide_route(Some("-p")), Route::Passthrough);
    }

    #[test]
    fn another_unknown_flag_is_passthrough() {
        assert_eq!(decide_route(Some("--print")), Route::Passthrough);
    }

    // ── `--` is ForwardClaude (direct claude forward, NOT passthrough pipeline) ─

    #[test]
    fn double_dash_stays_forward_not_passthrough() {
        // `tp -- <args>` forwards directly to claude (daemon-bypass); it must
        // NOT be reclassified as Passthrough (the daemon+runner pipeline).
        assert_eq!(decide_route(Some("--")), Route::ForwardClaude);
    }

    // ── exec_blob error-path (no exec, just locate failure) ──────────────────
    //
    // We cannot test the exec() path in a unit test (it would replace the test
    // process). Instead, verify that exec_blob returns FAILURE without panicking
    // when TP_BUN_BLOB points to a nonexistent path.

    #[test]
    fn exec_blob_returns_failure_when_blob_missing() {
        // Set TP_BUN_BLOB to a path that does not exist so locate_bun_blob
        // returns an error before we reach exec().
        // SAFETY: env vars are process-global; parallel tests could race.
        // We rely on the test runner isolating this test (or accept the rare
        // collision — the test only asserts ExitCode::FAILURE, which is
        // idempotent).
        std::env::set_var("TP_BUN_BLOB", "/nonexistent/fake-tpd-for-test");
        let code = exec_blob(&[]);
        // Restore to avoid leaking into sibling tests.
        std::env::remove_var("TP_BUN_BLOB");
        assert_eq!(code, ExitCode::FAILURE);
    }
}
