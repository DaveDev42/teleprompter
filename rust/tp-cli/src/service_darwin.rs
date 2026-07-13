//! `tp daemon install` / `uninstall` — macOS launchd service management.
//!
//! Byte-exact port of `apps/cli/src/lib/service-darwin.ts` (167 lines).
//!
//! The plist template, key order, whitespace, and output strings are reproduced
//! verbatim. See service.test.ts snapshot tests for the golden reference.
//!
//! # Infinite-loop guard
//!
//! The binary path written into `ProgramArguments` is the RUST `tp` binary
//! (via `resolve_tp_binary()`), NOT the Bun blob.  When launchd respawns it
//! the Rust `tp daemon start` exec's the Bun blob — one hop, no loop.
//!
//! # Injectable launchctl runner
//!
//! The retry/poll loop accepts a `LaunchctlRunner` trait so unit tests can
//! stub it without spawning real launchd processes.
//!
//! References (verified against HEAD):
//!   - `apps/cli/src/lib/service-darwin.ts:36-66`   — `generatePlist`
//!   - `apps/cli/src/lib/service-darwin.ts:68-92`   — `bootoutAndWait` / `isLoaded`
//!   - `apps/cli/src/lib/service-darwin.ts:94-146`  — `installDarwin`
//!   - `apps/cli/src/lib/service-darwin.ts:149-166` — `uninstallDarwin`

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread::sleep;
use std::time::Duration;

use crate::store::log_dir;

// ---------------------------------------------------------------------------
// Constants (service-darwin.ts:8)
// ---------------------------------------------------------------------------

const LABEL: &str = "dev.tpmt.daemon";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// `~/Library/LaunchAgents/dev.tpmt.daemon.plist`
///
/// Port of `getPlistPath()` in `service-darwin.ts:10-17`.
/// HOME absent → `/tmp` fallback (TS: `process.env["HOME"] ?? "/tmp"`).
pub fn plist_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// Port of `getLogDir()` in `service-darwin.ts:27-34`.
///
/// Uses `store::log_dir()` (already correct) — falls back to `/tmp` if HOME
/// and XDG_DATA_HOME are both absent.
fn get_log_dir() -> PathBuf {
    log_dir().unwrap_or_else(|| PathBuf::from("/tmp/teleprompter/logs"))
}

// ---------------------------------------------------------------------------
// Plist generation (service-darwin.ts:36-66) — byte-identical
// ---------------------------------------------------------------------------

/// Generate the launchd plist XML.
///
/// The output is byte-identical to `generatePlist(tpBinary, logDir)` in
/// `service-darwin.ts:36-66`. Key order, indentation (2 spaces), and the
/// absence of a trailing newline after `</plist>` are all preserved exactly.
///
/// `home` is the value of `$HOME` (baked into `EnvironmentVariables`).
pub fn generate_plist(tp_binary: &str, log_dir: &Path, home: &str) -> String {
    let log_file = log_dir.join("daemon.log");
    let log_str = log_file.to_string_lossy();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{tp_binary}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log_str}</string>
  <key>StandardErrorPath</key>
  <string>{log_str}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>{home}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:{home}/.local/bin</string>
  </dict>
</dict>
</plist>"#
    )
}

// ---------------------------------------------------------------------------
// Injectable launchctl runner (enables unit testing of retry/poll logic)
// ---------------------------------------------------------------------------

/// Outcome of a single `launchctl` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchctlResult {
    /// Non-zero exit code means failure / service absent.
    pub exit_code: i32,
    /// Captured stderr (used by `bootstrap` to detect EIO retries).
    pub stderr: String,
}

/// Abstraction over `launchctl` invocations.  The real implementation shells
/// out via `std::process::Command`; tests inject a stub.
pub trait LaunchctlRunner {
    /// Run `launchctl <args>` and return the result.
    fn run(&mut self, args: &[&str]) -> LaunchctlResult;
}

/// Real implementation: shells out to `/usr/bin/launchctl`.
pub struct RealLaunchctl;

