//! Blocking IPC client for CLI → daemon request/response.
//!
//! The Bun reference (`apps/cli/src/lib/daemon-op.ts` + `ipc-client.ts`)
//! connects to the daemon's Unix domain socket, writes one framed request, and
//! reads one framed response. We replicate that pattern with a synchronous
//! `UnixStream` (no async runtime needed for one-shot CLI ops):
//!
//!   connect → write framed request → read framed response → close
//!
//! Timeout: 30 s read timeout (`DAEMON_OP_TIMEOUT_MS = 30_000` in daemon-op.ts).
//!
//! Also contains the client-side prefix-resolution helpers that the write
//! commands need before sending an IPC request:
//!   - `match_pairings` — 5-tier priority (pair.ts:354-376)
//!   - `match_sessions` — 2-tier priority (session.ts:102-109)
//!   - `parse_duration`  — `7d`/`24h`/`30m`/`10s` → ms (session.ts:82-95)

use std::fmt;
use std::io::{self, Write as _};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use tp_proto::ipc::{parse_ipc_message, IpcMessage};

use crate::codec::{encode_frame, read_frame};
use crate::socket::{is_daemon_running, socket_path};
use crate::store::{PairingRow, SessionRow};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can occur during a CLI→daemon IPC round-trip.
#[derive(Debug)]
pub enum IpcError {
    /// The daemon socket does not exist or is not connectable.
    DaemonDown,
    /// The daemon accepted the connection but did not reply within 30 s.
    Timeout,
    /// Low-level I/O failure (connect, read, write).
    Io(io::Error),
    /// The response bytes were not valid JSON or not a recognised `IpcMessage`.
    Decode(String),
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DaemonDown => write!(
                f,
                "Daemon is not running. Start it with `tp daemon start` or `tp daemon install`."
            ),
            Self::Timeout => write!(
                f,
                "Daemon did not reply within 30s; try 'tp daemon status' or restart the daemon"
            ),
            Self::Io(e) => write!(f, "IPC I/O error: {e}"),
            Self::Decode(s) => write!(f, "IPC decode error: {s}"),
        }
    }
}

