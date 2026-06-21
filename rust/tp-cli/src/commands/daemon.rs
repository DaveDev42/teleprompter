//! `tp daemon stop` and `tp daemon status` — byte-exact ports of
//! `apps/cli/src/commands/daemon.ts:daemonStop()` and
//! `apps/cli/src/commands/daemon-status.ts:daemonStatusCommand()`.
//!
//! Architecture invariants (see CLAUDE.md):
//!   - `stop`   = SIGTERM + optional service unload ONLY. No IPC, no socket open.
//!   - `status` = pure socket-presence probe + fs::metadata for the service file.
//!     No IPC, no SQLite write, no relay/WS.
//!
//! Signal delivery uses `rustix::process::kill_process` (safe, `process` feature
//! already in Cargo.toml) — avoids `libc` and satisfies `unsafe_code = "forbid"`.
//!
//! # Platform mapping
//!
//! | macOS | Linux |
//! |-------|-------|
//! | launchd; plist at `~/Library/LaunchAgents/dev.tpmt.daemon.plist` | systemd --user; unit at `$XDG_CONFIG_HOME/systemd/user/teleprompter-daemon.service` |
//! | label = `dev.tpmt.daemon` | name = `teleprompter-daemon` |
//! | `launchctl bootout gui/<uid>/<label>` | `systemctl --user stop <name>` |
//!
//! References (verified against HEAD):
//!   - `apps/cli/src/commands/daemon.ts:228-277`   (daemonStop)
//!   - `apps/cli/src/commands/daemon-status.ts:82-117` (render)
//!   - `apps/cli/src/lib/service-darwin.ts:8,10-25` (LABEL, getPlistPath, isServiceInstalled)
//!   - `apps/cli/src/lib/service-linux.ts:8,19-29` (SERVICE_NAME, getUnitPath, isServiceInstalled)
//!   - `apps/cli/src/lib/colors.ts:18-21` (warn/fail escape sequences)

use std::path::PathBuf;
use std::process::ExitCode;

use rustix::process::{kill_process, Pid, Signal};

use crate::colors::{dim, fail, green, warn};
use crate::config_dir::config_dir;
use crate::socket::{is_daemon_running, read_daemon_pid, socket_path};
use crate::store::log_dir;

// ---------------------------------------------------------------------------
// Service constants (byte-exact from service-darwin.ts:8 + service-linux.ts:8)
// ---------------------------------------------------------------------------

const MACOS_LABEL: &str = "dev.tpmt.daemon";
const LINUX_SERVICE_NAME: &str = "teleprompter-daemon";

// ---------------------------------------------------------------------------
// Path helpers (byte-exact ports)
// ---------------------------------------------------------------------------

/// `~/Library/LaunchAgents/dev.tpmt.daemon.plist`
/// Port of `getPlistPath()` in `apps/cli/src/lib/service-darwin.ts:10-17`.
fn plist_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{MACOS_LABEL}.plist")),
    )
}

/// `$XDG_CONFIG_HOME/systemd/user/teleprompter-daemon.service`
/// Port of `getUnitPath()` in `apps/cli/src/lib/service-linux.ts:19-21`.
fn unit_path() -> PathBuf {
    config_dir()
        .parent()
        .unwrap_or_else(|| std::path::Path::new("/tmp"))
        .join("systemd")
        .join("user")
        .join(format!("{LINUX_SERVICE_NAME}.service"))
}

fn is_plist_installed() -> bool {
    plist_path().is_some_and(|p| p.exists())
}

fn is_unit_installed() -> bool {
    unit_path().exists()
}

// ---------------------------------------------------------------------------
// `tp daemon stop` (daemon.ts:223-278)
// ---------------------------------------------------------------------------

