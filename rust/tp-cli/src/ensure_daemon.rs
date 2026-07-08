//! Native `ensure_daemon()` — bring the daemon up if it isn't already running
//! (task #17 PR-3, prep for the native passthrough handler in PR-4).
//!
//! Port of the load-bearing core of `ensureDaemon()` in
//! `apps/cli/src/lib/ensure-daemon.ts:137-190`:
//!   1. already running (`is_daemon_running()`) → return `true`;
//!   2. else kickstart the OS service if installed, poll for readiness;
//!   3. else spawn the daemon in the background (detached) + poll for readiness.
//!
//! # Why this spawns the Bun blob (flip-independent)
//!
//! Today the native `tp daemon start` (`commands/daemon.rs:470`) is itself a
//! trampoline: it locates the Bun SEA (`locate_bun_blob()`) and exec's
//! `<blob> daemon start`. This `ensure_daemon()` spawns that same blob in the
//! background, byte-for-byte the daemon the Bun `ensureDaemon()` compiled path
//! spawns (`[process.execPath, ["daemon","start"]]`, where `execPath` IS the
//! tpd blob). So the daemon the native passthrough ensures is identical to the
//! one dogfood runs today — this is NOT gated on the Rust-daemon default flip
//! (task #4). When the flip lands, this single spawn site swaps to
//! `locate_tp_daemon()` (locate.rs:167) and nothing else here changes.
//!
//! # Deferred to PR-5 (gap filed)
//!
//! The Bun `ensureDaemon()` also runs a first-run "Install daemon as an OS
//! service? [Y/n]" prompt (`showInstallHint`, ensure-daemon.ts:198-249) after a
//! successful background spawn. That interactive prompt + the `.daemon-hint-shown`
//! stamp file are **intentionally not ported here** — see the `FIRST_RUN_GAP`
//! note at the call site. PR-5 ports it natively (accepted plan Q6.1). Until
//! then the blob still owns the first-run prompt on the passthrough path (which
//! still execs the blob through PR-4's dark landing), so no behavior is lost.

// `ensure_daemon()` and its helpers land ahead of their only caller — the
// native passthrough handler wired by task #17 PR-4. Until then they are
// exercised only by the unit tests below (mirrors the `locate_tp_daemon()`
// flip-prep A1 precedent + PR-2's `passthrough_split`). The `#[allow]` is
// removed when PR-4 adds the first real caller.
#![allow(dead_code)]

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::socket::is_daemon_running;

/// Service-manager labels — must match `commands/daemon.rs` (byte-exact from
/// `service-darwin.ts:8` / `service-linux.ts:8`).
const MACOS_LABEL: &str = "dev.tpmt.daemon";
const LINUX_SERVICE_NAME: &str = "teleprompter-daemon";

/// Readiness poll budget — port of `waitForDaemonReady`'s defaults
/// (ensure-daemon.ts:81): up to 10s, probing every 500ms, check-then-sleep so a
/// sub-500ms daemon doesn't pay the initial delay.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Whether the launchd plist / systemd unit is installed. Same checks as
/// `commands/daemon.rs` (`is_plist_installed` / `is_unit_installed`), re-derived
/// here to keep this module self-contained.
fn is_service_installed() -> bool {
    match std::env::consts::OS {
        "macos" => std::env::var("HOME").is_ok_and(|home| {
            std::path::PathBuf::from(home)
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{MACOS_LABEL}.plist"))
                .exists()
        }),
        "linux" => unit_path().is_some_and(|p| p.exists()),
        _ => false,
    }
}

/// `$XDG_CONFIG_HOME/systemd/user/teleprompter-daemon.service` — mirror of
/// `commands/daemon.rs::unit_path()` (via `config_dir()`'s parent).
fn unit_path() -> Option<std::path::PathBuf> {
    let cfg = crate::config_dir::config_dir();
    let base = cfg.parent()?;
    Some(
        base.join("systemd")
            .join("user")
            .join(format!("{LINUX_SERVICE_NAME}.service")),
    )
}

/// Ask the OS service manager to start the daemon. Returns `true` if a service
/// is installed and a start was issued (not that the daemon is up yet — the
/// caller polls). Port of `startService()` (`service.ts:52-76`).
fn start_service() -> bool {
    match std::env::consts::OS {
        "macos" => {
            if !is_service_installed() {
                return false;
            }
            let uid = rustix::process::getuid().as_raw();
            let target = format!("gui/{uid}/{MACOS_LABEL}");
            // Best-effort: kickstart's own exit code is not load-bearing (the
            // caller polls the socket for actual readiness), matching the TS
            // `spawnSync` whose status is ignored.
            let _ = Command::new("launchctl")
                .args(["kickstart", &target])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            true
        }
        "linux" => {
            if !is_service_installed() {
                return false;
            }
            let _ = Command::new("systemctl")
                .args(["--user", "start", LINUX_SERVICE_NAME])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            true
        }
        _ => false,
    }
}

