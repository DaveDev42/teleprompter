//! Child-process management — binary resolution, daemon/runner spawn, SIGTERM
//! teardown.
//!
//! Binary resolution contract (harness always injects both env vars):
//!   1. `TP_DAEMON_BIN` / `TP_RUNNER_BIN` (empty == unset) — the harness builds
//!      the Rust binaries and pins the exact paths; the parity asserts then
//!      positively prove those paths served the run.
//!   2. Fallback: a sibling of the holder's own binary (`rust/target/<profile>/
//!      tp-daemon` next to `.../tp-e2e-holder`) for manual invocations.
//!      Missing sibling → loud die. NEVER `locate_tp_*()` — the dogfood
//!      prefix-tree is deliberately unreachable from the E2E sandbox.
//!
//! Children inherit the FULL env (isolated XDG_*, HOME, CLAUDE_CODE_OAUTH_TOKEN)
//! — the retired Bun holder's `LOG_LEVEL`/`TP_NO_AUTO_INSTALL` daemon overrides
//! are dropped (no matches in the Rust daemon).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::envcfg::env_nonempty;
use crate::out::{die, log};

/// PIDs the SIGINT/SIGTERM handler must tear down (runner first — it owns the
/// claude PTY — then the daemon).
#[derive(Default)]
pub struct Children {
    pub runner_pid: Option<u32>,
    pub daemon_pid: Option<u32>,
}

pub type SharedChildren = Arc<Mutex<Children>>;

fn resolve_bin(env_key: &str, sibling_name: &str) -> PathBuf {
    if let Some(p) = env_nonempty(env_key) {
        return PathBuf::from(p);
    }
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| p.parent().map(|d| d.join(sibling_name)));
    match sibling {
        Some(p) if p.exists() => p,
        _ => die(&format!(
            "{env_key} unset and no {sibling_name} beside the holder binary — \
             build it (cargo build --bin {sibling_name}) or set {env_key}"
        )),
    }
}

/// Spawn the isolated real daemon (Rust `tp-daemon` — the bin IS the daemon,
/// no subcommand). Stdio nulled; isolation rides entirely on the inherited env.
pub fn spawn_daemon(children: &SharedChildren) {
    let bin = resolve_bin("TP_DAEMON_BIN", "tp-daemon");
    let child = Command::new(&bin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(c) => {
            let pid = c.id();
            children.lock().expect("children mutex").daemon_pid = Some(pid);
            log(&format!("daemon spawned (pid {pid})"));
        }
        Err(err) => die(&format!("failed to spawn daemon {}: {err}", bin.display())),
    }
}

/// Spawn a real claude session as a standalone Rust `tp-runner` process wired
/// to the isolated daemon socket. `claude_args` land after `--` (forwarded to
/// claude verbatim). Returns the pid.
pub fn spawn_runner(
    children: &SharedChildren,
    sid: &str,
    cwd: &str,
    socket_path: &str,
    claude_args: &[&str],
) -> u32 {
    let bin = resolve_bin("TP_RUNNER_BIN", "tp-runner");
    let mut args: Vec<&str> = vec![
        "--sid",
        sid,
        "--cwd",
        cwd,
        "--socket-path",
        socket_path,
        "--",
    ];
    args.extend_from_slice(claude_args);
    let child = Command::new(&bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(c) => {
            let pid = c.id();
            children.lock().expect("children mutex").runner_pid = Some(pid);
            pid
        }
        Err(err) => die(&format!("failed to spawn runner {}: {err}", bin.display())),
    }
}

/// SIGTERM (not SIGKILL — the runner must tear down its claude PTY; Bun
/// `Subprocess.kill()` default parity) via rustix (workspace forbids `unsafe`).
fn send_sigterm(pid: u32) {
    #[allow(clippy::cast_possible_wrap)]
    let Some(rpid) = rustix::process::Pid::from_raw(pid as i32) else {
        return;
    };
    let _ = rustix::process::kill_process(rpid, rustix::process::Signal::TERM);
}

/// Teardown for the signal handler: runner first, then daemon. The embedded
/// relay dies with the process.
pub fn kill_children(children: &SharedChildren) {
    let guard = children.lock().expect("children mutex");
    if let Some(pid) = guard.runner_pid {
        send_sigterm(pid);
    }
    if let Some(pid) = guard.daemon_pid {
        send_sigterm(pid);
    }
}
