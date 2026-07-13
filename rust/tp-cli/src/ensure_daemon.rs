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
//! # First-run install prompt (PR-5, ported here)
//!
//! After a successful background spawn, `ensure_daemon()` runs the first-run
//! "Install daemon as an OS service? [Y/n]" flow — a native port of
//! `showInstallHint()` (`apps/cli/src/lib/ensure-daemon.ts:198-249`). An
//! interactive TTY gets the prompt; a non-interactive env (CI, pipes, or
//! `TP_NO_AUTO_INSTALL=1`) gets a one-time dim hint. Both paths stamp the
//! `.daemon-hint-shown` marker in the config dir so the prompt fires exactly
//! once. The pure decision (`decide_install_prompt_mode`) and the answer parser
//! (`parse_yes_no_answer`) are byte-exact ports of the Bun functions of the same
//! name and are unit-tested here.
//!
//! # Out of scope: `showFirstRunPairing` (deliberately NOT ported here)
//!
//! The Bun CLI has a *second*, distinct first-run flow — `showFirstRunPairing`
//! (`apps/cli/src/commands/passthrough.ts:332-370`) — that fires once ever
//! (gated on `store.listPairings().length === 0`, stamped by `.tp-initialized`)
//! and runs a welcome banner + full `tp pair` QR pairing + service install. It
//! is called from the Bun `passthroughCommand` entry (passthrough.ts:59), NOT
//! from `ensureDaemon`. Porting it into `ensure_daemon()` would be a behavior
//! change: `ensure_daemon()` runs on *every* daemon auto-spawn, so the welcome +
//! pairing flow would fire far more often than "first ever passthrough". It also
//! depends on a native interactive `tp pair` flow. This onboarding therefore
//! belongs with the native passthrough's own first-run handling (a separate,
//! larger port), not with the `showInstallHint` port here — recorded so the gap
//! isn't mistaken for an omission.

// `ensure_daemon()` is wired into the native passthrough handler by task #17
// PR-4 (`commands::passthrough::run`), which calls it to guarantee a service
// daemon is up before spawning the runner (Path A only — no ephemeral fallback).

use std::io::{BufRead, IsTerminal};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::colors::dim;
use crate::config_dir::config_dir;
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
        // First-run install prompt (PR-5): offer to register the OS service so
        // the daemon auto-starts on login, exactly like the Bun `showInstallHint()`
        // (ensure-daemon.ts:178). Best-effort — a prompt/marker hiccup must never
        // fail the daemon-ready path, so we ignore its result.
        show_install_hint();
        return Ok(true);
    }

    // Readiness timeout — not an error, just "couldn't bring it up in 10s".
    Ok(false)
}

// ---------------------------------------------------------------------------
// First-run install prompt (PR-5) — port of `showInstallHint` and friends
// (`apps/cli/src/lib/ensure-daemon.ts:192-390`).
// ---------------------------------------------------------------------------

/// Marker file stamped once the first-run hint/prompt has been shown, so it
/// never fires again. Mirrors `HINT_FILE` (ensure-daemon.ts:16):
/// `<configDir>/.daemon-hint-shown`.
fn hint_file() -> std::path::PathBuf {
    config_dir().join(".daemon-hint-shown")
}

/// Which branch `show_install_hint` should take. Byte-exact port of the Bun
/// `InstallPromptMode` union (ensure-daemon.ts:357).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum InstallPromptMode {
    /// Already hinted OR already installed — no output, no prompt.
    Skip,
    /// Non-interactive env — print the dim one-liner and stamp the file.
    Hint,
    /// Interactive — ask the user and act on the answer.
    Prompt,
}

/// Inputs to the gate decision. Parameterised (like the Bun
/// `InstallPromptInputs`, ensure-daemon.ts:365) so tests exercise every branch
/// without stubbing the live process.
struct InstallPromptInputs {
    hint_file_exists: bool,
    service_installed: bool,
    stdin_is_tty: bool,
    stderr_is_tty: bool,
    no_auto_install_env: bool,
}

/// Pure decision for the first-run install flow. Byte-exact port of
/// `decideInstallPromptMode` (ensure-daemon.ts:381-389):
///  - `Skip`   — already hinted OR already installed
///  - `Hint`   — non-interactive env; print the dim one-liner and stamp the file
///  - `Prompt` — interactive; ask the user and act on the answer
fn decide_install_prompt_mode(inputs: &InstallPromptInputs) -> InstallPromptMode {
    if inputs.hint_file_exists {
        return InstallPromptMode::Skip;
    }
    if inputs.service_installed {
        return InstallPromptMode::Skip;
    }
    let interactive = inputs.stdin_is_tty && inputs.stderr_is_tty && !inputs.no_auto_install_env;
    if interactive {
        InstallPromptMode::Prompt
    } else {
        InstallPromptMode::Hint
    }
}

