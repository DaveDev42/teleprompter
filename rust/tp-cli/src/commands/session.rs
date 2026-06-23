//! `tp session list`, `tp session delete`, `tp session prune`, and
//! `tp session cleanup` — session management commands.
//!
//! Byte-exact ports of `apps/cli/src/commands/session.ts` and
//! `apps/cli/src/commands/session-cleanup.tsx`:
//!   - `sessionList`    (session.ts:111-154): reads Store directly.
//!   - `sessionDelete`  (session.ts:156-271): 2-tier prefix match, TTY/non-TTY
//!     confirmation gate, IPC request via daemon. No SQLite-write fallback
//!     (A2.4 #2: writes require daemon-up).
//!   - `sessionPrune`   (session.ts:274-489): age filter, confirmation gates,
//!     IPC request via daemon. Daemon-up required (A2.4 #2).
//!   - `sessionCleanup` (session-cleanup.tsx:209-336): interactive multi-select
//!     TUI (crossterm raw mode) for bulk-deleting stopped sessions.
//!
//! # Daemon-up divergence from Bun (`session cleanup`)
//!
//! The Bun reference (`session-cleanup.tsx:294-312`) has a daemon-less fallback:
//! when the daemon is NOT running, it opens `SQLite` directly and calls
//! `store.deleteSession(sid)` per selected sid. This CLI port (ADR-0003 A2.4 #2)
//! does NOT replicate that fallback — all session writes must go through the
//! running daemon over IPC. If the daemon is down, `cleanup` errors out with the
//! standard guidance. This divergence is intentional and documented here because
//! it is the ONLY observable behavioral difference between the Bun and Rust
//! implementations of this command.

use std::cmp::Reverse;
use std::io::{self, IsTerminal as _, Write as _};
use std::path::Path;
use std::process::ExitCode;

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use tp_proto::ipc::{AgeFilter, IpcMessage};