impl From<io::Error> for IpcError {
    fn from(e: io::Error) -> Self {
        // Map timeout-flavoured OS errors to the friendlier Timeout variant.
        if e.kind() == io::ErrorKind::TimedOut || e.kind() == io::ErrorKind::WouldBlock {
            Self::Timeout
        } else {
            Self::Io(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Core round-trip
// ---------------------------------------------------------------------------

/// Send one IPC request to the daemon and receive the single reply.
///
/// Flow: `is_daemon_running`? → connect → `set_read_timeout(30s)` → write frame
/// → read frame → parse → return.
///
/// The caller is responsible for checking that the returned `IpcMessage`
/// discriminant matches the expected reply type — different commands do this
/// themselves, consistent with the Bun `requestDaemonOp` `isExpected` guard.
pub fn request(req: &IpcMessage) -> Result<IpcMessage, IpcError> {
    // Guard: if the socket doesn't exist, bail with a clear message rather
    // than a confusing "No such file or directory" OS error.
    if !is_daemon_running() {
        return Err(IpcError::DaemonDown);
    }

    let path = socket_path();
    let mut stream = UnixStream::connect(&path)?;

    // 30 s read timeout — matches `DAEMON_OP_TIMEOUT_MS` in daemon-op.ts.
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;

    // Serialize and write the framed request.
    let json =
        serde_json::to_vec(req).map_err(|e| IpcError::Decode(format!("serialize request: {e}")))?;
    let frame = encode_frame(&json);
    stream.write_all(&frame).map_err(IpcError::Io)?;

    // Read one framed response.
    let response_bytes = read_frame(&mut stream)?;

    // Parse the raw JSON into an IpcMessage via tp-proto's hand-rolled guard.
    let raw: serde_json::Value = serde_json::from_slice(&response_bytes)
        .map_err(|e| IpcError::Decode(format!("parse JSON: {e}")))?;
    let msg = parse_ipc_message(&raw)
        .ok_or_else(|| IpcError::Decode(format!("unrecognised IPC discriminant: {raw}")))?;

    Ok(msg)
}

// ---------------------------------------------------------------------------
// Prefix-resolution result type
// ---------------------------------------------------------------------------

/// Result of a prefix-resolution match. Mirrors the tri-state the Bun CLI
/// surfaces: no match → error; exactly one match → proceed; multiple matches →
/// error with candidate list.
pub enum MatchResult<T> {
    /// No candidates matched the fragment.
    None,
    /// Exactly one candidate matched.
    One(T),
    /// More than one candidate matched (ambiguous prefix).
    Ambiguous(Vec<T>),
}

// ---------------------------------------------------------------------------
// Pairing matcher (5-tier priority, pair.ts:354-376)
// ---------------------------------------------------------------------------

/// Extract a pairing's display label as a nullable string. Normalises the
/// DB-stored `Option<String>` to `Option<&str>`, consistent with the Bun
/// `candidateLabel` helper (pair.ts:346-352) which calls `labelToNullable`.
fn candidate_label(row: &PairingRow) -> Option<&str> {
    row.label.as_deref()
}

/// Resolve a fragment against the pairing list using the same 5-tier priority
/// as `matchPairings` in `apps/cli/src/commands/pair.ts:354-376`:
///
/// 1. Exact `daemonId` match.
/// 2. Exact label match (case-insensitive).
/// 3. `daemonId` prefix match.
/// 4. `daemon-<fragment>` shorthand (exact `daemonId` = `"daemon-" + fragment`).
/// 5. Label substring match (case-insensitive).
///
/// Returns `MatchResult::None` / `One` / `Ambiguous` so callers can emit the
/// exact error text the Bun CLI would.
pub fn match_pairings<'a>(
    candidates: &'a [PairingRow],
    fragment: &str,
) -> MatchResult<&'a PairingRow> {
    // Tier 1: exact daemonId.
    let exact: Vec<_> = candidates
        .iter()
        .filter(|c| c.daemon_id == fragment)
        .collect();
    if !exact.is_empty() {
        return if exact.len() == 1 {
            MatchResult::One(exact[0])
        } else {
            MatchResult::Ambiguous(exact)
        };
    }

    // Tier 2: exact label match (case-insensitive).
    let frag_lower = fragment.to_lowercase();
    let label_exact: Vec<_> = candidates
        .iter()
        .filter(|c| candidate_label(c).is_some_and(|l| l.to_lowercase() == frag_lower))
        .collect();
    if !label_exact.is_empty() {
        return if label_exact.len() == 1 {
            MatchResult::One(label_exact[0])
        } else {
            MatchResult::Ambiguous(label_exact)
        };
    }

    // Tier 3: daemonId prefix.
    let prefix: Vec<_> = candidates
        .iter()
        .filter(|c| c.daemon_id.starts_with(fragment))
        .collect();
    if !prefix.is_empty() {
        return if prefix.len() == 1 {
            MatchResult::One(prefix[0])
        } else {
            MatchResult::Ambiguous(prefix)
        };
    }

    // Tier 4: "daemon-<fragment>" shorthand — exact daemonId.
    let shorthand = format!("daemon-{fragment}");
    let shorthand_matches: Vec<_> = candidates
        .iter()
        .filter(|c| c.daemon_id == shorthand)
        .collect();
    if !shorthand_matches.is_empty() {
        return if shorthand_matches.len() == 1 {
            MatchResult::One(shorthand_matches[0])
        } else {
            MatchResult::Ambiguous(shorthand_matches)
        };
    }

    // Tier 5: label substring (case-insensitive).
    let label_sub: Vec<_> = candidates
        .iter()
        .filter(|c| candidate_label(c).is_some_and(|l| l.to_lowercase().contains(&frag_lower)))
        .collect();
    match label_sub.len().cmp(&1) {
        std::cmp::Ordering::Equal => MatchResult::One(label_sub[0]),
        std::cmp::Ordering::Greater => MatchResult::Ambiguous(label_sub),
        std::cmp::Ordering::Less => MatchResult::None,
    }
}

// ---------------------------------------------------------------------------
// Session matcher (2-tier priority, session.ts:102-109)
// ---------------------------------------------------------------------------

/// Resolve a fragment against the session list using the same 2-tier priority
/// as `matchSessions` in `apps/cli/src/commands/session.ts:102-109`:
///
/// 1. Exact `sid` match.
/// 2. `sid` prefix match.
///
/// No substring match — sids are long and collide easily in the middle.
pub fn match_sessions<'a>(
    candidates: &'a [SessionRow],
    fragment: &str,
) -> MatchResult<&'a SessionRow> {
    // Tier 1: exact sid.
    let exact: Vec<_> = candidates.iter().filter(|c| c.sid == fragment).collect();
    if !exact.is_empty() {
        return if exact.len() == 1 {
            MatchResult::One(exact[0])
        } else {
            MatchResult::Ambiguous(exact)
        };
    }

