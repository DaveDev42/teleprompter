//! Daemon singleton pid-file lock.
//!
//! Byte-exact port of `packages/daemon/src/daemon-lock.ts`. Uses
//! `O_CREAT|O_EXCL` for atomic exclusive create (no two concurrent callers
//! can both succeed) and `kill(pid, 0)` to probe liveness of an existing
//! lock's pid.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Check whether a pid is alive by sending signal 0.
/// `true` → process exists (same uid, or root).
/// `false` → `ESRCH` (no such process).
/// `EPERM` → process exists but owned by another user; treated as alive.
fn is_pid_alive(pid: i32) -> bool {
    let Some(rpid) = rustix::process::Pid::from_raw(pid) else {
        // pid <= 0 is never a valid lock-file pid; treat as not-alive so the
        // caller cleans up the stale file (mirrors `process.kill` throwing
        // for an invalid pid, which the TS ESRCH arm also treats as dead).
        return false;
    };
    match rustix::process::test_kill_process(rpid) {
        Ok(()) => true,
        Err(rustix::io::Errno::SRCH) => false,
        Err(_) => true, // EPERM (or anything else) → exists, different uid
    }
}

/// Acquire the daemon singleton pid-file lock.
///
/// - No lock file present: write our pid exclusively and return it.
/// - Lock file present with a live pid: return `None` (caller must NOT spawn).
/// - Lock file present with a dead pid (crashed daemon): remove stale file and
///   retry once, then return the pid on success.
///
/// # Errors
/// Returns the underlying `io::Error` for any failure other than the expected
/// `AlreadyExists` race (e.g. failing to create the lock dir, or a write
/// failure not covered by the stale-lock retry).
pub fn acquire_daemon_lock(lock_path: &Path) -> io::Result<Option<u32>> {
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    try_acquire(lock_path, /* allow_retry */ true)
}

fn try_acquire(lock_path: &Path, allow_retry: bool) -> io::Result<Option<u32>> {
    let pid = std::process::id();

    let open_result = fs::OpenOptions::new()
        .write(true)
        .create_new(true) // O_WRONLY | O_CREAT | O_EXCL
        .open(lock_path);

    let mut file = match open_result {
        Ok(f) => f,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            // Lock file already exists; read the pid inside.
            let existing_pid: Option<i32> = fs::read_to_string(lock_path)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok());

            if let Some(existing) = existing_pid {
                if is_pid_alive(existing) {
                    return Ok(None); // live holder — caller must not spawn
                }
            }

            // Stale lock (crashed daemon, or unreadable/corrupt file): remove
            // and retry once.
            if !allow_retry {
                return Ok(None);
            }
            let _ = fs::remove_file(lock_path); // already removed by a racing process — fine
            return try_acquire(lock_path, /* allow_retry */ false);
        }
        Err(err) => return Err(err),
    };

    // Successfully opened exclusively — write current pid. `write_all` CAN
    // fail (e.g. ENOSPC) after the OS already gave us a live fd; `file` drops
    // (closing the fd) on every path via normal Rust scoping, mirroring the
    // TS try/finally close guarantee without needing an explicit finally.
    let buf = format!("{pid}\n");
    file.write_all(buf.as_bytes())?;

    Ok(Some(pid))
}

/// Release the daemon lock by deleting the pid file.
/// Only removes the file if it still contains our own pid (guards against
/// deleting a lock written by a new daemon after a restart). Safe to call
/// even if the file was already removed.
pub fn release_daemon_lock(lock_path: &Path) {
    let Ok(content) = fs::read_to_string(lock_path) else {
        return; // best effort
    };
    let Ok(pid) = content.trim().parse::<u32>() else {
        return;
    };
    if pid != std::process::id() {
        // Another daemon has taken over — don't delete their lock.
        return;
    }
    let _ = fs::remove_file(lock_path);
}

/// Read the pid from the lock file without acquiring it. `None` if the file
/// doesn't exist or contains an invalid pid.
#[must_use]
pub fn read_daemon_lock_pid(lock_path: &Path) -> Option<u32> {
    fs::read_to_string(lock_path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

/// Check whether there is a live daemon according to the pid lock file.
/// Returns the pid if alive, `None` otherwise.
#[must_use]
pub fn check_daemon_lock_alive(lock_path: &Path) -> Option<u32> {
    let pid = read_daemon_lock_pid(lock_path)?;
    // i32 cast is safe: PIDs are always well within i32 range on every
    // supported platform (POSIX PID_MAX_LIMIT << i32::MAX).
    is_pid_alive(pid as i32).then_some(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_writes_own_pid_when_no_lock_exists() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");

        let pid = acquire_daemon_lock(&lock_path).unwrap();
        assert_eq!(pid, Some(std::process::id()));
        assert_eq!(read_daemon_lock_pid(&lock_path), Some(std::process::id()));
    }

    #[test]
    fn acquire_returns_none_when_live_pid_holds_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        // Our own process is always alive — write our pid as "the holder".
        fs::write(&lock_path, format!("{}\n", std::process::id())).unwrap();

        let result = acquire_daemon_lock(&lock_path).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn acquire_recovers_from_stale_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        // A pid that is (almost certainly) not alive. Use a very high pid
        // unlikely to be assigned, and additionally accept the case where the
        // OS happens to have such a process by construction of the test being
        // best-effort — but PID 2^31-2 is not a plausible OS pid.
        fs::write(&lock_path, "2147483646\n").unwrap();

        let result = acquire_daemon_lock(&lock_path).unwrap();
        assert_eq!(result, Some(std::process::id()));
    }

    #[test]
    fn release_removes_own_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        acquire_daemon_lock(&lock_path).unwrap();
        assert!(lock_path.exists());
        release_daemon_lock(&lock_path);
        assert!(!lock_path.exists());
    }

    #[test]
    fn release_does_not_remove_foreign_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        fs::write(&lock_path, "1\n").unwrap(); // pid 1 != our pid
        release_daemon_lock(&lock_path);
        assert!(lock_path.exists());
    }

    #[test]
    fn check_daemon_lock_alive_reports_self() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        acquire_daemon_lock(&lock_path).unwrap();
        assert_eq!(
            check_daemon_lock_alive(&lock_path),
            Some(std::process::id())
        );
    }

    #[test]
    fn check_daemon_lock_alive_none_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        assert_eq!(check_daemon_lock_alive(&lock_path), None);
    }

    #[test]
    fn read_daemon_lock_pid_none_for_corrupt_content() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("daemon.pid");
        fs::write(&lock_path, "not-a-pid\n").unwrap();
        assert_eq!(read_daemon_lock_pid(&lock_path), None);
    }
}
