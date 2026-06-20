//! `tp` — native Rust CLI (ADR-0003 full-CLI port).
//!
//! THIN entry point: parse the subcommand tree with clap, dispatch to a handler
//! module, map the handler's result to a process exit code. The command tree
//! mirrors the Bun CLI's `TP_SUBCOMMANDS` (`apps/cli/src/router.ts`) so the two
//! binaries are drop-in compatible during the port.
//!
//! Port status (this is Step 0 + Step 1): only `version` is implemented. Every
//! other subcommand is declared (so `--help` is complete and the dispatch seam
//! exists) but returns a clear "not yet ported" message. The coexistence model
//! for unported commands (exec-forward to the Bun binary vs hard error) is a
//! pending decision — until it lands, unported commands fail loudly rather than
//! silently doing nothing.
//!
//! Architecture invariant (unchanged): this CLI talks ONLY to the daemon over
//! its IPC unix socket. It never opens a relay WebSocket — pairing/relay flow is
//! daemon-only (CLI -> daemon IPC -> relay).

use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod commands;

// Top-level `tp` CLI.
//
// `disable_version_flag` because we render `--version` / `-v` ourselves: the
// Bun CLI prints BOTH the tp version and claude's version, but clap's built-in
// `--version` would only print tp's. Bare `tp` with no args is the claude REPL
// passthrough in the Bun CLI (a later tranche); for now it prints help.
//
// NOTE: the doc comment is deliberately a plain `//` block, not `///` — clap
// surfaces a struct's doc comment as the user-facing `about` text, so an
// implementation note here would leak into `tp --help`. The `about` is set
// explicitly below instead.
#[derive(Parser)]
#[command(
    name = "tp",
    about = "Remote Claude Code session controller",
    disable_version_flag = true
)]
struct Cli {
    /// Print the tp version (and claude's), then exit. Mirrors `tp version`.
    #[arg(short = 'v', long = "version", global = true)]
    version: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

/// The subcommand tree. Order/names mirror `TP_SUBCOMMANDS` in
/// `apps/cli/src/router.ts`. Only `Version` is wired to a real handler at this
/// step; the rest are placeholders that report "not yet ported".
#[derive(Subcommand)]
enum Command {
    /// Print tp + claude versions.
    Version,
    /// Daemon status & session list (not yet ported).
    Status,
    /// Tail a session's live output (not yet ported).
    Logs,
    /// Pairing management (not yet ported).
    Pair,
    /// Session management (not yet ported).
    Session,
    /// Shell completion scripts (not yet ported).
    Completions,
    /// Environment diagnostics (not yet ported).
    Doctor,
    /// Upgrade the tp binary (not yet ported).
    Upgrade,
    /// Daemon lifecycle management (not yet ported).
    Daemon,
    /// Run claude through the tp pipeline (not yet ported).
    Run,
    /// Relay server (not yet ported).
    Relay,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    // The bare `--version` / `-v` flag and the `version` subcommand both route
    // to the same handler (Bun CLI: index.ts dual dispatch).
    if cli.version {
        return commands::version::run();
    }

    match cli.command {
        Some(Command::Version) => commands::version::run(),
        Some(other) => not_yet_ported(&other),
        // Bare `tp` with no subcommand: print help and exit non-zero (clap's
        // convention for "no command given"). The claude-REPL passthrough that
        // bare `tp` triggers in the Bun CLI is a later tranche.
        None => {
            use clap::CommandFactory;
            let mut cmd = Cli::command();
            let _ = cmd.print_help();
            println!();
            ExitCode::SUCCESS
        }
    }
}

/// Report a not-yet-ported subcommand. Until the coexistence decision lands
/// (exec-forward to the Bun binary vs hard error), fail loudly so a user never
/// thinks a write command silently succeeded.
fn not_yet_ported(command: &Command) -> ExitCode {
    let name = match command {
        Command::Version => "version",
        Command::Status => "status",
        Command::Logs => "logs",
        Command::Pair => "pair",
        Command::Session => "session",
        Command::Completions => "completions",
        Command::Doctor => "doctor",
        Command::Upgrade => "upgrade",
        Command::Daemon => "daemon",
        Command::Run => "run",
        Command::Relay => "relay",
    };
    eprintln!(
        "tp: `{name}` is not yet ported to the native CLI. Use the Bun `tp` for this command."
    );
    ExitCode::FAILURE
}