use crate::colors::{dim, green, red, yellow};
use crate::format::format_age;
use crate::ipc_client::{match_sessions, parse_duration, request, MatchResult};
use crate::socket::is_daemon_running;
use crate::store::list_sessions;
use crate::tui::raw_mode::RawModeGuard;
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
        // Bounded retry loop (max 3 attempts) for parity with the Ink validate
        // callback which keeps the input field open on wrong input.
        if include_running {
            const MAX_ATTEMPTS: u8 = 3;
            let mut confirmed = false;
            for attempt in 1..=MAX_ATTEMPTS {
                let challenge_q = format!(
                    "{} Type 'RUNNING' to confirm (attempt {attempt}/{MAX_ATTEMPTS}):",
                    yellow("This will KILL running Claude sessions.")
                );
                match prompt_text(&challenge_q) {
                    Some(s) if s.trim() == "RUNNING" => {
                        confirmed = true;
                        break;
                    }
                    None => {
                        // EOF on stdin — no point retrying.
                        println!("Aborted.");
                        return ExitCode::SUCCESS;
                    }
                    _ => {
                        eprintln!("Type RUNNING exactly to confirm.");
                    }
                }
            }
            if !confirmed {
                println!("Aborted.");
                return ExitCode::SUCCESS;
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
// `tp session cleanup [-y] [--all]`
// ---------------------------------------------------------------------------

/// Minimal session row used in the TUI (the fields visible in the list).
struct CleanupRow {
    sid: String,
    /// `worktree_path` if set, else `cwd` (mirrors session-cleanup.tsx:232-236).
    cwd_base: String,
    /// Formatted age string (e.g. "3m ago").
    age: String,
}

/// TUI state for the multi-select list.
struct TuiState {
    cursor: usize,
    /// Indices (into `rows`) of selected entries.
    selected: std::collections::HashSet<usize>,
    rows: Vec<CleanupRow>,
}

impl TuiState {
    fn new(rows: Vec<CleanupRow>, preselect_all: bool) -> Self {
        let selected = if preselect_all {
            (0..rows.len()).collect()
        } else {
            std::collections::HashSet::new()
        };
        Self {
            cursor: 0,
            selected,
            rows,
        }
    }

    /// Move cursor up (clamp at 0). Mirrors `Math.max(0, c - 1)`.
    pub fn move_up(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
    }

    /// Move cursor down (clamp at last row). Mirrors `Math.min(len-1, c+1)`.
    pub fn move_down(&mut self) {
        if self.cursor + 1 < self.rows.len() {
            self.cursor += 1;
        }
    }

    /// Toggle selection of the row under the cursor.
    /// Mirrors the `Space` handler in session-cleanup.tsx:82-95.
    pub fn toggle_current(&mut self) {
        let idx = self.cursor;
        if self.selected.contains(&idx) {
            self.selected.remove(&idx);
        } else {
            self.selected.insert(idx);
        }
    }

    /// Toggle-all: if all are selected → clear; else select all.
    /// Mirrors the `a` handler in session-cleanup.tsx:98-106.
    pub fn toggle_all(&mut self) {
        if self.selected.len() == self.rows.len() {
            self.selected.clear();
        } else {
            self.selected = (0..self.rows.len()).collect();
        }
    }

    /// Collect the sids of selected rows, in display order (stable over toggle).
    pub fn selected_sids(&self) -> Vec<String> {
        let mut indices: Vec<usize> = self.selected.iter().copied().collect();
        indices.sort_unstable();
        indices
            .into_iter()
            .map(|i| self.rows[i].sid.clone())
            .collect()
    }
}

/// Render the full multi-select TUI to stdout.
///
/// Layout mirrors `session-cleanup.tsx` `MultiSelectApp` (lines 115-164):
///   - Header line (bold instruction text, approximated with ANSI bold)
///   - One row per session: cursor "> "/" ", checkbox "[x]"/"[ ]", sid, cwd, age
///   - Footer: "N selected / M total"
///
/// Colors:
///   - cursor marker + active sid+cwd: cyan (ANSI 36)
///   - selected checkbox: green (ANSI 32)
///   - unselected checkbox: gray/dim (ANSI 90)
///   - inactive cwd: dim (ANSI 90)
///   - age: dim (ANSI 90)
///
/// The Ink layout engine produces slightly different byte sequences (React
/// virtual DOM), so we match functionally (same visible content + colors) rather
/// than byte-identically for the TUI screen.
fn render_tui(state: &TuiState) {
    use std::fmt::Write as FmtWrite;

    // We build the entire frame into a single String and write it in one call
    // to avoid interleaved partial writes. Each render clears the previously
    // drawn frame first (cursor-up N+2 lines then clear-to-bottom).
    let n_rows = state.rows.len();
    // Lines drawn: 1 header + n_rows rows + 1 blank + 1 footer = n_rows + 3.
    let total_lines = n_rows + 3;

    let mut out = String::with_capacity(total_lines * 80);

    // Move cursor up to the top of our frame (after the first render we use
    // the saved number of lines). We always draw `total_lines` so this is
    // stable across renders.
    // \x1b[<N>A = cursor up N lines, \x1b[J = erase from cursor to end of screen.
    let _ = write!(out, "\x1b[{total_lines}A\x1b[J");

    // Header (bold).
    let _ = writeln!(
        out,
        "\x1b[1mSelect stopped sessions to delete (space toggle, a toggle all, Enter confirm, Esc cancel)\x1b[0m"
    );

    for (i, row) in state.rows.iter().enumerate() {
        let is_cursor = i == state.cursor;
        let is_selected = state.selected.contains(&i);

        // Cursor column: ">" in cyan, or " ".
        let cursor_col = if is_cursor { "\x1b[36m>\x1b[0m" } else { " " };

        // Checkbox: "[x]" in green or "[ ]" in gray.
        let checkbox = if is_selected {
            "\x1b[32m[x]\x1b[0m"
        } else {
            "\x1b[90m[ ]\x1b[0m"
        };

        // SID (first 20 chars, padded to 20). Active = cyan+bold, inactive = default.
        let sid_short = pad_end_chars(&row.sid.chars().take(20).collect::<String>(), 20);
        let sid_col = if is_cursor {
            format!("\x1b[36;1m{sid_short}\x1b[0m")
        } else {
            sid_short
        };

        // CWD basename (first 24 chars, padded to 24). Active = cyan, inactive = dim.
        let cwd_short = pad_end_chars(&row.cwd_base.chars().take(24).collect::<String>(), 24);
        let cwd_col = if is_cursor {
            format!("\x1b[36m{cwd_short}\x1b[0m")
        } else {
            format!("\x1b[90m{cwd_short}\x1b[0m")
        };

        // Age: always gray.
        let age_col = format!("\x1b[90m{}\x1b[0m", row.age);

        let _ = writeln!(out, "{cursor_col} {checkbox} {sid_col} {cwd_col} {age_col}");
    }

    // Blank line + footer (gray).
    let _ = writeln!(out);
    let _ = write!(
        out,
        "\x1b[90m{} selected / {} total\x1b[0m",
        state.selected.len(),
        state.rows.len()
    );

    let _ = io::stdout().write_all(out.as_bytes());
    let _ = io::stdout().flush();
}

/// Draw the initial frame (no cursor-up — just emit the lines).
/// Called once before the event loop; subsequent renders use `render_tui` which
/// cursor-ups back to the top of the frame.
fn render_tui_initial(state: &TuiState) {
    use std::fmt::Write as FmtWrite;

    let n_rows = state.rows.len();
    let total_lines = n_rows + 3;
    let mut out = String::with_capacity(total_lines * 80);

    // Header.
    let _ = writeln!(
        out,
        "\x1b[1mSelect stopped sessions to delete (space toggle, a toggle all, Enter confirm, Esc cancel)\x1b[0m"
    );

    for (i, row) in state.rows.iter().enumerate() {
        let is_cursor = i == state.cursor;
        let is_selected = state.selected.contains(&i);

        let cursor_col = if is_cursor { "\x1b[36m>\x1b[0m" } else { " " };
        let checkbox = if is_selected {
            "\x1b[32m[x]\x1b[0m"
        } else {
            "\x1b[90m[ ]\x1b[0m"
        };
        let sid_short = pad_end_chars(&row.sid.chars().take(20).collect::<String>(), 20);
        let sid_col = if is_cursor {
            format!("\x1b[36;1m{sid_short}\x1b[0m")
        } else {
            sid_short
        };
        let cwd_short = pad_end_chars(&row.cwd_base.chars().take(24).collect::<String>(), 24);
        let cwd_col = if is_cursor {
            format!("\x1b[36m{cwd_short}\x1b[0m")
        } else {
            format!("\x1b[90m{cwd_short}\x1b[0m")
        };
        let age_col = format!("\x1b[90m{}\x1b[0m", row.age);

        let _ = writeln!(out, "{cursor_col} {checkbox} {sid_col} {cwd_col} {age_col}");
    }

    let _ = writeln!(out);
    let _ = write!(
        out,
        "\x1b[90m{} selected / {} total\x1b[0m",
        state.selected.len(),
        state.rows.len()
    );

    let _ = io::stdout().write_all(out.as_bytes());
    let _ = io::stdout().flush();
}

/// Pad a string to `width` measured in Unicode scalar values (chars), appending
/// spaces. Mirrors `String.padEnd` for the sid/cwd columns.
fn pad_end_chars(s: &str, width: usize) -> String {
    let char_count = s.chars().count();
    if char_count >= width {
        s.to_string()
    } else {
        let mut out = String::with_capacity(s.len() + (width - char_count));
        out.push_str(s);
        for _ in 0..(width - char_count) {
            out.push(' ');
        }
        out
    }
}

/// `tp session cleanup [-y] [--all]` — interactive multi-select bulk delete
/// for stopped sessions.
///
/// Byte-exact port of `runSessionCleanup`
/// (`apps/cli/src/commands/session-cleanup.tsx:209-336`).
///
/// # Non-interactive paths (byte-parity with Bun)
///
/// The following output lines are byte-identical to the Bun reference (ANSI
/// escapes included when `NO_COLOR` is not set):
///
///  - Non-TTY guard error → stderr + exit 1 (tsx:214-221)
///  - Empty session list → stdout "No stopped sessions to clean up." + exit 0 (tsx:241-244)
///  - Cancel (Esc/Ctrl+C) → stdout "Aborted." + exit 130 (tsx:272-275)
///  - 0 selected → stdout "No sessions selected." + exit 0 (tsx:277-280)
///  - Confirmation declined → stdout "Aborted." + exit 0 (tsx:285-291)
///  - Delete summary → stdout ok("Deleted N session(s):") + sids (tsx:322-325)
///  - Failure summary → stderr fail("Failed to delete N session(s):") + sids (tsx:327-333)
///
/// # Daemon-up divergence
///
/// The Bun reference falls back to direct `SQLite` writes when the daemon is not
/// running (tsx:300-312). This port requires the daemon to be up (A2.4 #2).
/// See the module-level doc for the full rationale.
pub fn cleanup(yes: bool, preselect_all: bool) -> ExitCode {
    // Non-TTY guard (tsx:214-221): both stdin AND stdout must be TTYs.
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        let msg = fail(
            "tp session cleanup is interactive; use 'tp session prune' for non-interactive bulk delete",
        );
        eprintln!("{msg}");
        return ExitCode::from(1);
    }

    // Fetch stopped sessions from Store (tsx:225-239).
    // Read-only Store access — daemon is NOT required for listing (same as
    // `session list`). Sort by updated_at DESC (newest first).
    let now = now_ms();

    // Build (updated_at, CleanupRow) pairs so we can sort before dropping the
    // timestamp (age is a rendered string and can't be reverse-sorted reliably).
    let mut stopped_with_ts: Vec<(i64, CleanupRow)> = list_sessions()
        .into_iter()
        .filter(|s| s.state == "stopped")
        .map(|s| {
            let updated_at = s.updated_at;
            let cwd_raw = s.worktree_path.unwrap_or(s.cwd);
            // basename equivalent: last path component, or the full path.
            let cwd_base = Path::new(&cwd_raw)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&cwd_raw)
                .to_string();
            let age = format_age(now - updated_at, now);
            (
                updated_at,
                CleanupRow {
                    sid: s.sid,
                    cwd_base,
                    age,
                },
            )
        })
        .collect();

    // Sort newest-first (tsx:230: `b.updated_at - a.updated_at`).
    stopped_with_ts.sort_unstable_by_key(|&(ts, _)| Reverse(ts));
    let stopped: Vec<CleanupRow> = stopped_with_ts.into_iter().map(|(_, row)| row).collect();

    // Empty guard (tsx:241-244).
    if stopped.is_empty() {
        println!("No stopped sessions to clean up.");
        return ExitCode::SUCCESS;
    }

    // Interactive TUI (tsx:246-270): raw mode, key event loop.
    let selected_sids: Vec<String>;
    let cancelled: bool;

    {
        // Enable raw mode — Drop guard restores the terminal on any exit.
        let _raw = match RawModeGuard::enable() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("{}", fail(&format!("Failed to enable raw mode: {e}")));
                return ExitCode::FAILURE;
            }
        };

        let mut state = TuiState::new(stopped, preselect_all);

        // Draw the initial frame (no cursor-up on the first draw).
        render_tui_initial(&state);

        // Emit a trailing newline so the footer line is fully visible.
        println!();

        let result = loop {
            // Read one key event (blocking).
            let Ok(ev) = event::read() else {
                break (true, Vec::new()); // treat read error as cancel
            };

            let Event::Key(key) = ev else {
                continue;
            };

            // Esc or Ctrl+C → cancel (tsx:64-67).
            if key.code == KeyCode::Esc
                || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
            {
                break (true, Vec::new());
            }

            // Up / 'k' → move cursor up (tsx:70-72).
            if key.code == KeyCode::Up || key.code == KeyCode::Char('k') {
                state.move_up();
                render_tui(&state);
                println!();
                continue;
            }

            // Down / 'j' → move cursor down (tsx:75-78).
            if key.code == KeyCode::Down || key.code == KeyCode::Char('j') {
                state.move_down();
                render_tui(&state);
                println!();
                continue;
            }

            // Space → toggle current (tsx:82-95).
            if key.code == KeyCode::Char(' ') {
                state.toggle_current();
                render_tui(&state);
                println!();
                continue;
            }

            // 'a' → toggle all (tsx:98-106).
            if key.code == KeyCode::Char('a') {
                state.toggle_all();
                render_tui(&state);
                println!();
                continue;
            }

            // Enter → confirm (tsx:109-112).
            if key.code == KeyCode::Enter {
                let sids = state.selected_sids();
                break (false, sids);
            }
        };

        // Raw mode guard drops here → terminal restored before any I/O below.
        cancelled = result.0;
        selected_sids = result.1;
        // Print a newline to move past the TUI frame (the footer had no \n).
        println!();
    }

    // Cancel path (tsx:272-275).
    if cancelled {
        println!("Aborted.");
        return ExitCode::from(130);
    }

    // Nothing selected (tsx:277-280).
    if selected_sids.is_empty() {
        println!("No sessions selected.");
        return ExitCode::SUCCESS;
    }

    // Confirmation gate — skip if --yes (tsx:283-291).
    if !yes {
        print!("Delete {} session(s)? [y/N] ", selected_sids.len());
        let _ = io::stdout().flush();
        let mut line = String::new();
        match io::stdin().read_line(&mut line) {
            Ok(0) | Err(_) => {
                println!("Aborted.");
                return ExitCode::SUCCESS;
            }
            Ok(_) => {}
        }
        let trimmed = line.trim().to_lowercase();
        if !matches!(trimmed.as_str(), "y" | "yes") {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }
    }

    // Daemon-up gate (A2.4 #2 — divergence from Bun's daemon-less fallback at
    // tsx:300-312; see module doc for rationale).
    if !is_daemon_running() {
        eprintln!(
            "{}",
            fail("Daemon is not running. Start it with `tp daemon start` or `tp daemon install`.")
        );
        return ExitCode::FAILURE;
    }

    // Delete each selected sid via IPC (tsx:294-320).
    let mut deleted: Vec<String> = Vec::new();
    let mut failed_items: Vec<(String, String)> = Vec::new();

    for sid in &selected_sids {
        let req = IpcMessage::SessionDelete { sid: sid.clone() };
        match request(&req) {
            Ok(IpcMessage::SessionDeleteOk { .. }) => {
                deleted.push(sid.clone());
            }
            Ok(IpcMessage::SessionDeleteErr {
                reason, message, ..
            }) => {
                // Mirrors tsx:184-188: "Delete failed: <reason>[  — <message>]"
                let reason_str = serde_json::to_value(reason)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| format!("{reason:?}"));
                let suffix = match &message {
                    Some(m) if !m.is_empty() => format!(" \u{2014} {m}"),
                    _ => String::new(),
                };
                failed_items.push((sid.clone(), format!("Delete failed: {reason_str}{suffix}")));
            }
            Err(e) => {
                failed_items.push((sid.clone(), e.to_string()));
            }
            Ok(other) => {
                failed_items.push((
                    sid.clone(),
                    format!("unexpected reply '{}'", other_discriminant(&other)),
                ));
            }
        }
    }

    // Summary (tsx:322-335).
    if !deleted.is_empty() {
        println!(
            "{}",
            ok_msg(&format!("Deleted {} session(s):", deleted.len()))
        );
        for sid in &deleted {
            println!("  {sid}");
        }
    }

    if !failed_items.is_empty() {
        eprintln!(
            "{}",
            fail(&format!(
                "Failed to delete {} session(s):",
                failed_items.len()
            ))
        );
        for (sid, err) in &failed_items {
            eprintln!("  {sid}: {err}");
        }
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// TTY interaction helpers
// ---------------------------------------------------------------------------

/// Interactive y/N prompt. Returns `true` iff the user entered "y" or "yes"
/// (case-insensitive). Default = No, matching `promptYesNo { defaultValue: false }`.
///
/// Output mirrors the Bun Ink `YesNoPrompt` component (yes-no-prompt.tsx:105):
///   `<question> [y/N] `   then reads one line.  No leading `? ` prefix.
fn prompt_yes_no(question: &str) -> bool {
    print!("{question} [y/N] ");
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
    print!("{question} ");
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

    // ── cleanup TUI pure-logic tests ──────────────────────────────────────────

    fn make_cleanup_rows(sids: &[&str]) -> Vec<CleanupRow> {
        sids.iter()
            .map(|&s| CleanupRow {
                sid: s.to_string(),
                cwd_base: "myproject".to_string(),
                age: "1m ago".to_string(),
            })
            .collect()
    }

    #[test]
    fn tui_state_preselect_all() {
        let rows = make_cleanup_rows(&["a", "b", "c"]);
        let state = TuiState::new(rows, true);
        // All 3 should be selected.
        assert_eq!(state.selected.len(), 3);
        assert!(state.selected.contains(&0));
        assert!(state.selected.contains(&1));
        assert!(state.selected.contains(&2));
    }

    #[test]
    fn tui_state_preselect_none() {
        let rows = make_cleanup_rows(&["a", "b", "c"]);
        let state = TuiState::new(rows, false);
        assert!(state.selected.is_empty());
    }

    #[test]
    fn tui_toggle_current_adds_and_removes() {
        let rows = make_cleanup_rows(&["a", "b"]);
        let mut state = TuiState::new(rows, false);
        // Toggle row 0 (cursor starts at 0).
        state.toggle_current();
        assert!(state.selected.contains(&0));
        // Toggle again → deselect.
        state.toggle_current();
        assert!(!state.selected.contains(&0));
    }

    #[test]
    fn tui_toggle_all_select_then_clear() {
        let rows = make_cleanup_rows(&["a", "b", "c"]);
        let mut state = TuiState::new(rows, false);
        // First toggle_all: none selected → select all.
        state.toggle_all();
        assert_eq!(state.selected.len(), 3);
        // Second toggle_all: all selected → clear.
        state.toggle_all();
        assert!(state.selected.is_empty());
    }

    #[test]
    fn tui_toggle_all_partial_to_all() {
        // If only some are selected, toggle_all selects ALL (tsx:100-103:
        // `if prev.size === sessions.length` → clear, else select all).
        let rows = make_cleanup_rows(&["a", "b", "c"]);
        let mut state = TuiState::new(rows, false);
        state.toggle_current(); // select row 0
        assert_eq!(state.selected.len(), 1);
        state.toggle_all(); // partial → select all
        assert_eq!(state.selected.len(), 3);
    }

    #[test]
    fn tui_cursor_nav_clamps() {
        let rows = make_cleanup_rows(&["a", "b", "c"]);
        let mut state = TuiState::new(rows, false);
        // Move up at top → stays at 0.
        state.move_up();
        assert_eq!(state.cursor, 0);
        // Move down twice → cursor at 2.
        state.move_down();
        state.move_down();
        assert_eq!(state.cursor, 2);
        // Move down at last → stays at 2.
        state.move_down();
        assert_eq!(state.cursor, 2);
    }

    #[test]
    fn tui_selected_sids_in_display_order() {
        // Select rows 2 and 0 in that order; selected_sids should be stable
        // (sorted by index, not insertion order).
        let rows = make_cleanup_rows(&["sid-a", "sid-b", "sid-c"]);
        let mut state = TuiState::new(rows, false);
        state.cursor = 2;
        state.toggle_current(); // select row 2 = "sid-c"
        state.cursor = 0;
        state.toggle_current(); // select row 0 = "sid-a"
        let sids = state.selected_sids();
        // Expected order: index 0 before index 2.
        assert_eq!(sids, vec!["sid-a", "sid-c"]);
    }

    #[test]
    fn pad_end_chars_matches_js_pad_end() {
        // Mirrors the sid (20) and cwd (24) columns used in render_tui.
        assert_eq!(pad_end_chars("abc", 5), "abc  ");
        assert_eq!(pad_end_chars("abcde", 5), "abcde");
        assert_eq!(pad_end_chars("toolong", 3), "toolong"); // no truncation
    }

    #[test]
    fn pad_end_chars_unicode() {
        // Non-ASCII: the char count (not byte count) must govern padding.
        let s = "日本語"; // 3 chars, 9 bytes
        let padded = pad_end_chars(s, 5);
        assert_eq!(padded.chars().count(), 5);
        assert!(padded.starts_with("日本語"));
    }
}
