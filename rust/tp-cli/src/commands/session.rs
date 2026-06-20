//! `tp session list`, `tp session delete`, and `tp session prune` — session management commands.
//!
//! Byte-exact ports of `apps/cli/src/commands/session.ts`:
//!   - `sessionList`   (lines 111-154): reads Store directly.
//!   - `sessionDelete` (lines 156-271): 2-tier prefix match, TTY/non-TTY
//!     confirmation gate, IPC request via daemon. No SQLite-write fallback
//!     (A2.4 #2: writes require daemon-up).
//!   - `sessionPrune`  (lines 274-489): age filter, confirmation gates, IPC
//!     request via daemon. Daemon-up required (A2.4 #2).

use std::io::{self, IsTerminal as _, Write as _};
use std::process::ExitCode;

use tp_proto::ipc::{AgeFilter, IpcMessage};

use crate::colors::{dim, green, red, yellow};
use crate::format::format_age;
use crate::ipc_client::{match_sessions, parse_duration, request, MatchResult};
use crate::socket::is_daemon_running;
use crate::store::list_sessions;
use crate::util::now_ms;

struct Row {
    sid: String,
    state: String,
    cwd: String,
    age: String,
}

// ---------------------------------------------------------------------------
// `tp session list`
// ---------------------------------------------------------------------------

