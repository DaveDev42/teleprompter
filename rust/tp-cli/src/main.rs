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

mod colors;
mod commands;
mod format;
mod socket;
mod store;
mod util;

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
    /// Daemon & session status.
    Status,
    /// Tail a session's live record stream.
    Logs {
        /// Session ID to tail. Omit to list available sessions.
        sid: Option<String>,
    },
    /// Pairing management.
    Pair {
        #[command(subcommand)]
        action: Option<PairAction>,
    },
    /// Session management.
    Session {
        #[command(subcommand)]
        action: Option<SessionAction>,
    },
    /// Shell completion scripts.
    ///
    /// Emit a ready-to-eval completion script for bash, zsh, or fish.
    /// Usage: `tp completions [bash|zsh|fish]`
    ///
    /// The `install` / `uninstall` sub-actions (write rc files) are not yet
    /// ported; they are routed to the loud-fail path.
    Completions {
        /// Shell to generate completions for, or "install"/"uninstall".
        /// Defaults to "bash" when omitted.
        shell: Option<String>,
    },
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

/// `tp pair <action>`. Only `list` is ported in tranche 1; write actions
/// (new/delete/rename) stay loud-fail until their tranches land.
#[derive(Subcommand)]
enum PairAction {
    /// List registered pairings.
    List,
    /// Create a new pairing (not yet ported).
    New,
    /// Delete a pairing (not yet ported).
    Delete,
    /// Rename a pairing (not yet ported).
    Rename,
}

/// `tp session <action>`. Only `list` is ported in tranche 1.
#[derive(Subcommand)]
enum SessionAction {
    /// List saved sessions.
    List,
    /// Delete a session (not yet ported).
    Delete,
    /// Prune stopped sessions (not yet ported).
    Prune,
    /// Interactive cleanup (not yet ported).
    Cleanup,
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
        Some(Command::Status) => commands::status::run(),
        Some(Command::Session {
            action: Some(SessionAction::List),
        }) => commands::session::list(),
        Some(Command::Pair {
            action: Some(PairAction::List),
        }) => commands::pair::list(),

        // completions — script-emit path is ported; install/uninstall is not.
        Some(Command::Completions { shell }) => {
            let shell_str = shell.as_deref();
            match shell_str {
                Some("install") => not_yet_ported("completions install"),
                Some("uninstall") => not_yet_ported("completions uninstall"),
                other => commands::completions::run(other),
            }
        }

        // Ported subcommands.
        Some(Command::Logs { sid }) => commands::logs::run(sid.as_deref()),
        Some(Command::Doctor) => not_yet_ported("doctor"),
        Some(Command::Upgrade) => not_yet_ported("upgrade"),
        Some(Command::Daemon) => not_yet_ported("daemon"),
        Some(Command::Run) => not_yet_ported("run"),
        Some(Command::Relay) => not_yet_ported("relay"),
        Some(Command::Pair { action }) => not_yet_ported(match action {
            Some(PairAction::New) => "pair new",
            Some(PairAction::Delete) => "pair delete",
            Some(PairAction::Rename) => "pair rename",
            // Bare `tp pair` (no action) is `pair new` in the Bun CLI — a write
            // path, not yet ported.
            None | Some(PairAction::List) => "pair",
        }),
        Some(Command::Session { action }) => not_yet_ported(match action {
            Some(SessionAction::Delete) => "session delete",
            Some(SessionAction::Prune) => "session prune",
            Some(SessionAction::Cleanup) => "session cleanup",
            None | Some(SessionAction::List) => "session",
        }),

        // Bare `tp` with no subcommand: print help and exit. The claude-REPL
        // passthrough that bare `tp` triggers in the Bun CLI is a later tranche.
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
fn not_yet_ported(name: &str) -> ExitCode {
    eprintln!(
        "tp: `{name}` is not yet ported to the native CLI. Use the Bun `tp` for this command."
    );
    ExitCode::FAILURE
}
