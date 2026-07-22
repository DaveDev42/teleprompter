//! Pre-clap router: classify the first CLI arg into a dispatch route.
//!
//! # Architecture
//!
//! Historically (tranche 5, ADR-0003 Amendment 2) this module was the "thin
//! forwarder" that exec'd the bundled Bun blob (`tpd`) for not-yet-ported
//! routes. Every route has since been de-trampolined to native Rust
//! (`commands::passthrough` task #17 PR-4, `commands::forward_claude` PR-6,
//! `commands::relay` #25, `commands::run` task #8), and PR6 of the #5 zero-Bun
//! cascade deleted the blob itself together with `Route::Forward`/`exec_blob`/
//! `locate_bun_blob`. What remains here is the routing table ([`decide_route`]
//! and [`Route`]), consumed by `main()` BEFORE clap parses so unrecognised
//! subcommands/flags reach the passthrough path instead of a clap error.

/// Classification returned by [`decide_route`].
///
/// Mirrors `Route` from the retired Bun CLI's `apps/cli/src/router.ts`
/// (behavioral reference), collapsed to the outcomes that matter for the
/// pre-clap dispatch in `main()`:
/// - `Native`       → fall through to `Cli::parse()` + the existing match dispatch.
/// - `Passthrough`  → the interactive claude REPL path (bare `tp`, `tp <claude
///   args>`). Native terminal-proxy (`commands::passthrough::run`, task #17 PR-4).
/// - `ForwardClaude`→ direct `claude` exec, daemon-bypass (claude-utility
///   subcommands + `tp -- <args>`). Native (`commands::forward_claude::run`,
///   task #17 PR-6).
/// - `RelayNative`  → native `tp-relay` exec (`tp relay …`)
///   (`commands::relay::run`, task #17 #25).
/// - `RunNative`    → native `tp-runner` exec (`tp run …`)
///   (`commands::run::run`, task #8).
///
/// Note `--` is `ForwardClaude`, NOT `Passthrough`: `tp -- <args>` forwards
/// **directly** to claude (daemon-bypass, the same handler as the utility
/// forwards) — it does not go through the daemon+runner pipeline the way
/// bare-`tp` passthrough does.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Handle natively in the Rust CLI (clap parses the rest).
    Native,
    /// Interactive claude passthrough (bare `tp`, `tp <claude args>`) — native
    /// terminal-proxy (`commands::passthrough::run`, task #17 PR-4).
    Passthrough,
    /// Direct `claude` exec, daemon-bypass (claude-utility subcommands +
    /// `tp -- <args>`) — native (`commands::forward_claude::run`, task #17 PR-6).
    ForwardClaude,
    /// Native `tp-relay` exec (`tp relay …`) — native (`commands::relay::run`,
    /// task #17 #25). No longer execs the blob.
    RelayNative,
    /// Native `tp-runner` exec (`tp run …`) — native (`commands::run::run`,
    /// task #8). De-trampolined from the Bun blob; forwards the caller's argv
    /// verbatim to the shipped `tp-runner`.
    RunNative,
}

/// Known `tp` subcommands that the Rust CLI handles natively **via clap** (the
/// Cli::parse path). This list drives the `Route::Native` classification.
///
/// Mirrors `TP_SUBCOMMANDS` in `apps/cli/src/router.ts:19-31` MINUS `run` and
/// `relay`: both are handled by dedicated native exec paths — `run` via
/// `Route::RunNative` → `commands::run::run` (task #8), `relay` via
/// `Route::RelayNative` → `commands::relay::run` (#25) — rather than clap, so
/// neither belongs in this clap-parsed set.
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
/// | `relay` | `RelayNative` — native `tp-relay` exec |
/// | `run` | `RunNative` — native `tp-runner` exec (task #8) |
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

    // `relay` → native Rust `tp-relay` (task #17 #25). `tp relay start` execs the
    // shipped `tp-relay` binary directly (via `commands::relay::run` →
    // `locate_tp_relay`); it no longer trampolines through the Bun blob.
    if cmd == "relay" {
        return Route::RelayNative;
    }

    // `run` → native Rust `tp-runner` (task #8). `tp run …` execs the shipped
    // `tp-runner` binary directly (via `commands::run::run` → `locate_tp_runner`,
    // same argv contract the daemon spawns it with); it no longer trampolines
    // through the Bun blob. It must be `RunNative`, NOT the `Passthrough` catch-
    // all below (the catch-all changed Forward→Passthrough in task #17 PR-2).
    if cmd == "run" {
        return Route::RunNative;
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

    // ── run + relay are native (task #8 / #25) ───────────────────────────────

    #[test]
    fn run_is_native() {
        // task #8: run no longer forwards to the blob — it execs native
        // tp-runner (the last route to leave the Bun blob).
        assert_eq!(decide_route(Some("run")), Route::RunNative);
    }

    #[test]
    fn relay_is_native() {
        // #25: relay no longer forwards to the blob — it execs native tp-relay.
        assert_eq!(decide_route(Some("relay")), Route::RelayNative);
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
}
