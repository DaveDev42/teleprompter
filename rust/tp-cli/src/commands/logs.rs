//! `tp logs [sid]` — byte-exact port of the retired Bun CLI's
//! `apps/cli/src/commands/logs.ts` (deleted in #5 PR6 #933 — visible in git
//! history). The behavioral notes and `logs.ts:*` line citations below
//! describe that now-deleted file as it stood at port time; they are kept as
//! historical provenance for the divergence rationale, not a claim that the
//! file still exists.
//!
//! # Behaviour
//!
//! **No `sid` given** (`logs.ts:20-34`):
//! - Zero sessions → stderr `"No sessions found."`, exit 1.
//! - Sessions present → stderr `"Usage: tp logs <sid>"`,
//!   `"Available sessions:"`, then per session:
//!   `"  <mark> <sid>  seq=<last_seq>  <state>"` where mark is `"●"` for
//!   running, `"○"` otherwise.  Exit 0.
//!
//! **`sid` given but not found** (`logs.ts:37-43`):
//! - stderr `"Session <sid> not found."`, exit 1.
//!
//! **`sid` found** (`logs.ts:45-91`):
//! - stderr `"Tailing session: <sid> (seq=<last_seq>)"`,
//!   `"Press Ctrl+C to stop.\n"` (the trailing newline is part of the string
//!   that Bun's `console.error` adds; we emit it inline then let `eprintln!`
//!   add another newline — see below).
//! - Initial drain then poll every 500 ms.
//! - `kind == "io"`: write raw payload bytes to stdout
//!   (`logs.ts:55-56`).  See UTF-8 decision below.
//! - `kind == "event"`: parse payload as JSON; format event metadata to
//!   stderr (`logs.ts:57-74`).
//! - SIGINT/SIGTERM: default OS termination exits 130. See signal decision
//!   below.
//!
//! # UTF-8 decoding of io payloads (`logs.ts:56`)
//!
//! Bun/Node `Buffer.from(r.payload).toString("utf-8")` performs **lossy**
//! UTF-8 decoding: invalid byte sequences are replaced with U+FFFD (the
//! standard WHATWG `TextDecoder` behaviour). We match this with
//! `String::from_utf8_lossy`, which replaces invalid bytes with U+FFFD
//! encoded as the 3-byte sequence `\xEF\xBF\xBD`.  In practice PTY output
//! is always valid UTF-8 (the daemon's collector passes it through), so the
//! two paths produce identical bytes for 100 % of real-world records.  The
//! theoretical divergence (multi-byte invalid sequences) is documented here
//! and deemed acceptable — grounded at `logs.ts:56`.
//!
//! # SIGINT exit code
//!
//! The retired Bun CLI installed a `process.on("SIGINT", shutdown)` handler
//! that called `process.exit(0)` (`logs.ts:81-85`), producing exit code 0.
//!
//! Rust's `unsafe_code = "forbid"` workspace lint prevents calling raw
//! `libc::signal` / `sigaction`.  Adding a signal-handling crate (`ctrlc`,
//! `signal-hook`) would be the correct solution but is out of scope for this
//! tranche.  The Rust process therefore exits with the OS-conventional code
//! **130** (128 + SIGINT=2) when the user presses Ctrl+C.  This is the one
//! documented acceptable divergence from the Bun reference.
//!
//! For SIGTERM the Bun handler also called `process.exit(0)`; Rust exits with
//! OS code **143** (128 + SIGTERM=15).  Same documented divergence.
//!
//! # Event-field divergences (both unreachable with real records)
//!
//! Two further, deliberately-bounded divergences in the `event` formatting
//! path, neither reachable with records the daemon actually writes:
//!
//! 1. **`last_assistant_message` coercion** (the retired `logs.ts:63-66`, #5
//!    PR6 — visible in git history). The Bun CLI guarded with JS truthiness
//!    (`if (event.last_assistant_message)`) then `String()`-coerced, so a
//!    falsy value (`""`, `0`, `false`) was skipped and a truthy non-string
//!    (number, object) was stringified. We use `.as_str()`, which yields `None`
//!    for every non-string JSON value (skipping it) and `Some("")` for an empty
//!    string (which would print a blank `  → ` line). The field was typed
//!    `string?` (the retired `packages/protocol/src/types/event.ts:28`, also
//!    deleted in #5 PR6) and is always a non-empty string in practice, so
//!    neither edge is reachable.
//!
//! 2. **Snippet truncation** (the retired `logs.ts:65`). Bun's `.slice(0, 200)`
//!    counted UTF-16 code units; our `.chars().take(200)` counts Unicode scalar
//!    values. They diverge only for supplementary-plane characters (emoji),
//!    where Bun counted a surrogate pair as 2 and we count it as 1. For
//!    BMP-only text — effectively all Claude output — the two are identical.

