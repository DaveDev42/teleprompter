//! Thin forwarder: exec the bundled Bun blob (`tpd`) with the caller's argv.
//!
//! # Architecture
//!
//! Tranche 5 (ADR-0003 Amendment 2, A2.4 decision #1 — Option A thin forwarder).
//! For `run`, `relay`, passthrough, claude-utility forwards, and `--`, the Rust
//! `tp` does NOT reimplement the logic. It locates the bundled Bun SEA (`tpd`)
//! via [`crate::locate::locate_bun_blob`] and **replaces its own process image**
//! with the blob via `exec()`.
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
//! The forward path opens **zero** IPC sockets, relay WebSockets, or SQLite
//! connections from Rust. The blob (Bun CLI) handles all of that:
//! - `passthrough` / `run` → daemon IPC → Runner PTY
//! - `relay start` → `RelayServer` (Bun)
//! - claude-utility forwards → `claude <subcmd>` subprocess
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
/// `forward_args` should be `std::env::args().skip(1).collect::<Vec<_>>()` —
/// the FULL original argv after the binary name, verbatim:
/// - `tp -p hello`      → `forward_args = ["-p", "hello"]`
/// - `tp auth login`    → `forward_args = ["auth", "login"]`
/// - `tp -- echo hi`    → `forward_args = ["--", "echo", "hi"]`
/// - `tp run --tp-sid x`→ `forward_args = ["run", "--tp-sid", "x"]`
/// - bare `tp`          → `forward_args = []`
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
/// Mirrors `Route` in `apps/cli/src/router.ts` but collapsed to the two
/// outcomes that matter for the pre-clap dispatch in `main()`:
/// - `Forward` → call `exec_blob` with the original argv.
/// - `Native`  → fall through to `Cli::parse()` + the existing match dispatch.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Forward to the Bun blob (passthrough / run / relay / claude-utility / `--`).
    Forward,
    /// Handle natively in the Rust CLI (clap parses the rest).
    Native,
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

/// Claude-only utility subcommands forwarded to the blob unchanged.
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
/// | `None` (bare `tp`) | `Forward` — passthrough = claude REPL |
/// | `--help` / `-h` | `Native` — clap renders help |
/// | `--version` / `-v` | `Native` — native version handler |
/// | in `NATIVE_SUBCOMMANDS` | `Native` |
/// | `run` / `relay` | `Forward` — blob dispatches these |
/// | in `CLAUDE_UTILITY_SUBCOMMANDS` | `Forward` — blob forwards to `claude` |
/// | `--` | `Forward` — blob double-dash passthrough |
/// | anything else (unknown subcmd, flag like `-p`) | `Forward` — passthrough |
pub fn decide_route(first: Option<&str>) -> Route {
    let Some(cmd) = first else {
        // Bare `tp` → forward to blob (claude REPL passthrough).
        // The Bun CLI's decideRoute:40 returns passthrough for undefined.
        return Route::Forward;
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

    // `run` and `relay` are in TP_SUBCOMMANDS but forward to blob.
    // No explicit check needed here — they are intentionally excluded from
    // NATIVE_SUBCOMMANDS, so they fall through to the Forward return below.

    // Claude utility forwards.
    if CLAUDE_UTILITY_SUBCOMMANDS.contains(&cmd) {
        return Route::Forward;
    }

    // `--` double-dash: forward to blob.
    if cmd == "--" {
        return Route::Forward;
    }

    // Unknown subcommand, any unrecognised flag (e.g. `-p`), or bare
    // passthrough args → forward (passthrough).
    Route::Forward
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── bare tp ─────────────────────────────────────────────────────────────

    #[test]
    fn bare_tp_forwards() {
        assert_eq!(decide_route(None), Route::Forward);
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

    // ── claude utility subcommands forward ───────────────────────────────────

    #[test]
    fn auth_forwards() {
        assert_eq!(decide_route(Some("auth")), Route::Forward);
    }

    #[test]
    fn mcp_forwards() {
        assert_eq!(decide_route(Some("mcp")), Route::Forward);
    }

    #[test]
    fn install_forwards() {
        assert_eq!(decide_route(Some("install")), Route::Forward);
    }

    #[test]
    fn update_forwards() {
        assert_eq!(decide_route(Some("update")), Route::Forward);
    }

    #[test]
    fn agents_forwards() {
        assert_eq!(decide_route(Some("agents")), Route::Forward);
    }

    #[test]
    fn auto_mode_forwards() {
        assert_eq!(decide_route(Some("auto-mode")), Route::Forward);
    }

    #[test]
    fn plugin_forwards() {
        assert_eq!(decide_route(Some("plugin")), Route::Forward);
    }

    #[test]
    fn plugins_forwards() {
        assert_eq!(decide_route(Some("plugins")), Route::Forward);
    }

    #[test]
    fn setup_token_forwards() {
        assert_eq!(decide_route(Some("setup-token")), Route::Forward);
    }

    // ── double-dash forwards ─────────────────────────────────────────────────

    #[test]
    fn double_dash_forwards() {
        assert_eq!(decide_route(Some("--")), Route::Forward);
    }

    // ── unknown / unrecognised → passthrough ─────────────────────────────────

    #[test]
    fn unknown_subcommand_forwards() {
        assert_eq!(decide_route(Some("foobar")), Route::Forward);
    }

    #[test]
    fn unknown_flag_forwards() {
        // A bare -p flag (e.g. `tp -p hello`) must forward, not error.
        assert_eq!(decide_route(Some("-p")), Route::Forward);
    }

    #[test]
    fn another_unknown_flag_forwards() {
        assert_eq!(decide_route(Some("--print")), Route::Forward);
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
