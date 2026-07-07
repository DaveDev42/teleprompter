//! Session-id path-safety guard + the daemon IPC runtime-dir/socket-path
//! resolution shared by the daemon (bind side) and the CLI (connect side).
//!
//! Byte-exact port of `assertSafeSid` + `resolveRuntimeDir`/`getSocketPath`
//! (`packages/protocol/src/socket-path.ts`, lines 90 / 15-68 / 70-72). `sid`
//! values are path-joined into `sessions/<sid>.sqlite` (daemon store) and
//! `hook-<sid>.sock` (runner IPC), so a frontend-supplied `sid` containing
//! `/`, `\`, or `..` must be rejected before it reaches any filesystem join —
//! this is the defense-in-depth guard at the lowest layer (the IPC dispatcher
//! also guards frontend-supplied sids upstream, but the store/socket
//! path-join sites guard again so no other caller can slip past).
//!
//! `resolve_runtime_dir`/`socket_path` live here (not in `tp-cli`, which
//! already has a read-only variant at `tp-cli/src/socket.rs`) so `tp-daemon`
//! can bind the SAME path the CLI's read-only probe resolves, without daemon
//! depending on cli. Unlike the cli-side probe (read-only — a `status` check
//! must not have filesystem side effects), this port DOES `mkdir` the chosen
//! dir on the `XDG_RUNTIME_DIR` arm, matching the TS `mkdirSync` (the daemon
//! is the side that must guarantee the dir exists before `bind()`).

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

/// Collapse an arbitrary label (typically a git branch name) into a fragment
/// that is guaranteed to satisfy [`assert_safe_sid`]'s `[A-Za-z0-9_-]+`
/// allowlist. Byte-exact port of `sanitizeForSid` (socket-path.ts:117-123):
///
/// 1. every run of non-`[A-Za-z0-9_-]` characters → a single `-`,
/// 2. collapse `-` runs,
/// 3. trim leading/trailing `-`,
/// 4. an emptied-out label degrades to `"wt"`.
///
/// The mapping is lossy and one-way — it is ONLY for deriving a local sid /
/// default worktree directory name (no wire/schema/peer impact). The original
/// branch name is always passed to git verbatim.
///
/// Note the TS regexes operate on UTF-16 code units; every character this
/// replaces is replaced wholesale (a multi-byte codepoint is simply "not in
/// the allowlist"), so a `char`-wise walk is behavior-identical.
#[must_use]
pub fn sanitize_for_sid(label: &str) -> String {
    let mut cleaned = String::with_capacity(label.len());
    for c in label.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            cleaned.push(c);
        } else if !cleaned.ends_with('-') {
            // Non-allowlist run → single '-'; because a literal '-' also
            // funnels through the ends_with guard below, `-` runs collapse
            // here in the same pass (TS does it as a second replace — the
            // composition is identical because both passes only ever
            // shrink runs of '-').
            cleaned.push('-');
        }
    }
    // The pass above cannot collapse a run like "a--b" (literal hyphens are
    // pushed unconditionally). Do the TS second pass explicitly.
    let mut collapsed = String::with_capacity(cleaned.len());
    for c in cleaned.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    let trimmed = collapsed.trim_matches('-');
    if trimmed.is_empty() {
        "wt".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolve the per-user runtime directory that holds the daemon IPC socket
/// (and, for the CLI's pid-file lock, `daemon.pid`). Byte-exact port of
/// `resolveRuntimeDir` (socket-path.ts:15-68):
///
/// 1. `$XDG_RUNTIME_DIR` if set — `mkdir -p` it (owned/mode-0700'd by the
///    login manager; we only ensure it exists) and return it.
/// 2. `/run/user/<uid>` if it exists as a directory — the systemd standard,
///    for an interactive shell (no `XDG_RUNTIME_DIR`, e.g. WSL) that must
///    still find a systemd-managed daemon's socket. Read-only: presence is
///    the signal, we never create this one.
/// 3. `/tmp/teleprompter-<uid>` fallback — created mode-0700 (+ explicit
///    chmod, since `mkdir`'s mode is masked by umask) to keep the socket
///    private on the world-writable `/tmp`.
///
/// # Errors
/// Returns the underlying `io::Error` if creating/chmod'ing a directory
/// fails (steps 1 and 3 only — step 2 is read-only).
pub fn resolve_runtime_dir() -> std::io::Result<std::path::PathBuf> {
    use std::path::PathBuf;

    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            let dir = PathBuf::from(xdg);
            std::fs::create_dir_all(&dir)?;
            return Ok(dir);
        }
    }

    let uid = current_uid();
    let systemd_dir = PathBuf::from(format!("/run/user/{uid}"));
    if systemd_dir.is_dir() {
        return Ok(systemd_dir);
    }

    let fallback = PathBuf::from(format!("/tmp/teleprompter-{uid}"));
    create_dir_0700(&fallback)?;
    Ok(fallback)
}