pub fn list() -> ExitCode {
    let sessions = list_sessions();

    if sessions.is_empty() {
        println!("No sessions.");
        return ExitCode::SUCCESS;
    }

    let now = now_ms();
    let rows: Vec<Row> = sessions
        .iter()
        .map(|s| Row {
            sid: s.sid.clone(),
            state: s.state.clone(),
            cwd: s.worktree_path.clone().unwrap_or_else(|| s.cwd.clone()),
            age: format_age(now - s.updated_at, now),
        })
        .collect();

    // Column widths: Math.max(headerLen, ...valueLens). The TS uses 3/5/3 as the
    // header-derived minimums ("SID"=3, "STATE"=5, "CWD"=3).
    let sid_w = rows
        .iter()
        .map(|r| r.sid.len())
        .chain([3])
        .max()
        .unwrap_or(3);
    let state_w = rows
        .iter()
        .map(|r| r.state.len())
        .chain([5])
        .max()
        .unwrap_or(5);
    let cwd_w = rows
        .iter()
        .map(|r| r.cwd.len())
        .chain([3])
        .max()
        .unwrap_or(3);

    println!(
        "{}  {}  {}  UPDATED",
        pad_end("SID", sid_w),
        pad_end("STATE", state_w),
        pad_end("CWD", cwd_w),
    );
    for r in &rows {
        println!(
            "{}  {}  {}  {}",
            pad_end(&r.sid, sid_w),
            pad_end(&r.state, state_w),
            pad_end(&r.cwd, cwd_w),
            r.age,
        );
    }
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// `tp session delete <sid> [-y]`
// ---------------------------------------------------------------------------

/// `tp session delete` — byte-exact port of `sessionDelete`
/// (`apps/cli/src/commands/session.ts:156-271`).
///
/// Flow (mirrors TS):
///  1. `list_sessions()` → `match_sessions(prefix)` — 0/ambiguous → stderr + exit 1.
///  2. Non-TTY without `--yes` → refuse on stderr + exit 1.
///  3. TTY without `--yes` → interactive y/N prompt (default No).
///  4. Daemon-up check. Down → stderr error + exit 1. No SQLite-write fallback (A2.4 #2).
///  5. IPC `session.delete` → print ok/wasRunning or err.
pub fn delete(prefix: &str, yes: bool) -> ExitCode {
    // 1. Prefix resolution (client-side, like the Bun CLI).
    let candidates = list_sessions();

    let target_sid: String = match match_sessions(&candidates, prefix) {
        MatchResult::None => {
            eprintln!("{}", fail(&format!("No session matches '{prefix}'.")));
            // Hint: list up to 20 known sids (mirrors TS lines 182-196).
            if !candidates.is_empty() {
                const MAX_HINT: usize = 20;
                eprintln!("{}", dim("Known sids:"));
                for c in candidates.iter().take(MAX_HINT) {
                    eprintln!("{}", dim(&format!("  {}", c.sid)));
                }
                if candidates.len() > MAX_HINT {
                    eprintln!(
                        "{}",
                        dim(&format!(
                            "  … {} more (run 'tp session list')",
                            candidates.len() - MAX_HINT
                        ))
                    );
                }
            }
            return ExitCode::FAILURE;
        }
        MatchResult::Ambiguous(matches) => {
            eprintln!(
                "{}",
                fail(&format!("Prefix '{prefix}' is ambiguous. Candidates:"))
            );
            for c in &matches {
                eprintln!("  {}", c.sid);
            }
            return ExitCode::FAILURE;
        }
        MatchResult::One(row) => row.sid.clone(),
    };

    // 2+3. Confirmation gate.
    if !yes {
        let stdin = io::stdin();
        if !stdin.is_terminal() {
            // Non-TTY without --yes: refuse (matches TS lines 218-222).
            eprintln!(
                "{}",
                fail("Refusing to delete without confirmation — pass --yes.")
            );
            return ExitCode::FAILURE;
        }
        // TTY: interactive y/N prompt (TS lines 224-232, `promptYesNo` default=false).
        print!("Delete session {}? [y/N] ", target_sid);
        let _ = io::stdout().flush();
        let mut line = String::new();
        match io::stdin().read_line(&mut line) {
            Ok(0) => {
                // EOF on TTY — treat as abort.
                println!("Aborted.");
                return ExitCode::SUCCESS;
            }
            Err(_) => {
                println!("Aborted.");
                return ExitCode::SUCCESS;
            }
            Ok(_) => {}
        }
        let trimmed = line.trim().to_lowercase();
        if trimmed != "y" && trimmed != "yes" {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }
    }

    // 4. Daemon-up gate (A2.4 #2: no SQLite-write fallback for write commands).
    if !is_daemon_running() {
        eprintln!(
            "{}",
            fail("Daemon is not running. Start it with `tp daemon start` or `tp daemon install`.")
        );
        return ExitCode::FAILURE;
    }

    // 5. IPC round-trip.
    let req = IpcMessage::SessionDelete {
        sid: target_sid.clone(),
    };
    match request(&req) {
        Err(e) => {
            eprintln!("{}", fail(&format!("Session delete failed: {e}")));
            ExitCode::FAILURE
        }
        Ok(IpcMessage::SessionDeleteErr {
            reason, message, ..
        }) => {
            // Serialize the reason enum to its wire string ("not-found" / "internal").
            let reason_str = serde_json::to_value(reason)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| format!("{reason:?}"));
            let suffix = match &message {
                Some(m) if !m.is_empty() => format!(" — {m}"),
                _ => String::new(),
            };
            eprintln!(
                "{}",
                fail(&format!("Session delete failed: {reason_str}{suffix}"))
            );
            ExitCode::FAILURE
        }
        Ok(IpcMessage::SessionDeleteOk { sid, was_running }) => {
            println!("{}", ok_msg(&format!("Deleted session {sid}")));
            if was_running {
                println!("{}", dim("Killed running runner before delete."));
            }
            ExitCode::SUCCESS
        }
        Ok(other) => {
            // Unexpected reply discriminant — surface it as a decode error.
            eprintln!(
                "{}",
                fail(&format!(
                    "Session delete failed: unexpected reply discriminant '{}'",
                    other_discriminant(&other)
                ))
            );
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// `tp session prune [--older-than <d>] [--all] [--running] [--dry-run] [-y]`
// ---------------------------------------------------------------------------

/// Options parsed from clap for `tp session prune`.
pub struct PruneOpts {
    /// `--older-than <Nd|Nh|Nm|Ns>` raw string (default "7d").
    pub older_than_raw: String,
    /// `--all` — AgeFilter::All, overrides `--older-than`.
    pub all: bool,
    /// `--running` — include running sessions (dangerous; requires typed challenge on TTY).
    pub running: bool,
    /// `--dry-run` — list candidates without deleting (never prompts).
    pub dry_run: bool,
    /// `-y` / `--yes` — skip all confirmation prompts.
    pub yes: bool,
}

/// Build the y/N confirmation question string.
///
/// Byte-exact port of `formatPruneQuestion` (session.ts:30-39).
/// With `--all` the scope reads "all"; otherwise "older than <raw>".
fn format_prune_question(all: bool, include_running: bool, older_than_raw: &str) -> String {
    let scope = if all {
        "all".to_string()
    } else {
        format!("older than {older_than_raw}")
    };
    if include_running {
        format!("Prune stopped + running sessions ({scope})?")
    } else {
        format!("Prune stopped sessions ({scope})?")
    }
}

/// `tp session prune` — byte-exact port of `sessionPrune` (session.ts:274-489).
///
/// Daemon-up required (ADR-0003 A2.4 #2). If the daemon is down we print the
/// standard guidance and exit 1.
pub fn prune(opts: PruneOpts) -> ExitCode {
    // --- Parse age filter (session.ts:297-307) ---
    let age = if opts.all {
        AgeFilter::All
    } else {
        match parse_duration(&opts.older_than_raw) {
            Ok(ms) => AgeFilter::OlderThan { ms },
            Err(msg) => {
                eprintln!("{}", fail(&msg));
                return ExitCode::FAILURE;
            }
        }
    };

    let include_running = opts.running;
    let dry_run = opts.dry_run;

    // --- Confirmation gates (session.ts:322-357) ---
    //
    // Priority:
    //   dry-run           → proceeds immediately, no prompt (read-only).
    //   --yes             → bypass all prompts.
    //   non-TTY, no --yes → refuse loudly, exit 1.
    //   TTY, no --yes     → y/N prompt; if --running also a typed "RUNNING" challenge.
    if !dry_run && !opts.yes {
        if !io::stdin().is_terminal() {
            // non-TTY without --yes (session.ts:323-329).
            let msg = if include_running {
                "Refusing to prune (including running) without --yes."
            } else {
                "Refusing to prune without --yes (use --dry-run to preview)."
            };
            eprintln!("{}", fail(msg));
            return ExitCode::FAILURE;
        }

        // TTY: y/N prompt (session.ts:334-346).
        let question = format_prune_question(opts.all, include_running, &opts.older_than_raw);
        if !prompt_yes_no(&question) {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }

        // Extra typed "RUNNING" challenge for --running (session.ts:347-357).
        if include_running {
            let challenge_q = format!(
                "{} Type 'RUNNING' to confirm:",
                yellow("This will KILL running Claude sessions.")
            );
            match prompt_text(&challenge_q) {
                Some(s) if s.trim() == "RUNNING" => {}
                _ => {
                    println!("Aborted.");
                    return ExitCode::SUCCESS;
                }
            }
        }
    }

    // --- Daemon-up gate (A2.4 #2) ---
    if !is_daemon_running() {
        eprintln!(
            "{}",
            fail("Daemon is not running. Start it with `tp daemon start` or `tp daemon install`.")
        );
        return ExitCode::FAILURE;
    }

    // --- IPC round-trip ---
    let req = IpcMessage::SessionPrune {
        age,
        include_running,
        dry_run,
    };

    let reply = match request(&req) {
        Ok(msg) => msg,
        Err(e) => {
            eprintln!("{}", fail(&e.to_string()));
            return ExitCode::FAILURE;
        }
    };

    match reply {
        // Success path (session.ts:465-488).
        IpcMessage::SessionPruneOk {
            sids,
            running_killed,
            dry_run: reply_dry_run,
        } => {
            if sids.is_empty() {
                println!("No sessions selected (0 matched).");
                return ExitCode::SUCCESS;
            }
            if reply_dry_run {
                println!("Would delete {} session(s) (dry-run):", sids.len());
                for sid in &sids {
                    println!("  {sid}");
                }
                return ExitCode::SUCCESS;
            }
            println!("{}", ok_msg(&format!("Pruned {} session(s):", sids.len())));
            for sid in &sids {
                println!("  {sid}");
            }
            if running_killed > 0 {
                // Daemon path: killed live runners (session.ts:480-483).
                println!(
                    "{}",
                    dim(&format!("Killed {running_killed} running runner(s)."))
                );
            }
            ExitCode::SUCCESS
        }

        // Error path (session.ts:375-398). The only reason variant is "internal".
        IpcMessage::SessionPruneErr {
            message,
            partial_sids,
            partial_running_killed,
            ..
        } => {
            let msg_suffix = match &message {
                Some(m) if !m.is_empty() => format!(" — {m}"),
                _ => String::new(),
            };
            eprintln!(
                "{}",
                fail(&format!("Session prune failed: internal{msg_suffix}"))
            );
            if !partial_sids.is_empty() {
                eprintln!(
                    "{}",
                    dim(&format!(
                        "Deleted {} session(s) before the error:",
                        partial_sids.len()
                    ))
                );
                for sid in &partial_sids {
                    eprintln!("{}", dim(&format!("  {sid}")));
                }
            }
            if partial_running_killed > 0 {
                eprintln!(
                    "{}",
                    dim(&format!(
                        "Killed {partial_running_killed} running runner(s)."
                    ))
                );
            }
            ExitCode::FAILURE
        }

        // Any unexpected discriminant.
        other => {
            eprintln!(
                "{}",
                fail(&format!(
                    "Session prune: unexpected reply '{}'",
                    other_discriminant(&other)
                ))
            );
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// TTY interaction helpers
// ---------------------------------------------------------------------------

/// Interactive y/N prompt. Returns `true` iff the user entered "y" or "yes"
/// (case-insensitive). Default = No, matching `promptYesNo { defaultValue: false }`.
///
/// Output mirrors the Bun Ink `YesNoPrompt` component:
///   `? <question> [y/N] `   then reads one line.
fn prompt_yes_no(question: &str) -> bool {
    print!("? {question} [y/N] ");
    let _ = io::stdout().flush();
    let mut line = String::new();
    if io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

/// Interactive text prompt. Returns the entered string (trailing CR/LF stripped),
/// or `None` on EOF / read error. Mirrors `promptText` (`text-prompt.tsx`).
fn prompt_text(question: &str) -> Option<String> {
    print!("? {question} ");
    let _ = io::stdout().flush();
    let mut line = String::new();
    match io::stdin().read_line(&mut line) {
        Ok(0) => None, // EOF
        Ok(_) => Some(
            line.trim_end_matches('\n')
                .trim_end_matches('\r')
                .to_string(),
        ),
        Err(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/// Quick discriminant string for unexpected reply messages (avoids a full Debug
/// impl dependency in the error path). Covers every `IpcMessage` variant so the
/// match stays exhaustive as new variants are added to tp-proto.
fn other_discriminant(msg: &IpcMessage) -> &'static str {
    match msg {
        IpcMessage::Hello { .. } => "hello",
        IpcMessage::Rec { .. } => "rec",
        IpcMessage::Bye { .. } => "bye",
        IpcMessage::Ack { .. } => "ack",
        IpcMessage::Input { .. } => "input",
        IpcMessage::Resize { .. } => "resize",
        IpcMessage::PairBegin { .. } => "pair.begin",
        IpcMessage::PairBeginOk { .. } => "pair.begin.ok",
        IpcMessage::PairBeginErr { .. } => "pair.begin.err",
        IpcMessage::PairCancel { .. } => "pair.cancel",
        IpcMessage::PairCompleted { .. } => "pair.completed",
        IpcMessage::PairCancelled { .. } => "pair.cancelled",
        IpcMessage::PairError { .. } => "pair.error",
        IpcMessage::PairRemove { .. } => "pair.remove",
        IpcMessage::PairRemoveOk { .. } => "pair.remove.ok",
        IpcMessage::PairRemoveErr { .. } => "pair.remove.err",
        IpcMessage::PairRename { .. } => "pair.rename",
        IpcMessage::PairRenameOk { .. } => "pair.rename.ok",
        IpcMessage::PairRenameErr { .. } => "pair.rename.err",
        IpcMessage::SessionDelete { .. } => "session.delete",
        IpcMessage::SessionDeleteOk { .. } => "session.delete.ok",
        IpcMessage::SessionDeleteErr { .. } => "session.delete.err",
        IpcMessage::SessionPrune { .. } => "session.prune",
        IpcMessage::SessionPruneOk { .. } => "session.prune.ok",
        IpcMessage::SessionPruneErr { .. } => "session.prune.err",
        IpcMessage::DoctorProbe => "doctor.probe",
        IpcMessage::DoctorProbeOk { .. } => "doctor.probe.ok",
    }
}

// ---------------------------------------------------------------------------
// Color helpers (mirrors colors.ts `ok` / `fail`)
// ---------------------------------------------------------------------------

/// `ok(msg)` = green("✓") + " " + msg  (colors.ts:18).
fn ok_msg(msg: &str) -> String {
    format!("{} {}", green("\u{2713}"), msg)
}

/// `fail(msg)` = red("✕") + " " + msg  (colors.ts:20).
fn fail(msg: &str) -> String {
    format!("{} {}", red("\u{2715}"), msg)
}

// ---------------------------------------------------------------------------

/// Right-pad `s` with spaces to `width` (JS `String.padEnd`). padEnd counts UTF-16
/// code units in JS; for the ASCII-dominant sid/state/cwd values this equals the
/// byte length. We pad by `char` count to stay correct for any non-ASCII path.
pub fn pad_end(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.to_string()
    } else {
        let mut out = String::with_capacity(s.len() + (width - len));
        out.push_str(s);
        out.push_str(&" ".repeat(width - len));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_end_matches_js() {
        assert_eq!(pad_end("SID", 5), "SID  ");
        assert_eq!(pad_end("abc", 3), "abc");
        assert_eq!(pad_end("toolong", 3), "toolong"); // no truncation
    }

    #[test]
    fn format_prune_question_stopped_older_than() {
        assert_eq!(
            format_prune_question(false, false, "7d"),
            "Prune stopped sessions (older than 7d)?"
        );
    }

    #[test]
    fn format_prune_question_all_flag() {
        // --all overrides older-than text (session.ts:35: scope = "all").
        assert_eq!(
            format_prune_question(true, false, "7d"),
            "Prune stopped sessions (all)?"
        );
    }

    #[test]
    fn format_prune_question_running() {
        assert_eq!(
            format_prune_question(false, true, "24h"),
            "Prune stopped + running sessions (older than 24h)?"
        );
    }

    #[test]
    fn format_prune_question_running_all() {
        assert_eq!(
            format_prune_question(true, true, "7d"),
            "Prune stopped + running sessions (all)?"
        );
    }
}