/// Normalize a y/n response. Byte-exact port of `parseYesNoAnswer`
/// (ensure-daemon.ts:344-350). Rules, in order:
///  - empty / whitespace-only → `default_yes`
///  - starts with ASCII `n` → `false`
///  - starts with ASCII `y` → `true`
///  - anything else → `default_yes`
///
/// Starts-with matching favours declining over the default when the user
/// clearly typed something `n`-ish (safe direction for a system-service
/// install). Non-ASCII responses fall back to `default_yes` — the prompt is
/// English-only. `to_lowercase()` matches the JS `.toLowerCase()`; the
/// `starts_with` checks look at the lowercased ASCII `n`/`y` exactly as the
/// Bun code does (multi-byte leading chars won't collide with ASCII `n`/`y`).
fn parse_yes_no_answer(raw: &str, default_yes: bool) -> bool {
    let trimmed = raw.trim().to_lowercase();
    if trimmed.is_empty() {
        return default_yes;
    }
    if trimmed.starts_with('n') {
        return false;
    }
    if trimmed.starts_with('y') {
        return true;
    }
    default_yes
}

/// Read a single y/n answer from stdin. Port of `readYesNoLine`
/// (ensure-daemon.ts:294-321): resolves to the parsed first line
/// (`default_yes = true`), or `false` on EOF (Ctrl+D / closed pipe) — an
/// abnormal close is NOT implicit consent to install a system service. A read
/// error is likewise treated as a decline (`false`).
fn read_yes_no_line() -> bool {
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        // 0 bytes read = EOF with no newline → decline (mirrors the `end`/`close`
        // → false branch). A non-empty line parses normally.
        Ok(0) => false,
        Ok(_) => parse_yes_no_answer(&line, true),
        Err(_) => false,
    }
}

/// Stamp the marker file so the hint/prompt fires exactly once. Port of
/// `markHinted` (ensure-daemon.ts:251-258) — best-effort, failures are swallowed
/// (a missing marker just re-shows the hint next run, which is non-critical).
fn mark_hinted() {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    // The Bun code writes `new Date().toISOString()`; the content is never read
    // (only existence is checked), so a fixed marker byte is behaviorally
    // identical and avoids the forbidden `Date::now()` surface.
    let _ = std::fs::write(hint_file(), "shown\n");
}