/// `mkdir -p` mode 0700 + explicit chmod 0700 on the leaf, matching the TS
/// `mkdirSync({recursive:true, mode:0o700}) + chmodSync(0o700)` (the explicit
/// chmod is required because `mkdir`'s requested mode is masked by umask).
fn create_dir_0700(dir: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// The daemon IPC socket path: `resolveRuntimeDir()/daemon.sock`. Byte-exact
/// port of `getSocketPath` (socket-path.ts:70-72) — a PLAIN join, no
/// hashing/shortening. Must match `tp-cli`'s read-only `socket_path()`
/// (`tp-cli/src/socket.rs:42`) exactly, or the CLI resolves a different
/// socket than the one the daemon binds.
///
/// # Errors
/// Propagates [`resolve_runtime_dir`]'s `io::Error`.
pub fn socket_path() -> std::io::Result<std::path::PathBuf> {
    Ok(resolve_runtime_dir()?.join("daemon.sock"))
}

/// Current real uid, matching the daemon's `process.getuid()`. Read via
/// `rustix` (a safe wrapper — `unsafe_code = "forbid"` rules out a direct
/// libc `getuid()` call). This uid indexes `/run/user/<uid>` and
/// `/tmp/teleprompter-<uid>`, so it must equal the CLI's `tp-cli/src/socket.rs`
/// derivation exactly.
fn current_uid() -> u32 {
    rustix::process::getuid().as_raw()
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

    #[test]
    fn socket_path_ends_with_daemon_sock() {
        let p = socket_path().expect("resolve socket path");
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("daemon.sock"));
    }

    #[test]
    fn socket_path_is_plain_join_no_hashing() {
        // The socket path must be EXACTLY resolve_runtime_dir()/daemon.sock —
        // no hashing/shortening — or the tp-cli read-only probe
        // (tp-cli/src/socket.rs) resolves a different path than what the
        // daemon binds.
        let dir = resolve_runtime_dir().expect("resolve runtime dir");
        let sock = socket_path().expect("resolve socket path");
        assert_eq!(sock, dir.join("daemon.sock"));
    }

    #[test]
    fn xdg_runtime_dir_wins_when_set() {
        // std::env::set_var is unsafe in edition 2024 and process-global —
        // avoid mutating real env in a parallel test binary. Assert the pure
        // join shape instead (mirrors tp-cli's socket.rs test of the same
        // constraint).
        let dir = std::path::PathBuf::from("/run/user/1000");
        assert_eq!(
            dir.join("daemon.sock"),
            std::path::PathBuf::from("/run/user/1000/daemon.sock")
        );
    }

    #[test]
    fn sanitize_flattens_slash_like_worktree_sid_derivation() {
        // Mirrors socket-path.test.ts "flattens '/' the way the worktree sid
        // derivation needs".
        assert_eq!(sanitize_for_sid("feat/foo"), "feat-foo");
        assert_eq!(sanitize_for_sid("a/b/c"), "a-b-c");
    }

    #[test]
    fn sanitize_collapses_non_allowlist_branch_chars() {
        // Mirrors socket-path.test.ts "collapses non-allowlist characters
        // legal in a git branch".
        assert_eq!(sanitize_for_sid("release-1.2"), "release-1-2");
        assert_eq!(sanitize_for_sid("feat.x"), "feat-x");
        assert_eq!(sanitize_for_sid("v2.0"), "v2-0");
        assert_eq!(sanitize_for_sid("a+b"), "a-b");
        assert_eq!(sanitize_for_sid("한글브랜치"), "wt");
    }

    #[test]
    fn sanitize_collapses_runs_and_trims_edges() {
        // Mirrors socket-path.test.ts "collapses runs and trims
        // leading/trailing separators".
        assert_eq!(sanitize_for_sid("a...b"), "a-b");
        assert_eq!(sanitize_for_sid("--a--"), "a");
        assert_eq!(sanitize_for_sid(".a."), "a");
        assert_eq!(sanitize_for_sid("a.-b"), "a-b");
    }

    #[test]
    fn sanitize_falls_back_to_wt_when_empty() {
        // Mirrors socket-path.test.ts "falls back to 'wt' when the label
        // reduces to empty".
        assert_eq!(sanitize_for_sid(""), "wt");
        assert_eq!(sanitize_for_sid("..."), "wt");
        assert_eq!(sanitize_for_sid("///"), "wt");
    }

    #[test]
    fn sanitize_output_always_passes_assert_safe_sid() {
        // Mirrors socket-path.test.ts "output always passes assertSafeSid
        // for branch-shaped inputs" — the invariant the worktree.create sid
        // derivation depends on.
        for label in [
            "feat/foo",
            "release-1.2",
            "a b c",
            "...",
            "",
            "브랜치/이름.v2",
            "-x-",
            "UPPER_case-09",
        ] {
            let out = sanitize_for_sid(label);
            assert!(
                assert_safe_sid(&out).is_ok(),
                "sanitize_for_sid({label:?}) produced unsafe sid {out:?}"
            );
        }
    }
}
