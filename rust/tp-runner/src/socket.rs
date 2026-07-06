//! Runtime-dir + socket-path derivation — byte-exact port of the **writer**
//! half of `packages/protocol/src/socket-path.ts` plus
//! `HookReceiver.defaultSocketPath` (`hooks/hook-receiver.ts`).
//!
//! Unlike `tp-cli`'s read-only probe (which never creates dirs), the runner is a
//! *writer*: it binds the hook socket, so `resolve_runtime_dir` mirrors the TS
//! side effects exactly —
//!
//! - `$XDG_RUNTIME_DIR` set → `mkdir -p` it (never touch its perms) and return.
//! - else `/run/user/<uid>` if it exists as a directory → return (never create).
//! - else `/tmp/teleprompter-<uid>` → `mkdir -p` **mode 0700** + explicit
//!   `chmod 0700` (defense-in-depth against a pre-existing loose-umask dir).
//!
//! The socket path is a PLAIN `join(runtime_dir, "<name>.sock")` — NO
//! hashing/shortening. If this drifts from the daemon's derivation the runner
//! binds a hook socket the daemon's hook helper cannot reach.

use std::io;
use std::path::PathBuf;

/// Resolve the per-user runtime dir, creating it where the TS does. See the
/// module doc for the resolution order + side effects.
pub fn resolve_runtime_dir() -> io::Result<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            let dir = PathBuf::from(xdg);
            // XDG_RUNTIME_DIR is owned + mode-0700'd by the login manager; only
            // ensure it exists, never touch its permissions (mirrors the TS).
            std::fs::create_dir_all(&dir)?;
            return Ok(dir);
        }
    }

    let uid = current_uid();
    let systemd_dir = PathBuf::from(format!("/run/user/{uid}"));
    // Presence (mode-0700, login-manager owned) is the signal — do NOT create it.
    if systemd_dir.is_dir() {
        return Ok(systemd_dir);
    }

    // /tmp fallback: world-writable + shared, so force 0700 even if it already
    // existed (a pre-existing world-readable dir from a loose-umask run is
    // tightened here too). Matches `mkdirSync({mode:0o700}) + chmodSync(0o700)`.
    let runtime_dir = PathBuf::from(format!("/tmp/teleprompter-{uid}"));
    create_dir_all_mode_0700(&runtime_dir)?;
    Ok(runtime_dir)
}

/// The daemon IPC socket path: `resolveRuntimeDir()/daemon.sock`. The runner
/// connects here (the default when `--socket-path` is not passed).
pub fn daemon_socket_path() -> io::Result<PathBuf> {
    Ok(resolve_runtime_dir()?.join("daemon.sock"))
}

/// The hook receiver socket path for `sid`: `resolveRuntimeDir()/hook-<sid>.sock`.
///
/// Byte-exact port of `HookReceiver.defaultSocketPath`: `sid` comes from the
/// `--tp-sid` passthrough flag and is interpolated into the filename, so a
/// crafted sid containing `/`, `\`, or `..` is rejected before the join — an
/// unguarded join lets a confused/crafted sid self-DoS by binding/unlinking a
/// socket outside the per-user runtime dir (no privilege boundary here, but
/// still a footgun).
pub fn hook_socket_path(sid: &str) -> io::Result<PathBuf> {
    if sid.contains('/') || sid.contains('\\') || sid.contains("..") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid sid '{sid}': must not contain a path separator or '..'"),
        ));
    }
    Ok(resolve_runtime_dir()?.join(format!("hook-{sid}.sock")))
}

/// `mkdir -p` with mode 0700 on the leaf, then an explicit `chmod 0700` (the
/// `create_dir_all` mode is masked by umask and only applies to dirs it
/// actually creates, so chmod the leaf unconditionally — matching the TS).
fn create_dir_all_mode_0700(dir: &std::path::Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Current real uid, matching the daemon's `process.getuid()`. Indexes
/// `/run/user/<uid>` and `/tmp/teleprompter-<uid>`, so it must equal the
/// daemon's exactly. Read via `rustix` (safe — `unsafe_code = "forbid"`).
fn current_uid() -> u32 {
    rustix::process::getuid().as_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_socket_path_rejects_traversal() {
        assert!(hook_socket_path("../../etc/x").is_err());
        assert!(hook_socket_path("a/b").is_err());
        assert!(hook_socket_path("a\\b").is_err());
        assert!(hook_socket_path("..").is_err());
    }

    #[test]
    fn hook_socket_path_accepts_normal_sid_and_names_file() {
        let p = hook_socket_path("session-123").unwrap();
        assert_eq!(
            p.file_name().and_then(|s| s.to_str()),
            Some("hook-session-123.sock")
        );
    }

    #[test]
    fn daemon_and_hook_sockets_share_runtime_dir() {
        let d = daemon_socket_path().unwrap();
        let h = hook_socket_path("s").unwrap();
        assert_eq!(d.parent(), h.parent());
        assert_eq!(d.file_name().and_then(|s| s.to_str()), Some("daemon.sock"));
    }
}
