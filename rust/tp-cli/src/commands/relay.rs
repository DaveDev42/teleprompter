//! Native `tp relay …` dispatch (task #17 — de-trampoline `tp relay start`).
//!
//! Replaces the Bun blob forward for the `relay` route. Previously `tp relay
//! start` execed the Bun `tpd` blob, which dispatched to `relayCommand`
//! (`apps/cli/src/commands/relay.ts`) → a Bun `RelayServer`. Now `tp relay
//! start` execs the shipped native Rust `tp-relay` binary
//! ([`crate::locate::locate_tp_relay`]) directly — the same standalone relay
//! server the production deploy already runs (`rust/tp-relay`).
//!
//! # Subcommand dispatch (byte-parity with `relayCommand`)
//!
//! - `start` → exec `tp-relay` with translated args/env (see below).
//! - `ping`  → the moved-to-`tp doctor` message + exit 0.
//! - anything else / bare `tp relay` → the usage message + exit 1.
//!
//! # Argument translation (`start`)
//!
//! The Bun `startRelay` accepted three CLI flags; the native `tp-relay` binary
//! only parses `--port` (everything else is env-driven, `resolve_port` in
//! `rust/tp-relay/src/main.rs`). To preserve behavior WITHOUT a breaking change,
//! this handler translates the two env-backed flags into the environment
//! variables `tp-relay` already reads:
//!
//! - `--port <N>`           → passed through as `--port <N>` on the `tp-relay` argv
//! - `--cache-size <N>`     → `TP_RELAY_CACHE_SIZE=<N>`     (tp-relay `ring.rs`)
//! - `--max-frame-size <N>` → `TP_RELAY_MAX_FRAME_SIZE=<N>` (tp-relay `conn.rs`)
//!
//! Both the `--flag value` and `--flag=value` spellings are accepted (matching
//! Node's `parseArgs`). An invalid integer for any flag prints the same
//! `tp relay: invalid --<flag> value: '…'` error the Bun path did and exits 1.
//! Unknown flags are ignored (Bun ran `parseArgs` with `strict: false` and
//! `startRelay` only consumed the three known keys).
//!
//! # exec-replace
//!
//! Like [`super::forward_claude`] / [`super::run`], the `start`
//! path uses `exec()` to replace the process image with `tp-relay`, inheriting
//! stdio, the TTY, and signals (SIGINT for graceful shutdown), so `tp-relay`'s
//! exit code becomes ours and no Rust parent is left in the signal path.

use std::process::ExitCode;

use crate::format::error_with_hints;
use crate::locate::locate_tp_relay;

/// Usage text for `tp relay` — byte-parity with the Bun `relayCommand` default
/// arm (`relay.ts:15-21`).
const USAGE: &str = "Usage: tp relay start [options]\n\
     \n  --port <port>           Server port (default: 7090)\
     \n  --cache-size <n>        Max cached frames per session (default: 10, env: TP_RELAY_CACHE_SIZE)\
     \n  --max-frame-size <n>    Max WebSocket frame size in bytes (default: 1048576, env: TP_RELAY_MAX_FRAME_SIZE)";

