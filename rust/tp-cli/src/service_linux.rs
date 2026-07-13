//! `tp daemon install` / `uninstall` — Linux systemd user service management.
//!
//! Byte-exact port of `apps/cli/src/lib/service-linux.ts` (103 lines).
//!
//! The unit file template, key order, whitespace, and output strings are
//! reproduced verbatim. A trailing newline after `WantedBy=default.target`
//! is part of the template (unlike the macOS plist which has none).
//!
//! References (verified against HEAD):
//!   - `apps/cli/src/lib/service-linux.ts:31-46`  — `generateUnit`
//!   - `apps/cli/src/lib/service-linux.ts:48-81`  — `installLinux`
//!   - `apps/cli/src/lib/service-linux.ts:83-102` — `uninstallLinux`

use std::path::PathBuf;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// Constants (service-linux.ts:8)
// ---------------------------------------------------------------------------

const SERVICE_NAME: &str = "teleprompter-daemon";

// ---------------------------------------------------------------------------
// Path helpers (service-linux.ts:10-21)
// ---------------------------------------------------------------------------

/// `$XDG_CONFIG_HOME/systemd/user` (or `$HOME/.config/systemd/user`).
///
/// Port of `getUnitDir()` in `service-linux.ts:10-16`.
/// Keys off `XDG_CONFIG_HOME`, NOT `XDG_DATA_HOME` — these are different dirs.
pub fn unit_dir() -> PathBuf {
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".config")
        }
    }
    .join("systemd")
    .join("user")
}

/// `$XDG_CONFIG_HOME/systemd/user/teleprompter-daemon.service`
///
/// Port of `getUnitPath()` in `service-linux.ts:19-21`.
pub fn unit_path() -> PathBuf {
    unit_dir().join(format!("{SERVICE_NAME}.service"))
}

// ---------------------------------------------------------------------------
// Unit file generation (service-linux.ts:31-46) — byte-identical
// ---------------------------------------------------------------------------