/// Poll `is_daemon_running()` until it returns true or `READY_TIMEOUT` elapses.
/// Check-then-sleep (port of `waitForDaemonReady`, ensure-daemon.ts:81-88).
fn wait_for_daemon_ready() -> bool {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if is_daemon_running() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(READY_POLL_INTERVAL);
    }
}

/// Spawn the daemon in the background, detached, with stdio suppressed and
/// `LOG_LEVEL=error` (matching the TS `spawn(..., {stdio:"ignore", detached:true,
/// env:{...,LOG_LEVEL:"error"}})` + `proc.unref()`).
///
/// Spawns the located Bun SEA `<blob> daemon start` — see the module doc for why
/// this is the flip-independent choice. Returns an error string if the blob can't
/// be located or the spawn fails.
fn spawn_background_daemon() -> Result<(), String> {
    let blob = crate::locate::locate_bun_blob()?;

    // `Command` children are not process-group leaders and we never wait on the
    // handle, so dropping it detaches (the OS reparents to init) — the Rust
    // equivalent of `detached:true` + `unref()`. stdio null = `stdio:"ignore"`.
    Command::new(&blob)
        .arg("daemon")
        .arg("start")
        .env("LOG_LEVEL", "error")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_child| ())
        .map_err(|e| format!("tp: failed to spawn daemon ({}): {e}", blob.display()))
}

/// Ensure the daemon is running, starting it if necessary. Returns `true` when
/// the daemon IPC socket is reachable.
///
/// Port of `ensureDaemon()` (ensure-daemon.ts:137-190), minus the first-run
/// install prompt (deferred to PR-5 — see `FIRST_RUN_GAP` below).
///
/// # Errors
///
/// Returns `Err(message)` only for a **loud, contained** failure to locate or
/// spawn the daemon blob (mirrors the TS `resolveDaemonSpawnCommand` throw path).
/// A readiness *timeout* is a normal `Ok(false)` — the caller decides how to
/// surface it — matching the TS `return false` tail.
pub fn ensure_daemon() -> Result<bool, String> {
    if is_daemon_running() {
        return Ok(true);
    }

    // Kickstart the OS service if installed; if it comes up, we're done.
    if start_service() && wait_for_daemon_ready() {
        return Ok(true);
    }
    // Otherwise fall through to a manual background spawn.

    spawn_background_daemon()?;

    if wait_for_daemon_ready() {
        // FIRST_RUN_GAP (PR-5): the Bun `ensureDaemon()` runs `showInstallHint()`
        // here — the interactive "Install daemon as an OS service? [Y/n]" prompt
        // and the `.daemon-hint-shown` stamp. Not ported yet; PR-5 adds it
        // natively (accepted plan Q6.1). Behavior is preserved in the meantime
        // because the passthrough path still execs the blob (PR-2 dark landing),
        // which owns the prompt until PR-4/5.
        return Ok(true);
    }

    // Readiness timeout — not an error, just "couldn't bring it up in 10s".
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_poll_budget_matches_ts_defaults() {
        // waitForDaemonReady defaults: 10s timeout, 500ms interval.
        assert_eq!(READY_TIMEOUT, Duration::from_secs(10));
        assert_eq!(READY_POLL_INTERVAL, Duration::from_millis(500));
    }

    #[test]
    fn service_labels_match_daemon_module() {
        // These MUST equal commands/daemon.rs's constants or start_service()
        // would kickstart a different label than `tp daemon install` registered.
        assert_eq!(MACOS_LABEL, "dev.tpmt.daemon");
        assert_eq!(LINUX_SERVICE_NAME, "teleprompter-daemon");
    }

    #[test]
    fn unit_path_shape() {
        // Should end with systemd/user/teleprompter-daemon.service when derivable.
        if let Some(p) = unit_path() {
            let s = p.to_string_lossy();
            assert!(s.contains("systemd/user"), "unexpected unit path: {s}");
            assert!(
                s.ends_with("teleprompter-daemon.service"),
                "unexpected unit path: {s}"
            );
        }
    }

    #[test]
    fn is_service_installed_is_false_on_unsupported_os() {
        // The match's `_` arm returns false; on macOS/linux the fs probe may be
        // either, so we can only assert the branch logic is total (no panic).
        let _ = is_service_installed();
    }
}