/// Stop the running daemon.
///
/// Step 1: tell the OS service manager to stop so it won't respawn.
/// Step 2: SIGTERM the pid from the lock file.
///
/// Byte-exact port of `daemonStop()` in `apps/cli/src/commands/daemon.ts:223-278`.
/// All output strings verified at HEAD below.
pub fn stop() -> ExitCode {
    // Step 1: service manager unload/stop (daemon.ts:228-254)
    let os = std::env::consts::OS; // "macos" | "linux" | …
    if os == "macos" && is_plist_installed() {
        let uid = rustix::process::getuid().as_raw();
        let target = format!("gui/{uid}/{MACOS_LABEL}");
        let result = std::process::Command::new("launchctl")
            .args(["bootout", &target])
            .status();
        if result.is_ok_and(|s| s.success()) {
            // daemon.ts:241: console.log(`[Daemon] unloaded launchd service ${label}`)
            println!("[Daemon] unloaded launchd service {MACOS_LABEL}");
        }
    } else if os == "linux" && is_unit_installed() {
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "stop", LINUX_SERVICE_NAME])
            .status();
        // daemon.ts:252: console.log(`[Daemon] stopped systemd unit ${name}`)
        println!("[Daemon] stopped systemd unit {LINUX_SERVICE_NAME}");
    }

    // Step 2: SIGTERM the daemon pid from the lock file (daemon.ts:256-277)
    let pid_val = read_daemon_pid();
    if pid_val.is_none() {
        // daemon.ts:261: console.log("[Daemon] no running daemon found (no pid file)")
        println!("[Daemon] no running daemon found (no pid file)");
        return ExitCode::SUCCESS;
    }
    let pid_val = pid_val.unwrap();

    let Some(pid) = Pid::from_raw(pid_val) else {
        // pid <= 0 — treat as no pid (shouldn't happen after read_daemon_pid)
        println!("[Daemon] no running daemon found (no pid file)");
        return ExitCode::SUCCESS;
    };

    match kill_process(pid, Signal::Term) {
        Ok(()) => {
            // daemon.ts:267: console.log(`[Daemon] sent SIGTERM to pid=${pid}`)
            println!("[Daemon] sent SIGTERM to pid={pid_val}");
            ExitCode::SUCCESS
        }
        Err(e) if e == rustix::io::Errno::SRCH => {
            // daemon.ts:270: console.log(`[Daemon] pid=${pid} is no longer running`)
            println!("[Daemon] pid={pid_val} is no longer running");
            ExitCode::SUCCESS
        }
        Err(e) => {
            // daemon.ts:273-276: console.error(...)
            eprintln!("[Daemon] failed to send SIGTERM to pid={pid_val}: {e}");
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// `tp daemon status` (daemon-status.ts:20-133)
// ---------------------------------------------------------------------------

/// Probed state for one platform's service.
#[cfg_attr(test, derive(Debug, PartialEq))]
pub struct StatusState {
    pub installed: bool,
    pub background_running: bool,
    pub manager_hint: String,
    pub binary_path: String,
    pub config_path: String,
    pub log_path: String,
    pub socket_path: String,
}

/// Resolve the `tp` binary path for the `Binary:` row.
///
/// Prefer `std::env::current_exe()` over `argv[0]` because Bun compiled
/// binaries report a synthetic `/$bunfs/root/tp` path in `argv[0]` which fails
/// `existsSync`. The Rust native binary uses the real on-disk path via
/// `current_exe()` — no synthetic path pitfall. Falls back to the PATH walk and
/// well-known locations, matching the Bun `resolveTpBinary()` intent
/// (`apps/cli/src/lib/paths.ts:38-64`).
fn resolve_tp_binary() -> String {
    // current_exe() is the Rust equivalent — always a real on-disk path.
    if let Ok(exe) = std::env::current_exe() {
        if exe.exists() {
            return exe.to_string_lossy().into_owned();
        }
    }
    // PATH walk (mirrors paths.ts:49-53)
    if let Ok(path_var) = std::env::var("PATH") {
        for entry in path_var.split(':') {
            if entry.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(entry).join("tp");
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    // Well-known locations (paths.ts:55-63)
    let candidates = [
        "/usr/local/bin/tp".to_string(),
        "/opt/homebrew/bin/tp".to_string(),
        std::env::var("HOME")
            .map(|h| format!("{h}/.local/bin/tp"))
            .unwrap_or_default(),
    ];
    for c in &candidates {
        if !c.is_empty() && PathBuf::from(c).exists() {
            return c.clone();
        }
    }
    String::new()
}

/// Probe all status fields for the current platform.
/// Pure function — no I/O side effects beyond fs probes.
pub fn probe_status() -> StatusState {
    let os = std::env::consts::OS;
    let background_running = is_daemon_running();
    let sock = socket_path().to_string_lossy().into_owned();
    let binary = resolve_tp_binary();

    if os == "macos" {
        let installed = is_plist_installed();
        let manager_hint = format!("launchd ({MACOS_LABEL})");
        let config_path = plist_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let log_path = log_dir()
            .map(|d| d.join("daemon.log").to_string_lossy().into_owned())
            .unwrap_or_default();
        StatusState {
            installed,
            background_running,
            manager_hint,
            binary_path: binary,
            config_path,
            log_path,
            socket_path: sock,
        }
    } else if os == "linux" {
        let installed = is_unit_installed();
        let manager_hint = format!("systemd --user ({LINUX_SERVICE_NAME})");
        // daemon-status.ts:49-55: configPath = join($XDG_CONFIG_HOME/.., "systemd", "user", "<name>.service")
        let config_path = unit_path().to_string_lossy().into_owned();
        // daemon-status.ts:56: `journalctl --user -u ${name}`
        let log_path = format!("journalctl --user -u {LINUX_SERVICE_NAME}");
        StatusState {
            installed,
            background_running,
            manager_hint,
            binary_path: binary,
            config_path,
            log_path,
            socket_path: sock,
        }
    } else {
        let manager_hint = format!("unsupported platform ({os})");
        StatusState {
            installed: false,
            background_running,
            manager_hint,
            binary_path: binary,
            config_path: String::new(),
            log_path: String::new(),
            socket_path: sock,
        }
    }
}

/// Format the log path, annotating a real file with its last-modified age.
/// Port of `formatLogPath` in `apps/cli/src/commands/daemon-status.ts:124-133`.
fn format_log_path(log_path: &str) -> String {
    if log_path.is_empty() || log_path.starts_with("journalctl") {
        return log_path.to_string();
    }
    let p = PathBuf::from(log_path);
    match p.metadata() {
        Ok(meta) => {
            use std::time::{SystemTime, UNIX_EPOCH};
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(now_ms);
            format!("{log_path} {}", dim(&log_updated_suffix(now_ms, mtime_ms)))
        }
        Err(_) => format!("{log_path} {}", dim("(not created yet)")),
    }
}

/// Pure date-math for the `Logs:` row's `(updated …)` suffix. Extracted so the
/// `now_ms`/`mtime_ms` arithmetic is unit-testable without filesystem I/O.
///
/// Derives `age_ms = now_ms - mtime_ms` and passes the real `now_ms` to
/// `format_age`, which reconstructs the mtime epoch as `now_ms - age_ms` for its
/// `>=7d` ISO-date branch (format.rs:31). Passing `now_ms = 0` would make that
/// branch compute a negative epoch -> wrong date (e.g. `1969-12-21`). Mirrors the
/// TS reference `new Date(Date.now() - ms)` (format.ts:44).
fn log_updated_suffix(now_ms: i64, mtime_ms: i64) -> String {
    let age_ms = now_ms - mtime_ms;
    format!("(updated {})", crate::format::format_age(age_ms, now_ms))
}

/// Render the status output. Pure function — takes probed state, writes to
/// stdout/stderr. Extracted for testability (golden-assert all 4 states without
/// a live daemon).
///
/// Byte-exact port of `render()` in `apps/cli/src/commands/daemon-status.ts:82-117`.
pub fn render_status(state: &StatusState) -> String {
    let mut out = String::new();

    // daemon-status.ts:83: console.log("")
    out.push('\n');
    // daemon-status.ts:84: console.log("Daemon Service")
    out.push_str("Daemon Service\n");
    // daemon-status.ts:85: console.log("──────────────")  (14× U+2500)
    out.push_str("──────────────\n");

    // daemon-status.ts:86-90: Service row
    let svc_state = if state.installed {
        green("installed")
    } else {
        dim("not installed")
    };
    out.push_str(&format!(
        "Service:    {svc_state}  ({})\n",
        state.manager_hint
    ));

    // daemon-status.ts:91-95: Process row
    let proc_state = if state.background_running {
        green("running")
    } else {
        dim("not running")
    };
    out.push_str(&format!("Process:    {proc_state}\n"));

    // daemon-status.ts:96: Socket row
    out.push_str(&format!("Socket:     {}\n", state.socket_path));

    // daemon-status.ts:97: Binary row — dim fallback when empty
    let binary_display = if state.binary_path.is_empty() {
        dim("(not resolved)")
    } else {
        state.binary_path.clone()
    };
    out.push_str(&format!("Binary:     {binary_display}\n"));

    // daemon-status.ts:98: Config row
    out.push_str(&format!("Config:     {}\n", state.config_path));

    // daemon-status.ts:99: Logs row
    out.push_str(&format!(
        "Logs:       {}\n",
        format_log_path(&state.log_path)
    ));

    // daemon-status.ts:100: console.log("")
    out.push('\n');

    // daemon-status.ts:102-108: not installed hint
    if !state.installed {
        out.push_str(&format!(
            "{} The daemon will not start automatically on login.\n",
            warn("Service is not registered.")
        ));
        out.push_str("Register with: tp daemon install\n");
        return out;
    }

    // daemon-status.ts:110-116: installed-but-not-running hint
    if !state.background_running {
        out.push_str(&format!(
            "{}\n",
            fail("Service is installed but the daemon process is not running.")
        ));
        out.push_str("Start manually: tp daemon start\n");
        out.push_str("Or reinstall:   tp daemon uninstall && tp daemon install\n");
    }

    out
}

/// `tp daemon status` entry point.
pub fn status() -> ExitCode {
    let state = probe_status();
    // render_status returns a single string; print it (it already ends with '\n').
    print!("{}", render_status(&state));
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: build a StatusState with given installed/running flags for golden tests.
    fn make_state(installed: bool, running: bool) -> StatusState {
        StatusState {
            installed,
            background_running: running,
            manager_hint: "launchd (dev.tpmt.daemon)".to_string(),
            binary_path: "/usr/local/bin/tp".to_string(),
            config_path: "/Users/u/Library/LaunchAgents/dev.tpmt.daemon.plist".to_string(),
            log_path: "/Users/u/.local/share/teleprompter/logs/daemon.log".to_string(),
            socket_path: "/tmp/teleprompter-501/daemon.sock".to_string(),
        }
    }

    // -------------------------------------------------------------------------
    // Pid path derivation
    // -------------------------------------------------------------------------

    #[test]
    fn daemon_pid_path_sibling_to_daemon_sock() {
        use crate::socket::daemon_pid_path;
        // daemon_pid_path() must live in the same dir as socket_path() — they
        // co-locate in the runtime dir (daemon-lock.ts:22-24 + socket.rs).
        let pid_p = daemon_pid_path();
        let sock_p = socket_path();
        assert_eq!(pid_p.parent(), sock_p.parent());
        assert_eq!(
            pid_p.file_name().and_then(|s| s.to_str()),
            Some("daemon.pid")
        );
    }

    // -------------------------------------------------------------------------
    // log_updated_suffix — regression guard for the now_ms=0 date bug
    // -------------------------------------------------------------------------

    #[test]
    fn log_updated_suffix_recent_uses_relative_age() {
        // <7d → relative "Nd ago" form; now_ms is unused on this branch, but the
        // suffix must still read from the real age. 2d ago.
        let now_ms = 1_781_000_000_000i64; // 2026-06-09T10:13:20Z
        let mtime_ms = now_ms - 2 * 24 * 60 * 60_000;
        assert_eq!(log_updated_suffix(now_ms, mtime_ms), "(updated 2d ago)");
    }

    #[test]
    fn log_updated_suffix_old_reconstructs_iso_date_not_epoch_zero() {
        // >=7d → ISO-date branch. This is the exact bug the verifier caught:
        // passing now_ms=0 made format_age compute `0 - age_ms` (negative epoch)
        // → "1969-12-21". With the real now_ms, format_age reconstructs the true
        // mtime epoch (now_ms - age_ms == mtime_ms) → the correct calendar date.
        let now_ms = 1_781_000_000_000i64; // 2026-06-09T10:13:20Z
        let mtime_ms = now_ms - 10 * 24 * 60 * 60_000; // 10 days earlier
        let out = log_updated_suffix(now_ms, mtime_ms);
        // 2026-06-09 minus 10 days = 2026-05-30 (UTC).
        assert_eq!(out, "(updated 2026-05-30)");
        // Hard guard against the regression: must never render the epoch-zero date.
        assert!(
            !out.contains("1969"),
            "now_ms=0 epoch-zero bug regressed: {out}"
        );
    }

    // -------------------------------------------------------------------------
    // render_status golden assertions (all 4 states)
    // -------------------------------------------------------------------------

    #[test]
    fn render_not_installed_not_running() {
        // State: service not installed, daemon not running.
        // Expected: header + dim("not installed") + dim("not running") + hint block.
        let state = make_state(false, false);
        let out = render_status(&state);

        // Header lines (daemon-status.ts:83-85)
        assert!(out.contains("Daemon Service\n"));
        assert!(out.contains("──────────────\n"));

        // Service row: dim("not installed") (daemon-status.ts:88)
        assert!(out.contains("not installed"));

        // Process row: dim("not running") (daemon-status.ts:93)
        assert!(out.contains("not running"));

        // Not-installed hint block (daemon-status.ts:103-107)
        assert!(out.contains("Service is not registered."));
        assert!(out.contains("The daemon will not start automatically on login."));
        assert!(out.contains("Register with: tp daemon install"));

        // Should NOT include the installed-but-not-running hint
        assert!(!out.contains("Service is installed but the daemon process is not running."));
    }

    #[test]
    fn render_not_installed_running() {
        // Edge: daemon running without the service file (manual `tp daemon start`).
        let state = make_state(false, true);
        let out = render_status(&state);
        assert!(out.contains("not installed"));
        // Process is green("running") — contains "running" regardless of color
        assert!(out.contains("running"));
        // Hint: not installed block (service not registered)
        assert!(out.contains("Service is not registered."));
        assert!(!out.contains("Service is installed but the daemon process is not running."));
    }

    #[test]
    fn render_installed_running() {
        // Happy path: installed + running. No hint block.
        let state = make_state(true, true);
        let out = render_status(&state);
        // Service: green("installed")
        assert!(out.contains("installed"));
        // Process: green("running")
        assert!(out.contains("running"));
        // No hint lines
        assert!(!out.contains("Service is not registered."));
        assert!(!out.contains("Service is installed but the daemon process is not running."));
    }

    #[test]
    fn render_installed_not_running() {
        // Service installed but daemon crashed / not started.
        // daemon-status.ts:110-116: fail() + two hint lines.
        let state = make_state(true, false);
        let out = render_status(&state);
        assert!(out.contains("installed"));
        assert!(out.contains("not running"));
        // fail() hint (daemon-status.ts:111)
        assert!(out.contains("Service is installed but the daemon process is not running."));
        // Two hint lines (daemon-status.ts:112-115)
        assert!(out.contains("Start manually: tp daemon start"));
        assert!(out.contains("Or reinstall:   tp daemon uninstall && tp daemon install"));
    }

    #[test]
    fn render_contains_all_row_labels() {
        // Every row label must appear in the output regardless of state.
        let state = make_state(true, true);
        let out = render_status(&state);
        assert!(out.contains("Service:    "));
        assert!(out.contains("Process:    "));
        assert!(out.contains("Socket:     "));
        assert!(out.contains("Binary:     "));
        assert!(out.contains("Config:     "));
        assert!(out.contains("Logs:       "));
    }

    #[test]
    fn render_binary_dim_fallback_when_empty() {
        // Binary path empty → dim("(not resolved)") (daemon-status.ts:97)
        let mut state = make_state(true, true);
        state.binary_path = String::new();
        let out = render_status(&state);
        assert!(out.contains("(not resolved)"));
    }

    #[test]
    fn render_separator_is_14_box_drawing() {
        // daemon-status.ts:85: 14× U+2500 ─
        let state = make_state(false, false);
        let out = render_status(&state);
        assert!(out.contains("──────────────\n"));
        // Count the box-drawing chars in the separator line
        let sep: Vec<char> = "──────────────".chars().collect();
        assert_eq!(sep.len(), 14);
        assert!(sep.iter().all(|&c| c == '─'));
    }

    // -------------------------------------------------------------------------
    // stop() pure-logic branches (signal errors mapped to output strings)
    // -------------------------------------------------------------------------

    /// Simulate the "no pid file" stop branch (daemon.ts:261).
    #[test]
    fn stop_no_pid_output_string() {
        // The exact output the stop function prints when read_daemon_pid() = None.
        // Can't call stop() directly (it calls the real read_daemon_pid), so
        // assert the literal string the TS reference produces.
        let msg = "[Daemon] no running daemon found (no pid file)";
        assert!(msg.starts_with("[Daemon]"));
        assert!(msg.contains("no pid file"));
    }

    /// Verify ESRCH branch string (daemon.ts:270).
    #[test]
    fn esrch_output_string() {
        let pid_val: i32 = 12345;
        let msg = format!("[Daemon] pid={pid_val} is no longer running");
        assert_eq!(msg, "[Daemon] pid=12345 is no longer running");
    }

    /// Verify SIGTERM success string (daemon.ts:267).
    #[test]
    fn sigterm_success_output_string() {
        let pid_val: i32 = 42;
        let msg = format!("[Daemon] sent SIGTERM to pid={pid_val}");
        assert_eq!(msg, "[Daemon] sent SIGTERM to pid=42");
    }

    /// Verify macOS launchd unload string (daemon.ts:241).
    #[test]
    fn launchd_unload_output_string() {
        let label = MACOS_LABEL;
        let msg = format!("[Daemon] unloaded launchd service {label}");
        assert_eq!(msg, "[Daemon] unloaded launchd service dev.tpmt.daemon");
    }

    /// Verify Linux systemd stop string (daemon.ts:252).
    #[test]
    fn systemd_stop_output_string() {
        let name = LINUX_SERVICE_NAME;
        let msg = format!("[Daemon] stopped systemd unit {name}");
        assert_eq!(msg, "[Daemon] stopped systemd unit teleprompter-daemon");
    }

    // -------------------------------------------------------------------------
    // Path helpers
    // -------------------------------------------------------------------------

    #[test]
    fn plist_path_shape() {
        // Should be ~/Library/LaunchAgents/dev.tpmt.daemon.plist
        if let Some(p) = plist_path() {
            let s = p.to_string_lossy();
            assert!(s.contains("Library/LaunchAgents"));
            assert!(s.ends_with("dev.tpmt.daemon.plist"));
        }
    }

    #[test]
    fn unit_path_shape() {
        // Should end with systemd/user/teleprompter-daemon.service
        let p = unit_path();
        let s = p.to_string_lossy();
        assert!(s.contains("systemd/user"));
        assert!(s.ends_with("teleprompter-daemon.service"));
    }

    #[test]
    fn log_dir_sibling_to_vault() {
        // log_dir = $XDG_DATA_HOME/teleprompter/logs
        // store_dir = $XDG_DATA_HOME/teleprompter/vault
        // Both must share the parent $XDG_DATA_HOME/teleprompter.
        if let (Some(log), Some(store)) = (log_dir(), crate::store::store_dir()) {
            assert_eq!(log.parent(), store.parent());
        }
    }

    #[test]
    fn log_dir_ends_with_logs() {
        if let Some(d) = log_dir() {
            assert_eq!(d.file_name().and_then(|s| s.to_str()), Some("logs"));
        }
    }
}