/// Generate the systemd unit file content.
///
/// The output is byte-identical to `generateUnit(tpBinary)` in
/// `service-linux.ts:31-46`. The template **has a trailing newline** after
/// `WantedBy=default.target` (the template string ends with `\n`).
///
/// `home` is the value of `$HOME` (baked into `Environment=` lines).
pub fn generate_unit(tp_binary: &str, home: &str) -> String {
    format!(
        "[Unit]\n\
         Description=Teleprompter Daemon\n\
         After=network.target\n\
         \n\
         [Service]\n\
         ExecStart={tp_binary} daemon start\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         Environment=HOME={home}\n\
         Environment=PATH=/usr/local/bin:/usr/bin:/bin:{home}/.local/bin\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

// ---------------------------------------------------------------------------
// install (service-linux.ts:48-81)
// ---------------------------------------------------------------------------

/// `tp daemon install` on Linux.
///
/// Byte-exact port of `installLinux()` in `service-linux.ts:48-81`.
///
/// Returns `true` on success, `false` on any failure (dir/unit write error or a
/// non-zero `systemctl enable`). The CLI dispatch maps this to an `ExitCode`;
/// the first-run prompt consumes the `bool` directly — see the `install_darwin`
/// note for why the return type is `bool` rather than the opaque `ExitCode`.
pub fn install_linux() -> bool {
    let tp_binary = crate::commands::daemon::resolve_tp_binary_pub();
    let unit_dir_path = unit_dir();
    let unit = unit_path();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

    // 1. mkdir unitDir — service-linux.ts:54
    if let Err(e) = std::fs::create_dir_all(&unit_dir_path) {
        eprintln!(
            "[Service] failed to create unit dir {}: {e}",
            unit_dir_path.display()
        );
        return false;
    }

    // 2. Write unit file — service-linux.ts:57-58
    let content = generate_unit(&tp_binary, &home);
    if let Err(e) = std::fs::write(&unit, &content) {
        eprintln!("[Service] failed to write unit {}: {e}", unit.display());
        return false;
    }

    // 3. systemctl --user daemon-reload — service-linux.ts:61
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();

    // 4. systemctl --user enable --now teleprompter-daemon — service-linux.ts:62-69
    let enable_result = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", SERVICE_NAME])
        .output();
    let (exit_ok, enable_stderr) = match enable_result {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ),
        Err(e) => (false, e.to_string()),
    };
    if !exit_ok {
        // service-linux.ts:70-73
        eprintln!("[Service] systemctl enable failed: {enable_stderr}");
        return false;
    }

    // 5. Success output — service-linux.ts:76-80
    println!("[Service] Installed systemd user service: {SERVICE_NAME}");
    println!("[Service] Unit: {}", unit.display());
    println!("[Service] Binary: {tp_binary}");
    println!("\nThe daemon will start automatically on login.");
    println!("To check status: systemctl --user status {SERVICE_NAME}");

    true
}

// ---------------------------------------------------------------------------
// uninstall (service-linux.ts:83-102)
// ---------------------------------------------------------------------------

/// `tp daemon uninstall` on Linux.
///
/// Byte-exact port of `uninstallLinux()` in `service-linux.ts:83-102`.
pub fn uninstall_linux() -> ExitCode {
    let unit = unit_path();

    // service-linux.ts:86-89: if unit absent → log + return
    if !unit.exists() {
        println!("[Service] No systemd service found at {}", unit.display());
        return ExitCode::SUCCESS;
    }

    // service-linux.ts:92: systemctl --user disable --now
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", SERVICE_NAME])
        .status();

    // service-linux.ts:95: unlink unit
    if let Err(e) = std::fs::remove_file(&unit) {
        eprintln!("[Service] failed to remove unit {}: {e}", unit.display());
        return ExitCode::FAILURE;
    }

    // service-linux.ts:98: daemon-reload
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();

    // service-linux.ts:100-101: success output
    println!("[Service] Uninstalled systemd user service: {SERVICE_NAME}");
    println!("[Service] Removed: {}", unit.display());

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── unit golden string (byte-identical to service-linux.ts:31-46) ────────

    #[test]
    fn unit_golden_has_trailing_newline() {
        let unit = generate_unit("/usr/local/bin/tp", "/home/u");
        assert!(
            unit.ends_with('\n'),
            "unit file MUST end with a trailing newline (service-linux.ts template): {:?}",
            &unit[unit.len().saturating_sub(10)..]
        );
    }

    #[test]
    fn unit_golden_content() {
        let unit = generate_unit("/usr/local/bin/tp", "/home/u");
        let expected = "[Unit]\nDescription=Teleprompter Daemon\nAfter=network.target\n\n\
                        [Service]\nExecStart=/usr/local/bin/tp daemon start\nRestart=on-failure\n\
                        RestartSec=5\nEnvironment=HOME=/home/u\n\
                        Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/u/.local/bin\n\n\
                        [Install]\nWantedBy=default.target\n";
        assert_eq!(
            unit, expected,
            "unit content must be byte-identical to the TS template"
        );
    }

    #[test]
    fn unit_exec_start_uses_daemon_start() {
        let unit = generate_unit("/usr/local/bin/tp", "/home/u");
        assert!(
            unit.contains("ExecStart=/usr/local/bin/tp daemon start\n"),
            "ExecStart must include 'daemon start': {unit}"
        );
    }

    #[test]
    fn unit_env_path_contains_local_bin() {
        let unit = generate_unit("/usr/local/bin/tp", "/home/u");
        assert!(unit.contains("Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/u/.local/bin"));
    }

    // ── unit_path shape ──────────────────────────────────────────────────────

    #[test]
    fn unit_path_ends_with_service_file() {
        let p = unit_path();
        let s = p.to_string_lossy();
        assert!(
            s.ends_with("teleprompter-daemon.service"),
            "unit path must end with teleprompter-daemon.service: {s}"
        );
    }

    #[test]
    fn unit_dir_contains_systemd_user() {
        let d = unit_dir();
        let s = d.to_string_lossy();
        assert!(
            s.contains("systemd/user"),
            "unit dir must contain systemd/user: {s}"
        );
    }

    // ── Output string golden assertions ──────────────────────────────────────

    #[test]
    fn install_success_output_strings() {
        // service-linux.ts:76-80
        assert_eq!(
            format!("[Service] Installed systemd user service: {SERVICE_NAME}"),
            "[Service] Installed systemd user service: teleprompter-daemon"
        );
        assert_eq!(
            format!("To check status: systemctl --user status {SERVICE_NAME}"),
            "To check status: systemctl --user status teleprompter-daemon"
        );
    }

    #[test]
    fn uninstall_output_strings() {
        // service-linux.ts:100-101
        assert_eq!(
            format!("[Service] Uninstalled systemd user service: {SERVICE_NAME}"),
            "[Service] Uninstalled systemd user service: teleprompter-daemon"
        );
    }

    #[test]
    fn enable_failed_error_string() {
        // service-linux.ts:71
        let stderr = "Failed to enable unit: File exists.\n";
        let msg = format!("[Service] systemctl enable failed: {stderr}");
        assert!(msg.starts_with("[Service] systemctl enable failed:"));
    }

    #[test]
    fn no_service_found_string() {
        // service-linux.ts:88
        let path = PathBuf::from("/home/u/.config/systemd/user/teleprompter-daemon.service");
        let msg = format!("[Service] No systemd service found at {}", path.display());
        assert!(msg.contains("teleprompter-daemon.service"));
    }
}
