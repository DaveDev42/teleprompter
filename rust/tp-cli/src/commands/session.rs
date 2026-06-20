//! `tp session list` — list saved sessions.
//!
//! Byte-exact port of `apps/cli/src/commands/session.ts` `sessionList`
//! (lines 111-154). Reads the Store directly; empty store prints "No sessions.".
//! Otherwise a fixed-width SID/STATE/CWD/UPDATED table (column widths =
//! max(header, values); cwd = `worktree_path` ?? cwd; UPDATED = `format_age`).

use std::process::ExitCode;

use crate::format::format_age;
use crate::store::list_sessions;
use crate::util::now_ms;

struct Row {
    sid: String,
    state: String,
    cwd: String,
    age: String,
}

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
    use super::pad_end;

    #[test]
    fn pad_end_matches_js() {
        assert_eq!(pad_end("SID", 5), "SID  ");
        assert_eq!(pad_end("abc", 3), "abc");
        assert_eq!(pad_end("toolong", 3), "toolong"); // no truncation
    }
}