/// Dispatch `tp relay …`. `args_after_tp` is `std::env::args()[1..]`, i.e. it
/// starts with the literal `"relay"` token.
pub fn run(args_after_tp: &[String]) -> ExitCode {
    // args_after_tp[0] == "relay"; the subcommand (if any) is the next token.
    let subcommand = args_after_tp.get(1).map(String::as_str);

    match subcommand {
        Some("start") => run_start(&args_after_tp[2..]),
        Some("ping") => {
            println!("tp relay ping has moved to tp doctor.\n  → Run: tp doctor");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}

/// A `--flag`/value pair parsed out of the `start` args.
struct RelayFlags {
    port: Option<String>,
    cache_size: Option<String>,
    max_frame_size: Option<String>,
}

/// Parse the recognized `start` flags. Accepts `--flag value` and `--flag=value`.
/// Unknown flags/positionals are ignored (Bun `parseArgs` `strict: false`).
fn parse_start_flags(args: &[String]) -> RelayFlags {
    let mut flags = RelayFlags {
        port: None,
        cache_size: None,
        max_frame_size: None,
    };

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        // Split `--flag=value`; otherwise the value is the next token.
        let (name, inline_val) = match arg.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (arg.as_str(), None),
        };

        let slot = match name {
            "--port" => Some(&mut flags.port),
            "--cache-size" => Some(&mut flags.cache_size),
            "--max-frame-size" => Some(&mut flags.max_frame_size),
            _ => None,
        };

        if let Some(slot) = slot {
            if let Some(v) = inline_val {
                *slot = Some(v);
                i += 1;
            } else if let Some(v) = args.get(i + 1) {
                *slot = Some(v.clone());
                i += 2;
            } else {
                // Flag with no value — leave unset; tp-relay/default handles it.
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    flags
}

/// Validate a flag value parses as a finite non-negative integer (mirrors the
/// Bun `parseFiniteInt` guard). Returns the trimmed value on success.
fn valid_int(value: &str) -> Option<String> {
    value.trim().parse::<u64>().ok().map(|n| n.to_string())
}

/// Handle `tp relay start <flags>`: translate flags → `tp-relay` argv + env,
/// then exec the native relay binary.
fn run_start(start_args: &[String]) -> ExitCode {
    let flags = parse_start_flags(start_args);

    // Build the tp-relay argv (only --port is a native flag) + env overrides for
    // the two env-backed knobs. Each flag, if present, must be a valid integer —
    // else the same error + exit 1 the Bun path produced.
    let mut relay_argv: Vec<String> = Vec::new();
    let mut env_overrides: Vec<(String, String)> = Vec::new();

    if let Some(port) = &flags.port {
        match valid_int(port) {
            Some(v) => {
                relay_argv.push("--port".to_string());
                relay_argv.push(v);
            }
            None => {
                eprintln!("tp relay: invalid --port value: '{port}'");
                return ExitCode::FAILURE;
            }
        }
    }

    if let Some(cache) = &flags.cache_size {
        match valid_int(cache) {
            Some(v) => env_overrides.push(("TP_RELAY_CACHE_SIZE".to_string(), v)),
            None => {
                eprintln!("tp relay: invalid --cache-size value: '{cache}'");
                return ExitCode::FAILURE;
            }
        }
    }

    if let Some(frame) = &flags.max_frame_size {
        match valid_int(frame) {
            Some(v) => env_overrides.push(("TP_RELAY_MAX_FRAME_SIZE".to_string(), v)),
            None => {
                eprintln!("tp relay: invalid --max-frame-size value: '{frame}'");
                return ExitCode::FAILURE;
            }
        }
    }

    let bin = match locate_tp_relay() {
        Ok(p) => p,
        Err(msg) => {
            eprintln!(
                "{}",
                error_with_hints(
                    &msg,
                    &["Reinstall tp, or set TP_RELAY_BIN to a tp-relay binary."]
                )
            );
            return ExitCode::FAILURE;
        }
    };

    exec_relay(&bin, &relay_argv, &env_overrides)
}

/// Exec `tp-relay <argv>` with `env_overrides` applied, replacing the process
/// image (inherits stdio + TTY + signals). Returns only on an exec syscall error.
#[cfg(unix)]
fn exec_relay(
    bin: &std::path::Path,
    argv: &[String],
    env_overrides: &[(String, String)],
) -> ExitCode {
    use std::os::unix::process::CommandExt;

    let mut cmd = std::process::Command::new(bin);
    cmd.args(argv);
    for (k, v) in env_overrides {
        cmd.env(k, v);
    }
    // exec() replaces the process image — tp-relay inherits our stdio + TTY, and
    // its exit code becomes ours. Returns only on an exec syscall failure.
    let err = cmd.exec();
    eprintln!("tp: failed to exec {}: {err}", bin.display());
    ExitCode::FAILURE
}

/// Stub for non-Unix targets (tp is POSIX-only).
#[cfg(not(unix))]
fn exec_relay(
    _bin: &std::path::Path,
    _argv: &[String],
    _env_overrides: &[(String, String)],
) -> ExitCode {
    eprintln!("tp: relay is only supported on POSIX platforms");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parses_port_space_form() {
        let f = parse_start_flags(&v(&["--port", "9090"]));
        assert_eq!(f.port.as_deref(), Some("9090"));
        assert_eq!(f.cache_size, None);
        assert_eq!(f.max_frame_size, None);
    }

    #[test]
    fn parses_port_equals_form() {
        let f = parse_start_flags(&v(&["--port=9090"]));
        assert_eq!(f.port.as_deref(), Some("9090"));
    }

    #[test]
    fn parses_all_three_flags() {
        let f = parse_start_flags(&v(&[
            "--port",
            "7000",
            "--cache-size",
            "25",
            "--max-frame-size",
            "2048",
        ]));
        assert_eq!(f.port.as_deref(), Some("7000"));
        assert_eq!(f.cache_size.as_deref(), Some("25"));
        assert_eq!(f.max_frame_size.as_deref(), Some("2048"));
    }

    #[test]
    fn ignores_unknown_flags() {
        // Bun parseArgs strict:false + startRelay consuming only the 3 known keys
        // → unknown flags are tolerated and dropped.
        let f = parse_start_flags(&v(&["--bogus", "x", "--port", "7", "positional"]));
        assert_eq!(f.port.as_deref(), Some("7"));
        assert_eq!(f.cache_size, None);
    }

    #[test]
    fn flag_with_no_value_is_unset() {
        let f = parse_start_flags(&v(&["--port"]));
        assert_eq!(f.port, None);
    }

    #[test]
    fn valid_int_accepts_plain_and_trimmed() {
        assert_eq!(valid_int("10"), Some("10".to_string()));
        assert_eq!(valid_int("  42 "), Some("42".to_string()));
    }

    #[test]
    fn valid_int_rejects_non_numeric_and_negative() {
        assert_eq!(valid_int("abc"), None);
        assert_eq!(valid_int("-5"), None);
        assert_eq!(valid_int("1.5"), None);
        assert_eq!(valid_int(""), None);
    }

    #[test]
    fn usage_matches_bun_default_arm() {
        // Byte-parity anchors with relay.ts:15-21.
        assert!(USAGE.starts_with("Usage: tp relay start [options]"));
        assert!(USAGE.contains("--port <port>           Server port (default: 7090)"));
        assert!(USAGE.contains("env: TP_RELAY_CACHE_SIZE"));
        assert!(USAGE.contains("env: TP_RELAY_MAX_FRAME_SIZE"));
    }
}
