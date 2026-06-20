//! `tp status` — daemon liveness + session list.
//!
//! Byte-exact port of `apps/cli/src/commands/status.ts`. Reads the Store
//! directly (source of truth regardless of whether the daemon is running) and
//! probes the IPC socket for liveness. Output: a "Daemon Status" block, the
//! background-daemon line (green "running" / dim "not running"), the session
//! count, then per-worktree groups with ●/○/✕ indicators and a "updated N ago"
//! line. Empty store prints "No active sessions." + start hints.

use std::process::ExitCode;

use crate::colors::{dim, green, red};
use crate::format::format_age;
use crate::socket::is_daemon_running;
use crate::store::{list_sessions, SessionRow};
use crate::util::now_ms;

pub fn run() -> ExitCode {
    let background_running = is_daemon_running();
    let sessions = list_sessions();
    display_status(&sessions, background_running);
    ExitCode::SUCCESS
}

fn display_status(sessions: &[SessionRow], background_running: bool) {
    println!();
    println!("Daemon Status");
    println!("─────────────");
    let daemon_state = if background_running {
        green("running")
    } else {
        dim("not running")
    };
    println!("Background daemon: {daemon_state}");
    println!("Sessions: {}", sessions.len());
    println!();

    if sessions.is_empty() {
        println!("No active sessions.");
        println!();
        println!("Start a session:");
        println!("  tp -p 'hello'                    # passthrough mode");
        println!("  tp daemon start --spawn --cwd .   # managed mode");
        return;
    }

    // Group by worktree_path ?? cwd, preserving first-seen order (Map insertion
    // order in the TS). We can't use a HashMap (loses order), so track keys in a
    // Vec alongside.
    let now = now_ms();
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<&SessionRow>> =
        std::collections::HashMap::new();
    for s in sessions {
        let key = s.worktree_path.clone().unwrap_or_else(|| s.cwd.clone());
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(s);
    }

    for path in &order {
        println!("  {path}");
        for s in &groups[path] {
            let indicator = match s.state.as_str() {
                "running" => green("●"),
                "stopped" => dim("○"),
                _ => red("✕"),
            };
            println!("    {indicator} {}  seq={}  {}", s.sid, s.last_seq, s.state);
            if let Some(ver) = &s.claude_version {
                println!("      claude {ver}");
            }
            let age = format_age(now - s.updated_at, now);
            println!("      updated {age}");
        }
        println!();
    }
}
