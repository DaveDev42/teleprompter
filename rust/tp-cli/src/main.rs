//! `tp` — native Rust CLI (ADR-0003 full-CLI port).
//!
//! THIN entry point: classify the first arg via `decide_route` BEFORE clap
//! parses, exec the Bun blob for forward routes, or fall through to the clap
//! dispatch for native subcommands. The command tree mirrors the Bun CLI's
//! `TP_SUBCOMMANDS` (`apps/cli/src/router.ts`) so the two binaries are
//! drop-in compatible during the port.
//!
//! Port status (tranche 5): `version`, `status`, `session list`, `session
//! delete`, `session prune`, `session cleanup`, `logs`, `completions` (emit),
//! `pair list`, `pair delete`, `pair rename`, `pair new`, `doctor`,
//! `daemon stop`, `daemon status`, `daemon install`, `daemon uninstall`,
//! `daemon start`, and `upgrade` are implemented natively. `run`, `relay`,
//! passthrough, claude-utility forwards, and `--` are forwarded to the Bun
//! blob (`tpd`) via pre-clap dispatch + `exec()`. Bare `tp` now forwards to
//! the blob (claude REPL passthrough); `tp --help`/`tp -h` is still native.
//!
//! # Pre-clap dispatch (tranche 5 key change)
//!
//! clap rejects unrecognised subcommands and flags, so passthrough args like
//! `tp -p hello` or `tp foobar` would crash before reaching any handler.
//! Solution: `decide_route(first_arg)` runs on raw `std::env::args()` FIRST.
//! If the route is Forward, we `exec_blob` and never return. Only if the route
//! is Native do we call `Cli::parse()`.
//!
//! Architecture invariant (unchanged): this CLI talks ONLY to the daemon over
//! its IPC unix socket. It never opens a relay WebSocket — pairing/relay flow
//! is daemon-only (CLI -> daemon IPC -> relay).

use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod codec;
mod colors;
mod commands;
mod config_dir;
mod format;
mod ipc_client;
mod ipc_session;
mod locate;
mod osc52;
mod pair_lock;
mod qr;
mod service_darwin;
mod service_linux;
mod socket;
mod store;
mod tui;
mod util;

