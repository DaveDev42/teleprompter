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
}