    // Tier 2: sid prefix.
    let prefix: Vec<_> = candidates
        .iter()
        .filter(|c| c.sid.starts_with(fragment))
        .collect();
    match prefix.len().cmp(&1) {
        std::cmp::Ordering::Equal => MatchResult::One(prefix[0]),
        std::cmp::Ordering::Greater => MatchResult::Ambiguous(prefix),
        std::cmp::Ordering::Less => MatchResult::None,
    }
}

// ---------------------------------------------------------------------------
// Duration parser (session.ts:82-95)
// ---------------------------------------------------------------------------

/// Duration multipliers matching `DURATION_MULTIPLIERS` in session.ts:68-73.
fn duration_ms_for_unit(unit: char) -> Option<u64> {
    match unit {
        's' => Some(1_000),
        'm' => Some(60_000),
        'h' => Some(3_600_000),
        'd' => Some(86_400_000),
        _ => None,
    }
}

/// Parse a human duration string (`7d`, `24h`, `30m`, `10s`) into milliseconds.
///
/// Byte-exact port of `parseDuration` in
/// `apps/cli/src/commands/session.ts:82-95`:
///   - Regex: `/^(\d+)([smhd])$/` applied to the trimmed input.
///   - Invalid format → `"Invalid duration '…'. Expected <N><s|m|h|d>, e.g. 7d
///     / 24h / 30m."`.
///   - Non-positive `n` (includes `0`) → `"Invalid duration '…'. Must be a
///     positive integer."`.
///
/// Returns `Ok(ms)` or `Err(error_string)`.
pub fn parse_duration(raw: &str) -> Result<u64, String> {
    let s = raw.trim();
    // Match /^(\d+)([smhd])$/ — digits followed by a single unit char.
    let (n_str, unit_char) = s
        .split_at_checked(s.len().saturating_sub(1))
        .and_then(|(prefix, suffix)| {
            let unit = suffix.chars().next()?;
            if matches!(unit, 's' | 'm' | 'h' | 'd')
                && !prefix.is_empty()
                && prefix.chars().all(|c| c.is_ascii_digit())
            {
                Some((prefix, unit))
            } else {
                None
            }
        })
        .ok_or_else(|| {
            format!("Invalid duration '{raw}'. Expected <N><s|m|h|d>, e.g. 7d / 24h / 30m.")
        })?;

    let n: u64 = n_str.parse().map_err(|_| {
        format!("Invalid duration '{raw}'. Expected <N><s|m|h|d>, e.g. 7d / 24h / 30m.")
    })?;
    if n == 0 {
        return Err(format!(
            "Invalid duration '{raw}'. Must be a positive integer."
        ));
    }

    // SAFETY: unit_char is one of s/m/h/d — duration_ms_for_unit cannot fail.
    let multiplier = duration_ms_for_unit(unit_char).unwrap();
    Ok(n * multiplier)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_duration ----

    #[test]
    fn duration_valid_cases() {
        assert_eq!(parse_duration("7d").unwrap(), 7 * 86_400_000);
        assert_eq!(parse_duration("24h").unwrap(), 24 * 3_600_000);
        assert_eq!(parse_duration("30m").unwrap(), 30 * 60_000);
        assert_eq!(parse_duration("10s").unwrap(), 10 * 1_000);
        assert_eq!(parse_duration("1s").unwrap(), 1_000);
        // Leading/trailing whitespace is trimmed.
        assert_eq!(parse_duration("  7d  ").unwrap(), 7 * 86_400_000);
    }

    #[test]
    fn duration_zero_rejected() {
        let err = parse_duration("0d").unwrap_err();
        assert!(err.contains("Must be a positive integer"), "got: {err}");
    }

    #[test]
    fn duration_invalid_format() {
        for bad in &["abc", "5x", "", "d", "7", "7.5d"] {
            let err = parse_duration(bad).unwrap_err();
            assert!(
                err.contains("Expected <N><s|m|h|d>"),
                "bad={bad}, got: {err}"
            );
        }
    }

    // ---- match_sessions ----

    fn make_sessions(sids: &[&str]) -> Vec<SessionRow> {
        sids.iter()
            .map(|&s| SessionRow {
                sid: s.to_string(),
                state: "stopped".to_string(),
                worktree_path: None,
                cwd: "/".to_string(),
                updated_at: 0,
                claude_version: None,
                last_seq: 0,
            })
            .collect()
    }

    #[test]
    fn session_exact_match() {
        let rows = make_sessions(&["sess-abc123", "sess-def456"]);
        assert!(matches!(
            match_sessions(&rows, "sess-abc123"),
            MatchResult::One(_)
        ));
    }

    #[test]
    fn session_prefix_match() {
        let rows = make_sessions(&["sess-abc123", "sess-def456"]);
        // Only "sess-abc123" starts with "sess-a".
        assert!(matches!(
            match_sessions(&rows, "sess-a"),
            MatchResult::One(_)
        ));
    }

    #[test]
    fn session_ambiguous_prefix() {
        let rows = make_sessions(&["sess-abc", "sess-abd"]);
        assert!(matches!(
            match_sessions(&rows, "sess-ab"),
            MatchResult::Ambiguous(_)
        ));
    }

    #[test]
    fn session_no_match() {
        let rows = make_sessions(&["sess-abc"]);
        assert!(matches!(match_sessions(&rows, "zzz"), MatchResult::None));
    }

    // ---- match_pairings ----

    fn make_pairings(entries: &[(&str, Option<&str>)]) -> Vec<PairingRow> {
        entries
            .iter()
            .map(|&(id, label)| PairingRow {
                daemon_id: id.to_string(),
                relay_url: "wss://r".to_string(),
                created_at: 0,
                label: label.map(String::from),
            })
            .collect()
    }

    #[test]
    fn pairing_exact_daemon_id() {
        let rows = make_pairings(&[("daemon-abc", Some("work")), ("daemon-def", None)]);
        let res = match_pairings(&rows, "daemon-abc");
        assert!(matches!(res, MatchResult::One(r) if r.daemon_id == "daemon-abc"));
    }

    #[test]
    fn pairing_exact_label_case_insensitive() {
        let rows = make_pairings(&[("daemon-abc", Some("Work Laptop")), ("daemon-def", None)]);
        let res = match_pairings(&rows, "work laptop");
        assert!(matches!(res, MatchResult::One(r) if r.daemon_id == "daemon-abc"));
    }

    #[test]
    fn pairing_daemon_id_prefix() {
        let rows = make_pairings(&[("daemon-abc123", Some("work")), ("daemon-def", None)]);
        let res = match_pairings(&rows, "daemon-abc");
        assert!(matches!(res, MatchResult::One(r) if r.daemon_id == "daemon-abc123"));
    }

    #[test]
    fn pairing_shorthand_fragment() {
        // "abc" → looks for "daemon-abc" exact match (tier 4).
        let rows = make_pairings(&[("daemon-abc", None), ("daemon-xyz", None)]);
        let res = match_pairings(&rows, "abc");
        assert!(matches!(res, MatchResult::One(r) if r.daemon_id == "daemon-abc"));
    }

    #[test]
    fn pairing_label_substring() {
        // Only tier 5: label contains the fragment.
        let rows = make_pairings(&[("daemon-a", Some("Home Office")), ("daemon-b", None)]);
        let res = match_pairings(&rows, "office");
        assert!(matches!(res, MatchResult::One(r) if r.daemon_id == "daemon-a"));
    }

    #[test]
    fn pairing_ambiguous_prefix() {
        let rows = make_pairings(&[("daemon-abc", None), ("daemon-abd", None)]);
        assert!(matches!(
            match_pairings(&rows, "daemon-ab"),
            MatchResult::Ambiguous(_)
        ));
    }

    #[test]
    fn pairing_no_match() {
        let rows = make_pairings(&[("daemon-abc", None)]);
        assert!(matches!(match_pairings(&rows, "zzz"), MatchResult::None));
    }
}