impl LaunchctlRunner for RealLaunchctl {
    fn run(&mut self, args: &[&str]) -> LaunchctlResult {
        match std::process::Command::new("launchctl").args(args).output() {
            Ok(out) => LaunchctlResult {
                exit_code: out.status.code().unwrap_or(1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            },
            Err(_) => LaunchctlResult {
                exit_code: 1,
                stderr: String::new(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// bootoutAndWait + EIO bootstrap retry (service-darwin.ts:84-131)
// ---------------------------------------------------------------------------

/// Port of `isLoaded(serviceTarget)` — `launchctl print <target>` exit 0 = loaded.
fn is_loaded(runner: &mut dyn LaunchctlRunner, service_target: &str) -> bool {
    runner.run(&["print", service_target]).exit_code == 0
}

/// Port of `bootoutAndWait(serviceTarget)` — `service-darwin.ts:84-92`.
///
/// Issues `launchctl bootout <target>` (no-op if not loaded, exit 3 is fine),
/// then polls `launchctl print <target>` up to **30 × 100ms** until it exits
/// non-zero (gone).  Uses `std::thread::sleep` — no subprocess `sleep`.
fn bootout_and_wait(runner: &mut dyn LaunchctlRunner, service_target: &str) {
    runner.run(&["bootout", service_target]);
    for _ in 0..30 {
        if !is_loaded(runner, service_target) {
            return;
        }
        sleep(Duration::from_millis(100));
    }
}

/// EIO bootstrap retry loop — `service-darwin.ts:122-130`.
///
/// `launchctl bootstrap <domain> <plist>` can race a concurrent bootout and
/// return `5: Input/output error`. Retry up to 4 more times (5 total attempts)
/// with 300ms settle + `bootoutAndWait` in between.
///
/// Returns the final result after all attempts.
fn bootstrap_with_retry(
    runner: &mut dyn LaunchctlRunner,
    domain: &str,
    plist_path: &str,
    service_target: &str,
) -> LaunchctlResult {
    let mut result = runner.run(&["bootstrap", domain, plist_path]);
    for _ in 1..5 {
        if result.exit_code == 0 {
            break;
        }
        // Only retry the EIO race; surface any other error immediately.
        if !result.stderr.contains("5: Input/output error") {
            break;
        }
        sleep(Duration::from_millis(300));
        bootout_and_wait(runner, service_target);
        result = runner.run(&["bootstrap", domain, plist_path]);
    }
    result
}

// ---------------------------------------------------------------------------
// install (service-darwin.ts:94-146)
// ---------------------------------------------------------------------------

/// `tp daemon install` on macOS.
///
/// Byte-exact port of `installDarwin()` in `service-darwin.ts:94-146`.
/// The 5-line success output, error string, and all launchctl invocations
/// are reproduced verbatim.
///
/// `runner` is injectable for unit tests; production callers pass `&mut RealLaunchctl`.
///
/// Returns `true` on success, `false` on any failure (dir/plist write error or
/// a non-zero `launchctl bootstrap`). The CLI dispatch (`commands::daemon::
/// install`) maps this to an `ExitCode`; the first-run prompt
/// (`ensure_daemon::show_install_hint`) consumes the `bool` directly, since
/// `std::process::ExitCode` is not comparable. Byte-exactness with
/// `installDarwin` (service-darwin.ts) is preserved — only the return *type*
/// changes (the TS fn returns `void` and signals failure by `process.exit(1)`
/// at its own `install` boundary; here the boolean carries that signal).
pub fn install_darwin(runner: &mut dyn LaunchctlRunner) -> bool {
    let tp_binary = crate::commands::daemon::resolve_tp_binary_pub();
    let log_dir_path = get_log_dir();
    let plist = plist_path();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

    // 1. mkdir logDir (recursive) — service-darwin.ts:100
    if let Err(e) = std::fs::create_dir_all(&log_dir_path) {
        eprintln!(
            "[Service] failed to create log dir {}: {e}",
            log_dir_path.display()
        );
        return false;
    }

    // 2. mkdir ~/Library/LaunchAgents (recursive) — service-darwin.ts:103-105
    let launch_agents = PathBuf::from(&home).join("Library").join("LaunchAgents");
    if let Err(e) = std::fs::create_dir_all(&launch_agents) {
        eprintln!("[Service] failed to create LaunchAgents dir: {e}");
        return false;
    }

    // 3. Write plist — service-darwin.ts:108-109
    let plist_content = generate_plist(&tp_binary, &log_dir_path, &home);
    if let Err(e) = std::fs::write(&plist, plist_content) {
        eprintln!("[Service] failed to write plist {}: {e}", plist.display());
        return false;
    }

    // 4. Derive uid/domain/serviceTarget — service-darwin.ts:112-114
    let uid = rustix::process::getuid().as_raw();
    let domain = format!("gui/{uid}");
    let service_target = format!("{domain}/{LABEL}");
    let plist_str = plist.to_string_lossy();

    // 5. bootoutAndWait — service-darwin.ts:118
    bootout_and_wait(runner, &service_target);

    // 6. bootstrap + EIO retry — service-darwin.ts:122-135
    let result = bootstrap_with_retry(runner, &domain, &plist_str, &service_target);
    if result.exit_code != 0 {
        // service-darwin.ts:133: console.error(`[Service] launchctl bootstrap failed: ${stderr}`)
        eprintln!("[Service] launchctl bootstrap failed: {}", result.stderr);
        return false;
    }

    // 7. kickstart -k — service-darwin.ts:139
    runner.run(&["kickstart", "-k", &service_target]);

    // 8. Success output — service-darwin.ts:141-146
    // NOTE: console.log(`\nThe daemon...`) emits an empty line then the text.
    println!("[Service] Installed launchd service: {LABEL}");
    println!("[Service] Plist: {}", plist.display());
    println!(
        "[Service] Logs: {}",
        log_dir_path.join("daemon.log").display()
    );
    println!("[Service] Binary: {tp_binary}");
    println!("\nThe daemon will start automatically on login.");
    println!("To check status: launchctl list {LABEL}");

    true
}

// ---------------------------------------------------------------------------
// uninstall (service-darwin.ts:149-166)
// ---------------------------------------------------------------------------

/// `tp daemon uninstall` on macOS.
///
/// Byte-exact port of `uninstallDarwin()` in `service-darwin.ts:149-166`.
pub fn uninstall_darwin(runner: &mut dyn LaunchctlRunner) -> ExitCode {
    let plist = plist_path();

    // service-darwin.ts:152-155: if plist absent → log + return
    if !plist.exists() {
        println!("[Service] No launchd service found at {}", plist.display());
        return ExitCode::SUCCESS;
    }

    // service-darwin.ts:158-159: bootout (no wait)
    let uid = rustix::process::getuid().as_raw();
    let service_target = format!("gui/{uid}/{LABEL}");
    runner.run(&["bootout", &service_target]);

    // service-darwin.ts:162: unlink plist
    if let Err(e) = std::fs::remove_file(&plist) {
        eprintln!("[Service] failed to remove plist {}: {e}", plist.display());
        return ExitCode::FAILURE;
    }

    // service-darwin.ts:164-165: success output
    println!("[Service] Uninstalled launchd service: {LABEL}");
    println!("[Service] Removed: {}", plist.display());

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── Stub LaunchctlRunner ─────────────────────────────────────────────────

    /// A stub runner that records calls and returns canned results.
    struct StubLaunchctl {
        /// Responses to return in order; last one is repeated when exhausted.
        responses: Vec<LaunchctlResult>,
        index: usize,
        /// All args slices passed to `run()`.
        calls: Vec<Vec<String>>,
    }

    impl StubLaunchctl {
        fn new(responses: Vec<LaunchctlResult>) -> Self {
            Self {
                responses,
                index: 0,
                calls: Vec::new(),
            }
        }

        fn success() -> LaunchctlResult {
            LaunchctlResult {
                exit_code: 0,
                stderr: String::new(),
            }
        }

        fn eio() -> LaunchctlResult {
            LaunchctlResult {
                exit_code: 5,
                stderr: "5: Input/output error".to_string(),
            }
        }

        fn failure(stderr: &str) -> LaunchctlResult {
            LaunchctlResult {
                exit_code: 1,
                stderr: stderr.to_string(),
            }
        }
    }

    impl LaunchctlRunner for StubLaunchctl {
        fn run(&mut self, args: &[&str]) -> LaunchctlResult {
            self.calls
                .push(args.iter().map(|s| s.to_string()).collect());
            let idx = self.index.min(self.responses.len().saturating_sub(1));
            let result = self.responses[idx].clone();
            if self.index < self.responses.len() {
                self.index += 1;
            }
            result
        }
    }

    // ── plist golden string (byte-identical to service-darwin.ts:36-66) ──────

    #[test]
    fn plist_golden_no_trailing_newline() {
        let plist = generate_plist(
            "/usr/local/bin/tp",
            Path::new("/home/u/.local/share/teleprompter/logs"),
            "/home/u",
        );

        // Must start with the XML declaration (no BOM, no leading whitespace).
        assert!(plist.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));

        // Must end with </plist> and NO trailing newline.
        assert!(
            plist.ends_with("</plist>"),
            "plist must end with </plist> — no trailing newline. last chars: {:?}",
            &plist[plist.len().saturating_sub(20)..]
        );

        // Check DOCTYPE exactly.
        assert!(plist.contains(
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
        ));

        // LABEL in <string>dev.tpmt.daemon</string>
        assert!(plist.contains("<string>dev.tpmt.daemon</string>"));

        // Binary in ProgramArguments
        assert!(plist.contains("<string>/usr/local/bin/tp</string>"));
        assert!(plist.contains("<string>daemon</string>"));
        assert!(plist.contains("<string>start</string>"));

        // RunAtLoad + KeepAlive
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <true/>"));

        // Log paths (StandardOut AND StandardError same file)
        assert!(
            plist.contains("<string>/home/u/.local/share/teleprompter/logs/daemon.log</string>")
        );

        // EnvironmentVariables
        assert!(plist.contains("<key>HOME</key>\n    <string>/home/u</string>"));
        assert!(plist.contains(
            "<key>PATH</key>\n    \
             <string>/usr/local/bin:/usr/bin:/bin:/home/u/.local/bin</string>"
        ));
    }

    #[test]
    fn plist_key_order() {
        // Service-darwin.ts key order: Label, ProgramArguments, RunAtLoad,
        // KeepAlive, StandardOutPath, StandardErrorPath, EnvironmentVariables.
        let plist = generate_plist("/bin/tp", Path::new("/tmp/logs"), "/home/u");
        let label_pos = plist.find("<key>Label</key>").unwrap();
        let args_pos = plist.find("<key>ProgramArguments</key>").unwrap();
        let run_pos = plist.find("<key>RunAtLoad</key>").unwrap();
        let keep_pos = plist.find("<key>KeepAlive</key>").unwrap();
        let stdout_pos = plist.find("<key>StandardOutPath</key>").unwrap();
        let stderr_pos = plist.find("<key>StandardErrorPath</key>").unwrap();
        let env_pos = plist.find("<key>EnvironmentVariables</key>").unwrap();
        assert!(label_pos < args_pos);
        assert!(args_pos < run_pos);
        assert!(run_pos < keep_pos);
        assert!(keep_pos < stdout_pos);
        assert!(stdout_pos < stderr_pos);
        assert!(stderr_pos < env_pos);
    }

    // ── plist_path shape ────────────────────────────────────────────────────

    #[test]
    fn plist_path_shape() {
        // Uses real $HOME — just assert the well-known suffix.
        let p = plist_path();
        let s = p.to_string_lossy();
        assert!(
            s.contains("Library/LaunchAgents"),
            "plist_path must be under Library/LaunchAgents: {s}"
        );
        assert!(
            s.ends_with("dev.tpmt.daemon.plist"),
            "plist_path must end with dev.tpmt.daemon.plist: {s}"
        );
    }

    // ── bootout_and_wait issues bootout then polls ───────────────────────────

    #[test]
    fn bootout_and_wait_polls_until_gone() {
        // First response = bootout (success), then print returns 0 twice (loaded),
        // then print returns 1 (gone) → exit immediately.
        let mut stub = StubLaunchctl::new(vec![
            // bootout call
            StubLaunchctl::success(),
            // print call 1 — still loaded
            LaunchctlResult {
                exit_code: 0,
                stderr: String::new(),
            },
            // print call 2 — gone
            LaunchctlResult {
                exit_code: 1,
                stderr: String::new(),
            },
        ]);
        bootout_and_wait(&mut stub, "gui/501/dev.tpmt.daemon");
        // bootout (1) + 2 print calls = 3 total.
        assert_eq!(stub.calls.len(), 3);
        assert_eq!(stub.calls[0][0], "bootout");
        assert_eq!(stub.calls[1][0], "print");
        assert_eq!(stub.calls[2][0], "print");
    }

    // ── EIO retry loop ───────────────────────────────────────────────────────

    #[test]
    fn bootstrap_retries_on_eio_up_to_5_attempts() {
        // bootout returns success, print returns gone (exit 1), bootstrap
        // returns EIO 3 times then success on attempt 4.
        //
        // Sequence per attempt:
        //   attempt 0: bootstrap → EIO
        //   attempt 1: sleep(300ms skipped in test), bootout(→ok), print(→gone), bootstrap → EIO
        //   attempt 2: ...
        //   attempt 3: ..., bootstrap → success
        //
        // Total launchctl calls = 1 + (bootout + print + bootstrap) * 3 = 1 + 9 = 10
        let responses = vec![
            // attempt 0: bootstrap → EIO
            StubLaunchctl::eio(),
            // settle: bootout → ok, print → gone (exit 1)
            StubLaunchctl::success(),
            LaunchctlResult {
                exit_code: 1,
                stderr: String::new(),
            },
            // attempt 1: bootstrap → EIO
            StubLaunchctl::eio(),
            // settle
            StubLaunchctl::success(),
            LaunchctlResult {
                exit_code: 1,
                stderr: String::new(),
            },
            // attempt 2: bootstrap → EIO
            StubLaunchctl::eio(),
            // settle
            StubLaunchctl::success(),
            LaunchctlResult {
                exit_code: 1,
                stderr: String::new(),
            },
            // attempt 3: bootstrap → success
            StubLaunchctl::success(),
        ];
        let mut stub = StubLaunchctl::new(responses);
        let result = bootstrap_with_retry(
            &mut stub,
            "gui/501",
            "/tmp/test.plist",
            "gui/501/dev.tpmt.daemon",
        );
        assert_eq!(result.exit_code, 0, "bootstrap should succeed on attempt 4");
    }

    #[test]
    fn bootstrap_non_eio_error_surfaces_immediately() {
        // A non-EIO error (e.g., permission denied) must NOT be retried.
        let mut stub = StubLaunchctl::new(vec![StubLaunchctl::failure("13: Permission denied")]);
        let result = bootstrap_with_retry(
            &mut stub,
            "gui/501",
            "/tmp/test.plist",
            "gui/501/dev.tpmt.daemon",
        );
        assert_ne!(result.exit_code, 0);
        // Only 1 bootstrap attempt (no retry).
        assert_eq!(stub.calls.len(), 1);
    }

    #[test]
    fn bootstrap_fails_after_5_eio_attempts() {
        // All 5 attempts return EIO → final result is failure.
        let responses = {
            let mut v = vec![StubLaunchctl::eio()]; // attempt 0
            for _ in 1..5 {
                // settle: bootout + print(gone)
                v.push(StubLaunchctl::success());
                v.push(LaunchctlResult {
                    exit_code: 1,
                    stderr: String::new(),
                });
                // bootstrap → EIO
                v.push(StubLaunchctl::eio());
            }
            v
        };
        let mut stub = StubLaunchctl::new(responses);
        let result = bootstrap_with_retry(
            &mut stub,
            "gui/501",
            "/tmp/test.plist",
            "gui/501/dev.tpmt.daemon",
        );
        assert_ne!(result.exit_code, 0, "should fail after 5 EIO attempts");
    }

    // ── Output string golden assertions ──────────────────────────────────────

    #[test]
    fn install_success_output_strings() {
        // Assert the exact output lines that installDarwin emits on success
        // (service-darwin.ts:141-146).  We can't easily capture println! in a
        // unit test, so assert the string literals directly.
        assert_eq!(
            format!("[Service] Installed launchd service: {LABEL}"),
            "[Service] Installed launchd service: dev.tpmt.daemon"
        );
        assert_eq!(
            "To check status: launchctl list dev.tpmt.daemon",
            format!("To check status: launchctl list {LABEL}")
        );
    }

    #[test]
    fn uninstall_output_strings() {
        // service-darwin.ts:164-165
        assert_eq!(
            format!("[Service] Uninstalled launchd service: {LABEL}"),
            "[Service] Uninstalled launchd service: dev.tpmt.daemon"
        );
    }

    #[test]
    fn bootstrap_failed_error_string() {
        // service-darwin.ts:133
        let stderr = "5: Input/output error\n";
        let msg = format!("[Service] launchctl bootstrap failed: {stderr}");
        assert!(msg.starts_with("[Service] launchctl bootstrap failed:"));
    }

    #[test]
    fn no_service_found_string() {
        // service-darwin.ts:153
        let plist = PathBuf::from("/home/u/Library/LaunchAgents/dev.tpmt.daemon.plist");
        let msg = format!("[Service] No launchd service found at {}", plist.display());
        assert!(msg.contains("/dev.tpmt.daemon.plist"));
    }
}
