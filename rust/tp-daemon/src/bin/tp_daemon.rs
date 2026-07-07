//! `tp-daemon` — the shipping Rust daemon binary. Behavior-faithful port of
//! the Bun daemon entrypoint `packages/daemon/src/index.ts` (ADR-0003 Phase 4,
//! increment 5).
//!
//! Sequence (index.ts:12-75): singleton pid-file lock → argv parse (`--spawn`
//! `--sid` `--cwd` `--worktree-path`, unknown args ignored like
//! `parseArgs({strict:false})`) → `Daemon::new` + `start()` →
//! `start_auto_cleanup()` → fire-and-forget `reconnect_saved_relays()` →
//! optional `--spawn` session → wait for SIGINT/SIGTERM → release lock +
//! `stop()` + exit 0.
//!
//! NOTE (honest scope): this bin exists so the whole Rust daemon assembly is
//! runnable end-to-end, but the **dogfood default daemon remains the Bun
//! implementation** — nothing in the CLI is flipped to spawn this binary
//! (that is a later increment, gated on parity evidence).

use tp_daemon::daemon::Daemon;
use tp_daemon::daemon_lock::{acquire_daemon_lock, release_daemon_lock};
use tp_daemon::session::manager::SpawnRunnerOptions;
use tp_proto::socket_path::resolve_runtime_dir;

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Minimal argv parser mirroring index.ts:23-32 (`parseArgs` with
/// `strict: false`): `--spawn` boolean + three string options; unknown
/// arguments are ignored; a string option consumes the following token.
struct Args {
    spawn: bool,
    sid: Option<String>,
    cwd: Option<String>,
    worktree_path: Option<String>,
}

fn parse_args(argv: &[String]) -> Args {
    let mut args = Args {
        spawn: false,
        sid: None,
        cwd: None,
        worktree_path: None,
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--spawn" => args.spawn = true,
            "--sid" => {
                if let Some(v) = argv.get(i + 1) {
                    args.sid = Some(v.clone());
                    i += 1;
                }
            }
            "--cwd" => {
                if let Some(v) = argv.get(i + 1) {
                    args.cwd = Some(v.clone());
                    i += 1;
                }
            }
            "--worktree-path" => {
                if let Some(v) = argv.get(i + 1) {
                    args.worktree_path = Some(v.clone());
                    i += 1;
                }
            }
            _ => {} // strict:false — ignore unknowns
        }
        i += 1;
    }
    args
}

#[tokio::main]
async fn main() {
    // ── Singleton guard (index.ts:12-21) ────────────────────────────────
    // Acquire the pid-file lock before starting the IPC server. If a live
    // daemon already holds the lock we exit 0 so launchd/systemd restarts
    // don't pile up.
    let lock_path = match resolve_runtime_dir() {
        Ok(dir) => dir.join("daemon.pid"), // = TS getDaemonLockPath()
        Err(err) => {
            eprintln!("[Daemon] failed to resolve runtime dir: {err}");
            std::process::exit(1);
        }
    };
    match acquire_daemon_lock(&lock_path) {
        Ok(Some(_pid)) => {}
        Ok(None) => {
            eprintln!("[Daemon] daemon already running — exiting");
            std::process::exit(0);
        }
        Err(err) => {
            eprintln!("[Daemon] failed to acquire daemon lock: {err}");
            std::process::exit(1);
        }
    }

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&argv);

    let daemon = match Daemon::new(None) {
        Ok(d) => std::sync::Arc::new(d),
        Err(err) => {
            eprintln!("[Daemon] failed to open store: {err}");
            release_daemon_lock(&lock_path);
            std::process::exit(1);
        }
    };
    let socket_path = match daemon.start(None) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("[Daemon] failed to start IPC server: {err}");
            release_daemon_lock(&lock_path);
            std::process::exit(1);
        }
    };

    // Auto-cleanup old sessions on startup + every 24h (index.ts:38).
    daemon.start_auto_cleanup(None);

    // Reconnect all saved pairings so paired frontends receive frames after a
    // daemon (re)start (index.ts:46-53, fire-and-forget). Store DB is the
    // sole source of truth for saved pairings.
    {
        let daemon = std::sync::Arc::clone(&daemon);
        tokio::spawn(async move {
            let count = daemon.reconnect_saved_relays().await;
            if count > 0 {
                eprintln!("[Daemon] reconnected to {count} saved relay(s)");
            }
        });
    }

    eprintln!("[Daemon] listening on {}", socket_path.display());
    eprintln!("[Daemon] press Ctrl+C to stop");

    // If --spawn is provided, create a session immediately (index.ts:59-65).
    if args.spawn {
        let sid = args.sid.unwrap_or_else(|| format!("session-{}", now_ms())); // decimal ts, same as `session-${Date.now()}`
        let cwd = args.cwd.unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string())
        });
        let opts = SpawnRunnerOptions {
            worktree_path: args.worktree_path,
            ..SpawnRunnerOptions::default()
        };
        if let Err(err) = daemon.create_session(&sid, &cwd, Some(opts)) {
            // TS lets spawnRunner throw out of the top level (daemon dies);
            // keep the daemon alive here but log loudly — the session spawn
            // failing shouldn't take the freshly-started daemon down with it.
            eprintln!("[Daemon] --spawn session failed: {err}");
        }
    }

    // Wait for SIGINT/SIGTERM (index.ts:67-75 `shutdown()`).
    let mut sigint =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).expect("SIGINT");
    let mut sigterm =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
    }

    eprintln!("[Daemon] shutting down...");
    release_daemon_lock(&lock_path);
    daemon.stop().await;
    std::process::exit(0);
}