/// First-run: offer to install the daemon as an OS service so it auto-starts on
/// login. Byte-exact behavioral port of `showInstallHint` (ensure-daemon.ts:198-249).
/// Best-effort throughout — never fails the caller.
fn show_install_hint() {
    let mode = decide_install_prompt_mode(&InstallPromptInputs {
        hint_file_exists: hint_file().exists(),
        service_installed: is_service_installed(),
        stdin_is_tty: std::io::stdin().is_terminal(),
        stderr_is_tty: std::io::stderr().is_terminal(),
        no_auto_install_env: std::env::var("TP_NO_AUTO_INSTALL").as_deref() == Ok("1"),
    });

    match mode {
        InstallPromptMode::Skip => {}
        InstallPromptMode::Hint => {
            // ensure-daemon.ts:210-212
            eprintln!(
                "{}",
                dim("Tip: Run 'tp daemon install' to start tp automatically on login.")
            );
            mark_hinted();
        }
        InstallPromptMode::Prompt => {
            // Context line so a first-run user understands the prompt
            // (ensure-daemon.ts:219-223).
            eprintln!(
                "{}",
                dim("tp daemon is now running in the background. It can also auto-start on login.")
            );
            // Prompt on stderr (all human output here goes to stderr, matching
            // the Bun `console.error` path), then read the answer from stdin.
            eprint!("Install daemon as an OS service so it auto-starts on login? [Y/n] ");
            let accepted = read_yes_no_line();
            mark_hinted();

            if !accepted {
                eprintln!(
                    "{}",
                    dim("Skipping. Run 'tp daemon install' later to enable auto-start.")
                );
                return;
            }

            // installService() equivalent — `commands::daemon::install_service_ok()`
            // is the exact dispatch target (install_darwin / install_linux), same
            // as the Bun `installService()` (service.ts:5-19). On failure it prints
            // its own `[Service] …` errors; we add the manual-install hint to mirror
            // the Bun catch (ensure-daemon.ts:240-247).
            if !crate::commands::daemon::install_service_ok() {
                eprintln!(
                    "{}",
                    dim("Service install failed. Run 'tp daemon install' manually.")
                );
            }
        }
    }
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

    // -----------------------------------------------------------------------
    // First-run install prompt (PR-5) — pure-decision + parser parity tests
    // (mirror `apps/cli/src/lib/ensure-daemon.test.ts` install-prompt cases).
    // -----------------------------------------------------------------------

    fn inputs(
        hint_file_exists: bool,
        service_installed: bool,
        stdin_is_tty: bool,
        stderr_is_tty: bool,
        no_auto_install_env: bool,
    ) -> InstallPromptInputs {
        InstallPromptInputs {
            hint_file_exists,
            service_installed,
            stdin_is_tty,
            stderr_is_tty,
            no_auto_install_env,
        }
    }

    #[test]
    fn decide_skip_when_already_hinted() {
        // hintFileExists short-circuits to Skip, regardless of TTY/env
        // (decideInstallPromptMode:384).
        assert_eq!(
            decide_install_prompt_mode(&inputs(true, false, true, true, false)),
            InstallPromptMode::Skip
        );
    }

    #[test]
    fn decide_skip_when_service_installed() {
        // serviceInstalled short-circuits to Skip (decideInstallPromptMode:385).
        assert_eq!(
            decide_install_prompt_mode(&inputs(false, true, true, true, false)),
            InstallPromptMode::Skip
        );
    }

    #[test]
    fn decide_prompt_when_interactive() {
        // stdin && stderr TTY && !noAutoInstall → Prompt (decideInstallPromptMode:386-388).
        assert_eq!(
            decide_install_prompt_mode(&inputs(false, false, true, true, false)),
            InstallPromptMode::Prompt
        );
    }

    #[test]
    fn decide_hint_when_non_tty() {
        // Missing either TTY → Hint (non-interactive).
        assert_eq!(
            decide_install_prompt_mode(&inputs(false, false, false, true, false)),
            InstallPromptMode::Hint
        );
        assert_eq!(
            decide_install_prompt_mode(&inputs(false, false, true, false, false)),
            InstallPromptMode::Hint
        );
    }

    #[test]
    fn decide_hint_when_no_auto_install_env_even_on_tty() {
        // TP_NO_AUTO_INSTALL=1 forces the hint path even on a full TTY
        // (the `!noAutoInstallEnv` term in `interactive`).
        assert_eq!(
            decide_install_prompt_mode(&inputs(false, false, true, true, true)),
            InstallPromptMode::Hint
        );
    }

    #[test]
    fn decide_skip_wins_over_no_auto_install() {
        // Skip gates (hint-file / installed) precede the interactive computation,
        // so they win even when TP_NO_AUTO_INSTALL is set.
        assert_eq!(
            decide_install_prompt_mode(&inputs(true, false, true, true, true)),
            InstallPromptMode::Skip
        );
    }

    #[test]
    fn parse_yes_no_empty_uses_default() {
        // empty / whitespace-only → default_yes (parseYesNoAnswer:346).
        assert!(parse_yes_no_answer("", true));
        assert!(!parse_yes_no_answer("", false));
        assert!(parse_yes_no_answer("   \t", true));
        assert!(!parse_yes_no_answer("  ", false));
        // A newline-only line (as read from stdin) trims to empty → default.
        assert!(parse_yes_no_answer("\n", true));
    }

    #[test]
    fn parse_yes_no_starts_with_n_is_false() {
        // starts with `n` → false, regardless of default (parseYesNoAnswer:347).
        assert!(!parse_yes_no_answer("n", true));
        assert!(!parse_yes_no_answer("no", true));
        assert!(!parse_yes_no_answer("Nope", true));
        assert!(!parse_yes_no_answer("  NAH  ", true));
        // Over-matching on `nil` is intentional (documented in the TS source).
        assert!(!parse_yes_no_answer("nil", true));
    }

    #[test]
    fn parse_yes_no_starts_with_y_is_true() {
        // starts with `y` → true, regardless of default (parseYesNoAnswer:348).
        assert!(parse_yes_no_answer("y", false));
        assert!(parse_yes_no_answer("YES", false));
        assert!(parse_yes_no_answer("Yep", false));
        assert!(parse_yes_no_answer("  yikes ", false));
    }

    #[test]
    fn parse_yes_no_other_uses_default() {
        // anything else → default_yes (parseYesNoAnswer:349).
        assert!(parse_yes_no_answer("maybe", true));
        assert!(!parse_yes_no_answer("maybe", false));
        assert!(parse_yes_no_answer("1", true));
        // Non-ASCII (아니요) falls back to default — the prompt is English-only.
        assert!(parse_yes_no_answer("아니요", true));
        assert!(!parse_yes_no_answer("아니요", false));
    }

    #[test]
    fn hint_file_is_under_config_dir() {
        // The marker lives at <configDir>/.daemon-hint-shown (HINT_FILE parity).
        let p = hint_file();
        assert_eq!(
            p.file_name().and_then(|s| s.to_str()),
            Some(".daemon-hint-shown")
        );
        assert_eq!(p.parent(), Some(config_dir().as_path()));
    }
}