use std::{
    io::{self, Write},
    process::ExitCode,
    thread,
    time::Duration,
};

use crate::store;

// ---------------------------------------------------------------------------
// Time-of-day formatter
// ---------------------------------------------------------------------------

/// Format a millisecond UTC epoch as `"HH:MM:SS.mmm"` — the 12-character
/// slice that JS `new Date(ts).toISOString().slice(11, 23)` produces.
///
/// # Algorithm
///
/// All division is euclidean so negative epochs (impossible in practice —
/// timestamps come from `Date.now()` in the daemon) round toward negative
/// infinity, matching ECMAScript's date math.
///
/// This is a pure function (testable, no I/O, no allocations beyond the
/// returned `String`).  It mirrors the same civil/time-of-day approach that
/// `format.rs` uses for the date portion, deliberately avoiding a datetime
/// crate to keep the dep surface minimal.
pub fn format_time_of_day(epoch_ms: i64) -> String {
    // Total milliseconds since midnight on the epoch day.
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let ms = ms_of_day % 1000;
    let total_secs = ms_of_day / 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;
    format!("{hours:02}:{mins:02}:{secs:02}.{ms:03}")
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run `tp logs [sid]`. Mirrors `logsCommand` in `logs.ts`.
pub fn run(sid: Option<&str>) -> ExitCode {
    let Some(sid) = sid else {
        // No sid: list sessions then exit (logs.ts:20-34).
        return no_sid_listing();
    };

    // Look up the session in the meta DB (logs.ts:37-43).
    let session = store::get_session(sid);
    let Some(session) = session else {
        eprintln!("Session {sid} not found.");
        return ExitCode::FAILURE;
    };

    // Banner (mirrors the retired logs.ts:45-46).
    // The retired Bun CLI emitted:
    //   console.error(`Tailing session: ${sid} (seq=${session.last_seq})`);
    //   console.error("Press Ctrl+C to stop.\n");
    // The second console.error appended a newline itself (Node/Bun `console.error`
    // always adds \n), and the string literal already ended in \n — giving two
    // newlines total: one from the literal, one from console.error. We match
    // with eprintln! which adds one \n, and we embed one in the string.
    eprintln!(
        "Tailing session: {} (seq={})",
        session.sid, session.last_seq
    );
    eprintln!("Press Ctrl+C to stop.\n");

    // Polling loop (logs.ts:50-91): initial drain then every 500 ms.
    let mut last_seq: i64 = 0;

    loop {
        tick(sid, &mut last_seq);
        thread::sleep(Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Handle the no-sid case: list sessions or print "No sessions found."
/// Returns the appropriate exit code.
fn no_sid_listing() -> ExitCode {
    let sessions = store::list_sessions();
    if sessions.is_empty() {
        eprintln!("No sessions found.");
        return ExitCode::FAILURE;
    }
    eprintln!("Usage: tp logs <sid>");
    eprintln!("Available sessions:");
    for s in &sessions {
        let mark = if s.state == "running" { "●" } else { "○" };
        eprintln!("  {mark} {}  seq={}  {}", s.sid, s.last_seq, s.state);
    }
    ExitCode::SUCCESS
}

/// One tick of the polling loop: open the session DB, drain new records,
/// write io to stdout and event metadata to stderr, advance `last_seq`.
///
/// Mirrors the inner `tick()` closure at `logs.ts:50-77`.
fn tick(sid: &str, last_seq: &mut i64) {
    // Open the per-session DB. If absent (file not yet created by the daemon)
    // treat as empty — keep polling. Mirrors `logs.ts:52`: `if (!db) return`.
    let Some(conn) = store::open_session_db_readonly(sid) else {
        return;
    };

    let recs = store::records_from(&conn, *last_seq, 1000);

    let stdout = io::stdout();
    let mut out = stdout.lock();

    for r in recs {
        match r.kind.as_str() {
            "io" => {
                // logs.ts:55-56:
                //   process.stdout.write(Buffer.from(r.payload).toString("utf-8"));
                //
                // Bun Buffer.toString("utf-8") is lossy (WHATWG TextDecoder):
                // invalid bytes → U+FFFD. We match with from_utf8_lossy.
                // See module-level doc comment for the full rationale.
                let _ = out.write_all(String::from_utf8_lossy(&r.payload).as_bytes());
            }
            "event" => {
                // logs.ts:57-73: parse JSON, extract name/ts/last_assistant_message/tool_name.
                // On JSON parse error: ignore the record (logs.ts:71-73).
                let text = String::from_utf8_lossy(&r.payload);
                let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) else {
                    // Ignore parse errors (logs.ts:71-73).
                    *last_seq = r.seq;
                    continue;
                };

                // logs.ts:60: `event.hook_event_name ?? event.name ?? "unknown"`
                let name = event["hook_event_name"]
                    .as_str()
                    .or_else(|| event["name"].as_str())
                    .unwrap_or("unknown");

                // logs.ts:61: `new Date(r.ts).toISOString().slice(11, 23)`
                let ts_str = format_time_of_day(r.ts);

                // logs.ts:62: console.error(`\n[${ts}] event ${name}`)
                eprintln!("\n[{ts_str}] event {name}");

                // logs.ts:63-66: if (event.last_assistant_message)
                if let Some(lam) = event["last_assistant_message"].as_str() {
                    let snippet: String = lam.chars().take(200).collect();
                    eprintln!("  → {snippet}");
                }

                // logs.ts:67-69: if (event.tool_name)
                if let Some(tool) = event["tool_name"].as_str() {
                    eprintln!("  tool: {tool}");
                }
            }
            _ => {
                // Unknown kind: skip (logs.ts only handles "io" and "event").
            }
        }
        *last_seq = r.seq;
    }

    let _ = out.flush();
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::format_time_of_day;

    /// Verify `format_time_of_day` against known epochs.
    ///
    /// All expected values cross-checked with:
    ///   `new Date(<epoch>).toISOString().slice(11, 23)`
    #[test]
    fn midnight_unix_epoch() {
        // 0 ms → 1970-01-01T00:00:00.000Z → slice(11,23) = "00:00:00.000"
        assert_eq!(format_time_of_day(0), "00:00:00.000");
    }

    #[test]
    fn milliseconds_only() {
        // 999 ms → "00:00:00.999"
        assert_eq!(format_time_of_day(999), "00:00:00.999");
    }

    #[test]
    fn one_second() {
        // 1000 ms → "00:00:01.000"
        assert_eq!(format_time_of_day(1_000), "00:00:01.000");
    }

    #[test]
    fn one_minute() {
        // 60_000 ms → "00:01:00.000"
        assert_eq!(format_time_of_day(60_000), "00:01:00.000");
    }

    #[test]
    fn one_hour() {
        // 3_600_000 ms → "01:00:00.000"
        assert_eq!(format_time_of_day(3_600_000), "01:00:00.000");
    }

    #[test]
    fn almost_midnight() {
        // 86_399_999 ms = 23:59:59.999
        assert_eq!(format_time_of_day(86_399_999), "23:59:59.999");
    }

    #[test]
    fn wraps_at_midnight() {
        // 86_400_000 ms = exactly one day → back to 00:00:00.000
        assert_eq!(format_time_of_day(86_400_000), "00:00:00.000");
    }

    #[test]
    fn real_world_epoch() {
        // 2026-06-17T14:30:05.123Z = 1_781_706_605_123 ms
        // JS: new Date(1781706605123).toISOString().slice(11,23) == "14:30:05.123"
        assert_eq!(format_time_of_day(1_781_706_605_123), "14:30:05.123");
    }

    #[test]
    fn another_real_epoch() {
        // 2024-01-15T09:07:30.456Z = 1_705_309_650_456 ms
        // JS: new Date(1705309650456).toISOString().slice(11,23) == "09:07:30.456"
        assert_eq!(format_time_of_day(1_705_309_650_456), "09:07:30.456");
    }

    #[test]
    fn midnight_boundary_multi_day() {
        // 1_000 days after epoch = 86_400_000_000 ms → time-of-day is 00:00:00.000
        assert_eq!(format_time_of_day(86_400_000_000), "00:00:00.000");
    }
}
