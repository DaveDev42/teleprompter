//! `tp-relay` — the runnable relay server entry point (ADR-0003 Stage 1 Step 8a).
//!
//! THIN by design. All relay configuration is read from the environment by
//! [`SharedState::from_env`] (resume secret `TP_RELAY_RESUME_SECRET`, the
//! per-client / per-daemon GCRA rate budgets, the recent-frames cache size, and
//! the max inbound frame size) and by the lazily-initialised push sealer
//! (`TP_RELAY_PUSH_SEAL_SECRET` / `_PREV` / `_VERSION`). The binary itself only
//! decides the LISTEN PORT and wires graceful shutdown.
//!
//! Port precedence (highest wins): `--port <N>` flag > `RELAY_PORT` env >
//! default `7090`. The `RELAY_PORT` env makes the existing systemd unit's
//! `Environment=RELAY_PORT=7090` live once the 8b deploy repoints it at this
//! binary; the `--port` flag keeps manual/local runs ergonomic.
//!
//! Architecture invariants (unchanged): the relay is the daemon's only WS peer
//! (daemons self-register via `relay.register`), the app reaches the daemon ONLY
//! through the relay, and the relay forwards ciphertext only.

use std::net::SocketAddr;
use std::process::ExitCode;

use tp_relay::http::BUILD_SHA;
use tp_relay::{RelayServer, SharedState};

/// Default listen port. Mirrors `tp relay start` (`apps/cli/src/commands/relay.ts`
/// `--port` default "7090") and `deploy-relay.yml`'s `Environment=RELAY_PORT=7090`.
const DEFAULT_PORT: u16 = 7090;

fn main() -> ExitCode {
    let port = match resolve_port(std::env::args().skip(1)) {
        Ok(Some(port)) => port,
        // `--help` / `-h` printed usage; exit success.
        Ok(None) => return ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("tp-relay: {msg}");
            eprint!("{USAGE}");
            return ExitCode::FAILURE;
        }
    };

    // Build the multi-thread runtime explicitly (rather than `#[tokio::main]`) so
    // arg/usage handling above stays synchronous and cheap.
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("tp-relay: failed to start tokio runtime: {err}");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(run(port)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("tp-relay: serve error: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Bind and serve until SIGINT/SIGTERM, then drain gracefully.
async fn run(port: u16) -> std::io::Result<()> {
    // `SharedState::from_env` already reads resume secret / rate / cache /
    // max-frame; the push sealer is initialised lazily on first push-path call.
    let server = RelayServer::with_state(SharedState::from_env());
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Single startup line operators can grep: port + the compile-time build SHA
    // that `/health.buildSha` will also report (the 8b deploy asserts equality).
    println!("tp-relay listening on {addr} (buildSha={BUILD_SHA})");

    server.serve_with_shutdown(addr, shutdown_signal()).await
}

/// Resolve until either SIGINT (Ctrl-C) or SIGTERM (`systemctl stop`) arrives.
///
/// If a signal handler fails to install, that arm parks forever via
/// `std::future::pending` instead of resolving immediately (which would cause a
/// spurious instant shutdown).
async fn shutdown_signal() {
    let ctrl_c = async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {}
            Err(err) => {
                eprintln!("tp-relay: failed to install SIGINT handler: {err}");
                // Park forever so the failed arm doesn't win the select! race.
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(err) => {
                eprintln!("tp-relay: failed to install SIGTERM handler: {err}");
                // Park forever so the failed arm doesn't win the select! race.
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    eprintln!("tp-relay: shutdown signal received; draining connections");
}

/// `--help`/`-h`/usage text (printed on `--help` and on any arg error).
const USAGE: &str = "\
Usage: tp-relay [--port <PORT>]

Options:
  --port <PORT>    TCP port to listen on (default 7090; overrides RELAY_PORT env)
  -h, --help       Print this help and exit

Configuration is read from the environment:
  RELAY_PORT                       listen port (lower precedence than --port)
  TP_RELAY_RESUME_SECRET           HMAC key for resume tokens (ephemeral if unset)
  TP_RELAY_RATE_PER_CLIENT         per-client GCRA budget (msgs/s)
  TP_RELAY_RATE_PER_DAEMON         per-daemon-group GCRA budget (msgs/s)
  TP_RELAY_CACHE_SIZE              recent-frames ring depth
  TP_RELAY_MAX_FRAME_SIZE          max inbound frame bytes (default 1 MiB)
  TP_RELAY_PUSH_SEAL_SECRET[_PREV] APNs push-token seal key(s)
";

/// Resolve the listen port from CLI args + `RELAY_PORT` env.
///
/// Returns `Ok(Some(port))` to serve, `Ok(None)` when `--help` was handled (the
/// caller exits success), or `Err(msg)` for a malformed flag.
fn resolve_port(args: impl Iterator<Item = String>) -> Result<Option<u16>, String> {
    let mut flag_port: Option<u16> = None;
    let mut args = args.peekable();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return Ok(None);
            }
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--port requires a value".to_string())?;
                flag_port = Some(parse_port(&value)?);
            }
            other if other.starts_with("--port=") => {
                let value = &other["--port=".len()..];
                flag_port = Some(parse_port(value)?);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    // Precedence: --port flag > RELAY_PORT env > DEFAULT_PORT.
    if let Some(port) = flag_port {
        return Ok(Some(port));
    }
    if let Some(env_port) = env_port()? {
        return Ok(Some(env_port));
    }
    Ok(Some(DEFAULT_PORT))
}

/// Parse `RELAY_PORT` from the environment, if present and non-empty.
fn env_port() -> Result<Option<u16>, String> {
    match std::env::var("RELAY_PORT") {
        Ok(raw) if !raw.is_empty() => Ok(Some(parse_port(&raw)?)),
        _ => Ok(None),
    }
}

/// Parse a port string, rejecting 0 (an OS-assigned ephemeral port is never what
/// an operator means for a long-running relay) and non-numeric input.
fn parse_port(raw: &str) -> Result<u16, String> {
    match raw.parse::<u16>() {
        Ok(0) => Err("port must be 1..=65535 (got 0)".to_string()),
        Ok(port) => Ok(port),
        Err(_) => Err(format!("invalid port: {raw}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_port, DEFAULT_PORT};

    fn argv(args: &[&str]) -> impl Iterator<Item = String> {
        args.iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn defaults_to_7090_with_no_args() {
        // NOTE: this test process must not have RELAY_PORT set; the env path is
        // covered by the integration test which controls the child's env.
        if std::env::var_os("RELAY_PORT").is_some() {
            return;
        }
        assert_eq!(resolve_port(argv(&[])), Ok(Some(DEFAULT_PORT)));
    }

    #[test]
    fn flag_parses() {
        assert_eq!(resolve_port(argv(&["--port", "9001"])), Ok(Some(9001)));
        assert_eq!(resolve_port(argv(&["--port=9002"])), Ok(Some(9002)));
    }

    #[test]
    fn rejects_bad_flag() {
        assert!(resolve_port(argv(&["--port", "abc"])).is_err());
        assert!(resolve_port(argv(&["--port", "0"])).is_err());
        assert!(resolve_port(argv(&["--port"])).is_err());
        assert!(resolve_port(argv(&["--bogus"])).is_err());
    }

    #[test]
    fn help_returns_none() {
        assert_eq!(resolve_port(argv(&["--help"])), Ok(None));
        assert_eq!(resolve_port(argv(&["-h"])), Ok(None));
    }
}