// Top-level `tp` CLI.
//
// `disable_version_flag` because we render `--version` / `-v` ourselves: the
// Bun CLI prints BOTH the tp version and claude's version, but clap's built-in
// `--version` would only print tp's. `--help`/`-h` are handled by the
// pre-clap dispatch (decide_route returns Native) so clap's built-in help
// still fires correctly.
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
/// `apps/cli/src/router.ts`. All subcommands are wired to real handlers.
/// `Run` and `Relay` are declared here so `tp --help` lists them, but they
/// are intercepted by the pre-clap dispatch and never reach these match arms
/// in normal operation (the match arms below forward to exec_blob as a
/// belt-and-suspenders measure).
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
    ///
    /// Usage:
    ///   `tp completions [bash|zsh|fish]`           — emit script to stdout
    ///   `tp completions install [shell] [flags]`   — write rc / fish file
    ///   `tp completions uninstall [shell] [flags]` — remove rc block / fish file
    Completions {
        /// Shell or sub-action. One of: bash, zsh, fish, install, uninstall.
        /// Defaults to "bash" when omitted.
        shell: Option<String>,

        /// Remaining args forwarded verbatim to the install/uninstall handler
        /// (shell positional + --force / --dry-run / --help).
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Environment diagnostics.
    Doctor,
    /// Upgrade the tp binary and run `claude update`.
    ///
    /// Downloads the latest release from GitHub, verifies the SHA-256 checksum,
    /// replaces the running binary, and restarts the daemon service if managed
    /// by launchd (macOS) or systemd (Linux). Always exits 0 — errors are
    /// printed, not propagated.
    Upgrade,
    /// Daemon lifecycle management.
    ///
    /// Subcommands: start | stop | status | install | uninstall
    Daemon {
        #[command(subcommand)]
        action: Option<DaemonAction>,
    },
    /// Run claude through the tp pipeline (forwarded to tpd blob).
    ///
    /// Note: `tp run` is intercepted by the pre-clap dispatch and forwarded to
    /// the Bun blob before clap parses. This declaration exists so `tp --help`
    /// lists the subcommand. The match arm below is a belt-and-suspenders
    /// fallback (it would fire only if a future refactor bypasses decide_route).
    Run,
    /// Relay server (forwarded to tpd blob).
    ///
    /// Note: `tp relay` is intercepted by the pre-clap dispatch and forwarded to
    /// the Bun blob before clap parses. This declaration exists so `tp --help`
    /// lists the subcommand. The match arm below is a belt-and-suspenders
    /// fallback.
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

/// `tp daemon <action>`. `stop`, `status`, `install`, `uninstall`, and `start`
/// are ported (tranche 4d).
#[derive(Subcommand)]
enum DaemonAction {
    /// Start the daemon in the foreground (Bun trampoline).
    Start {
        /// All arguments forwarded verbatim to `tpd daemon start`.
        /// Accepts: --watch, --repo-root, --prune-ttl, --no-prune, --verbose,
        /// --quiet, --spawn, --sid, --cwd, --worktree-path, and any future flags.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Stop the running daemon.
    Stop,
    /// Show OS service registration + daemon running state.
    Status,
    /// Register as an OS service (launchd/systemd).
    Install,
    /// Remove the OS service registration.
    Uninstall,
}

fn main() -> ExitCode {
    // ── Pre-clap dispatch (tranche 5) ─────────────────────────────────────
    //
    // clap rejects unrecognised subcommands and flags with a hard error.
    // Passthrough args (`tp -p hello`, `tp foobar`, `tp -- echo hi`) and
    // claude-utility forwards (`tp auth login`) would all crash before
    // reaching a handler. We classify the first arg BEFORE clap parses.
    //
    // The full original argv after the binary name is passed verbatim to the
    // blob: `tp auth login` → exec `tpd auth login`; `tp -p x` → `tpd -p x`.
    let args: Vec<String> = std::env::args().collect();
    let first = args.get(1).map(String::as_str);

    match commands::forward::decide_route(first) {
        commands::forward::Route::Forward => {
            // exec_blob never returns on success — the blob takes over.
            return commands::forward::exec_blob(&args[1..]);
        }
        commands::forward::Route::Native => {
            // Fall through to Cli::parse() below.
        }
    }

    // ── Native clap dispatch ───────────────────────────────────────────────
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

        // completions — script-emit + install/uninstall all ported.
        Some(Command::Completions { shell, args }) => {
            let shell_str = shell.as_deref();
            match shell_str {
                // `tp completions install [shell] [flags]`
                Some("install") => commands::completions_install::run(false, &args),
                // `tp completions uninstall [shell] [flags]`
                Some("uninstall") => commands::completions_install::run(true, &args),
                // `tp completions [bash|zsh|fish]` — emit script to stdout.
                other => commands::completions::run(other),
            }
        }

        // Ported subcommands.
        Some(Command::Logs { sid }) => commands::logs::run(sid.as_deref()),
        Some(Command::Doctor) => commands::doctor::run(),
        Some(Command::Upgrade) => commands::upgrade::run(),

        // daemon subcommand dispatch (tranche 4d: stop/status/install/uninstall/start all ported).
        Some(Command::Daemon {
            action: Some(DaemonAction::Stop),
        }) => commands::daemon::stop(),
        Some(Command::Daemon {
            action: Some(DaemonAction::Status),
        }) => commands::daemon::status(),
        Some(Command::Daemon {
            action: Some(DaemonAction::Install),
        }) => commands::daemon::install(),
        Some(Command::Daemon {
            action: Some(DaemonAction::Uninstall),
        }) => commands::daemon::uninstall(),
        Some(Command::Daemon {
            action: Some(DaemonAction::Start { args }),
        }) => commands::daemon::start(&args),
        // Bare `tp daemon` with no subcommand, or unrecognised subcommand:
        // mirror daemon.ts:102-111 — usage to stderr + exit 1.
        Some(Command::Daemon { action: None }) => {
            eprintln!(
                "Usage: tp daemon <start|stop|status|install|uninstall> [options]\n\
                 \x20 start      Start daemon in foreground\n\
                 \x20 stop       Stop the running daemon\n\
                 \x20 status     Show service registration + running state\n\
                 \x20 install    Register as OS service (launchd/systemd/Task Scheduler)\n\
                 \x20 uninstall  Remove OS service registration"
            );
            ExitCode::FAILURE
        }

        // Run and Relay: intercepted by decide_route pre-clap; these arms are
        // belt-and-suspenders (they fire only if a future refactor bypasses
        // decide_route). Reconstruct the original argv from the parsed command
        // name and forward to the blob.
        Some(Command::Run) => {
            // `tp run [...]` — args after `run` are captured by clap's
            // trailing_var_arg. Since Run has no fields we can only forward
            // the reconstructed argv. decide_route should have caught this.
            let mut fwd: Vec<String> = vec!["run".to_string()];
            fwd.extend(args.iter().skip(2).cloned());
            commands::forward::exec_blob(&fwd)
        }
        Some(Command::Relay) => {
            let mut fwd: Vec<String> = vec!["relay".to_string()];
            fwd.extend(args.iter().skip(2).cloned());
            commands::forward::exec_blob(&fwd)
        }

        // Bare `tp pair` (no action) is an alias for `tp pair new` in the Bun
        // CLI (pair.ts:59-62). List/New/Delete/Rename are all dispatched above.
        Some(Command::Pair { action: None }) => commands::pair::new(&[]),
        Some(Command::Session {
            action: Some(SessionAction::Cleanup { yes, all }),
        }) => commands::session::cleanup(yes, all),
        Some(Command::Session { action }) => {
            // Bare `tp session` with no action: print usage.
            let _ = action; // suppress unused warning
            eprintln!(
                "Usage: tp session <list|delete|prune|cleanup> [options]\n\
                 \x20 list      List saved sessions\n\
                 \x20 delete    Delete a session\n\
                 \x20 prune     Non-interactive bulk delete\n\
                 \x20 cleanup   Interactive multi-select bulk delete"
            );
            ExitCode::FAILURE
        }

        // Bare `tp` with no subcommand: this path is only reached when
        // decide_route returned Native (which requires a recognized first arg).
        // Bare tp (no args) is handled above as Forward. The None arm here is
        // a safety net for edge cases (e.g. clap bug or future refactor).
        None => {
            use clap::CommandFactory;
            let mut cmd = Cli::command();
            let _ = cmd.print_help();
            println!();
            ExitCode::SUCCESS
        }
    }
}
