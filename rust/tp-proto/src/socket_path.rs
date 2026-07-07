//! Session-id path-safety guard.
//!
//! Byte-exact port of `assertSafeSid` (`packages/protocol/src/socket-path.ts`,
//! line 90). `sid` values are path-joined into `sessions/<sid>.sqlite` (daemon
//! store) and `hook-<sid>.sock` (runner IPC), so a frontend-supplied `sid`
//! containing `/`, `\`, or `..` must be rejected before it reaches any
//! filesystem join — this is the defense-in-depth guard at the lowest layer
//! (the IPC dispatcher also guards frontend-supplied sids upstream, but the
//! store/socket path-join sites guard again so no other caller can slip past).

/// Every valid `sid` must match this allowlist: ASCII letters, digits,
/// underscore, hyphen. No path separators, no `..`, never empty.
fn is_safe_sid(sid: &str) -> bool {
    !sid.is_empty()
        && sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Reject a `sid` that is not exactly `[A-Za-z0-9_-]+`. Mirrors
/// `assertSafeSid` (socket-path.ts:90) — same allowlist, same error message
/// shape (`invalid sid '<sid>': must match [A-Za-z0-9_-]+ (no path separator,
/// '..', or empty)`), so wire-facing error text stays byte-identical to the
/// TS daemon for a caller that surfaces this string verbatim.
///
/// # Errors
/// Returns `Err(String)` with the formatted message when `sid` fails the
/// allowlist (including the empty string).
pub fn assert_safe_sid(sid: &str) -> Result<(), String> {
    if is_safe_sid(sid) {
        Ok(())
    } else {
        Err(format!(
            "invalid sid '{sid}': must match [A-Za-z0-9_-]+ (no path separator, '..', or empty)"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_allowlisted_sids() {
        assert!(assert_safe_sid("session-abc_1").is_ok());
        assert!(assert_safe_sid("a").is_ok());
        assert!(assert_safe_sid("A1_-b2").is_ok());
        assert!(assert_safe_sid("session-1751234567890").is_ok());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(assert_safe_sid("../x").is_err());
        assert!(assert_safe_sid("..").is_err());
        assert!(assert_safe_sid("a/b").is_err());
        assert!(assert_safe_sid("a\\b").is_err());
        assert!(assert_safe_sid("/etc/passwd").is_err());
    }

    #[test]
    fn rejects_empty() {
        assert!(assert_safe_sid("").is_err());
    }

    #[test]
    fn error_message_matches_ts_shape() {
        let err = assert_safe_sid("../x").unwrap_err();
        assert_eq!(
            err,
            "invalid sid '../x': must match [A-Za-z0-9_-]+ (no path separator, '..', or empty)"
        );
    }

    #[test]
    fn rejects_other_special_chars() {
        assert!(assert_safe_sid("sid with space").is_err());
        assert!(assert_safe_sid("sid.dot").is_err());
        assert!(assert_safe_sid("sid+plus").is_err());
        assert!(assert_safe_sid("sid?query").is_err());
    }
}
