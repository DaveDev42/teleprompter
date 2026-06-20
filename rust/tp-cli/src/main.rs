//! `tp` — native Rust CLI (ADR-0003 full-CLI port).
//!
//! THIN entry point: parse the subcommand tree with clap, dispatch to a handler
//! module, map the handler's result to a process exit code. The command tree
//! mirrors the Bun CLI's `TP_SUBCOMMANDS` (`apps/cli/src/router.ts`) so the two
//! binaries are drop-in compatible during the port.
//!
//! Port status (tranche 3b): `version`, `status`, `session list`, `session
//! delete`, `session prune`, `session cleanup`, `logs`, `completions` (emit),
//! `pair list`, `pair delete`, `pair rename`, and `pair new` are implemented.
//! Every other subcommand is declared (so `--help` is complete and the dispatch
//! seam exists) but returns a clear "not yet ported" message.
//!
//! Architecture invariant (unchanged): this CLI talks ONLY to the daemon over
//! its IPC unix socket. It never opens a relay WebSocket — pairing/relay flow is
//! daemon-only (CLI -> daemon IPC -> relay).

use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod codec;
mod colors;
mod commands;
mod config_dir;
mod format;
mod ipc_client;
mod ipc_session;
mod osc52;
mod pair_lock;
mod qr;
mod socket;
mod store;
mod tui;
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

/// `tp pair <action>`. `list`, `delete`, `rename`, and `new` are ported.
#[derive(Subcommand)]
enum PairAction {
    /// List registered pairings.
    List,
    /// Create a new pairing — generate a QR and BLOCK until the app scans it.
    ///
    /// Usage: tp pair new [--relay URL] [--daemon-id ID] [--label <name>]
    New {
        /// Arguments forwarded to the new-pairing handler.
        /// Accepts: --relay/--daemon-id/--label (+ values) and -h/--help.
        /// Passed through as raw strings so the handler owns argument ordering.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Delete a pairing (prefix match; requires daemon running).
    ///
    /// Usage: tp pair delete <daemon-id> [--yes|-y]
    Delete {
        /// Arguments forwarded to the delete handler.
        /// Accepts: the daemon-id/label prefix, and optionally --yes/-y.
        /// Passed through as raw strings so the handler owns argument ordering.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Rename a pairing (prefix match; requires daemon running).
    ///
    /// Usage: tp pair rename <daemon-id-prefix> <label...>
    Rename {
        /// Arguments forwarded to the rename handler.
        /// First positional = the daemon-id/label prefix; rest = the new label
        /// words (joined with spaces). Passed through as raw strings so the
        /// handler owns argument ordering and label assembly.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

/// `tp session <action>`. `list`, `delete`, and `prune` are ported in tranche 2.
#[derive(Subcommand)]
enum SessionAction {
    /// List saved sessions.
    List,
    /// Delete a session (prefix match allowed).
    Delete {
        /// Session ID or prefix to delete.
        sid: String,
        /// Skip confirmation prompt.
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },
    /// Non-interactive bulk-delete stopped sessions.
    ///
    /// Usage: tp session prune [--older-than <Nd|Nh|Nm|Ns>] [--all] [--running] [--dry-run] [-y]
    Prune {
        /// Age cutoff; sessions older than this are selected (default: 7d).
        /// Format: <N><s|m|h|d>, e.g. 7d / 24h / 30m / 45s.
        #[arg(long = "older-than", default_value = "7d")]
        older_than: String,
        /// Select ALL stopped sessions (overrides --older-than).
        #[arg(long = "all")]
        all: bool,
        /// Also kill & delete running sessions (dangerous).
        #[arg(long = "running")]
        running: bool,
        /// Print selection without deleting (read-only; never prompts).
        #[arg(long = "dry-run")]
        dry_run: bool,
        /// Skip confirmation prompt.
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },
    /// Interactive multi-select bulk delete of stopped sessions.
    ///
    /// Usage: tp session cleanup [-y] [--all]
    Cleanup {
        /// Skip the confirmation prompt (delete immediately after selection).
        #[arg(short = 'y', long = "yes")]
        yes: bool,
        /// Pre-select all stopped sessions (start with all checked).
        #[arg(long = "all")]
        all: bool,
    },
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
        Some(Command::Session {
            action: Some(SessionAction::Delete { sid, yes }),
        }) => commands::session::delete(&sid, yes),
        Some(Command::Session {
            action:
                Some(SessionAction::Prune {
                    older_than,
                    all,
                    running,
                    dry_run,
                    yes,
                }),
        }) => commands::session::prune(commands::session::PruneOpts {
            older_than_raw: older_than,
            all,
            running,
            dry_run,
            yes,
        }),
        Some(Command::Pair {
            action: Some(PairAction::List),
        }) => commands::pair::list(),
        Some(Command::Pair {
            action: Some(PairAction::New { args }),
        }) => commands::pair::new(&args),
        Some(Command::Pair {
            action: Some(PairAction::Delete { args }),
        }) => commands::pair::delete(&args),
        Some(Command::Pair {
            action: Some(PairAction::Rename { args }),
        }) => commands::pair::rename(&args),

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
        // Bare `tp pair` (no action) is an alias for `tp pair new` in the Bun
        // CLI (pair.ts:59-62). List/New/Delete/Rename are all dispatched above.
        Some(Command::Pair { action: None }) => commands::pair::new(&[]),
        Some(Command::Session {
            action: Some(SessionAction::Cleanup { yes, all }),
        }) => commands::session::cleanup(yes, all),
        Some(Command::Session { action }) => not_yet_ported(match action {
            // List, Delete, Prune, and Cleanup are dispatched above; bare
            // `session` with no action is not yet ported.
            None
            | Some(SessionAction::List)
            | Some(SessionAction::Delete { .. })
            | Some(SessionAction::Prune { .. })
            | Some(SessionAction::Cleanup { .. }) => "session",
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
