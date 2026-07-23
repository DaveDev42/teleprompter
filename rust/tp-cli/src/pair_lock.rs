//! Advisory file lock guarding `tp pair new` concurrency.
//!
//! Two concurrent `tp pair new` invocations would each begin a `PendingPairing`
//! and float two pairing identities at the relay simultaneously, corrupting
//! identity state — so no pair-related code path may ever skip this lock. It
//! makes the second invocation fail fast with a clear "already running"
//! message.
//!
//! ## Mechanism — flock(2) advisory lock (std `File::try_lock`)
//!
//! `acquire_pair_lock` opens (creating if needed) the lock file and takes an
//! exclusive advisory lock via the std `File::try_lock` API (stabilized in Rust
//! 1.89, available on our pinned 1.96 toolchain; backed by `flock(2)` on Unix).
//! `try_lock` returns immediately: on contention it yields
//! `Err(TryLockError::WouldBlock)` → we return `None` (mirrors proper-lockfile's
//! `retries: 0`). The lock auto-releases when the process exits or crashes (the
//! kernel drops the lock when the fd closes), so — unlike the Bun reference —
//! there is NO stale-mtime TTL to manage. No external crate is needed (the
//! `fs4` crate's trait method is shadowed by this inherent std method anyway).
//!
//! ## DIVERGENCE from the Bun CLI (accepted)
//!
//! The Bun reference (`apps/cli/src/lib/pair-lock.ts`) uses `proper-lockfile`,
//! which is a **mkdir-based lock DIRECTORY** (`pair.lock.lock/`) with a 10s
//! stale-mtime sweep — NOT `flock(2)`. The Rust port uses `flock` instead.
//! Consequence: a Rust `tp pair new` and a Bun `tp pair new` do NOT mutually
//! exclude (they take different kinds of lock on different paths). This is
//! ACCEPTED because the Bun CLI is being retired by this port and the two
//! binaries are not run concurrently against the same machine afterward. The
//! daemon-side `PendingPairing` + proof-based `relay.register` still prevent
//! protocol-layer identity corruption regardless. The `flock` design is also
//! strictly more robust for the single-implementation steady state: it
//! auto-releases on SIGKILL, where the mkdir lock would leave a stale directory.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

/// A held pair lock. The flock is released on `Drop` (and also implicitly when
/// the underlying `File` fd closes on process exit). Hold this guard alive for
/// the entire `pair new` flow; drop it (or let it drop) to release.
pub struct PairLock {
    file: File,
}

impl Drop for PairLock {
    fn drop(&mut self) {
        // Best-effort explicit unlock. The kernel also releases the flock when
        // `self.file` closes here, so a failure is harmless.
        let _ = self.file.unlock();
    }
}

/// Acquire the pair lock at `lock_path`. Returns `Some(PairLock)` on success,
/// or `None` if another live process already holds it (contention — the caller
/// prints the "already running" error and exits).
///
/// Mirrors `acquirePairLock` (pair-lock.ts:32-52): ensure the parent dir +
/// target file exist, then take the lock with single-attempt (`retries: 0`)
/// semantics. I/O errors creating the dir/file also yield `None` (the Bun
/// reference would surface them; here we treat "can't even create the lock
/// file" the same as "can't lock" — a fail-closed posture for a guard whose
/// only job is to block a second concurrent run).
pub fn acquire_pair_lock(lock_path: &Path) -> Option<PairLock> {
    if let Some(parent) = lock_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return None;
        }
    }

    // Open (create if absent) the lock file. We keep the fd open for the
    // lifetime of the PairLock so the flock stays held.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .ok()?;

    // Single attempt — `WouldBlock` (contention) or any I/O error → None
    // (mirrors proper-lockfile's `retries: 0`, where a held lock returns null).
    match file.try_lock() {
        Ok(()) => Some(PairLock { file }),
        Err(TryLockError::WouldBlock | TryLockError::Error(_)) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_lock_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        // Unique-ish per-test path; pid keeps parallel test runs from colliding.
        p.push(format!(
            "tp-cli-pairlock-test-{}-{name}",
            std::process::id()
        ));
        p.push("pair.lock");
        p
    }

    #[test]
    fn acquire_creates_lock_and_dir() {
        let path = temp_lock_path("create");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let lock = acquire_pair_lock(&path);
        assert!(lock.is_some(), "first acquire must succeed");
        assert!(path.exists(), "lock file must be created");
        drop(lock);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn second_acquire_contends_to_none() {
        let path = temp_lock_path("contend");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let first = acquire_pair_lock(&path).expect("first acquire must succeed");
        // A second exclusive flock on the same path from this process must fail
        // (flock is per-open-file-description; a fresh open contends).
        let second = acquire_pair_lock(&path);
        assert!(
            second.is_none(),
            "second acquire must contend → None while first is held"
        );
        drop(first);
        // After release, a fresh acquire succeeds again.
        let third = acquire_pair_lock(&path);
        assert!(third.is_some(), "acquire after release must succeed");
        drop(third);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn drop_releases_lock() {
        let path = temp_lock_path("drop");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        {
            let _lock = acquire_pair_lock(&path).expect("acquire");
        } // dropped here
        let again = acquire_pair_lock(&path);
        assert!(again.is_some(), "lock must be re-acquirable after Drop");
        drop(again);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
