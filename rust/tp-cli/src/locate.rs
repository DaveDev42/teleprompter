//! `locate_bun_blob()` — resolve the bundled Bun SEA (`tpd`) that `tp daemon
//! start` and other commands exec.
//!
//! # Resolution order (first match wins)
//!
//! 1. `$TP_BUN_BLOB` — absolute path override for dev / test / dogfood.
//! 2. `canonicalize(current_exe()) → ../../libexec/tp/tpd` — release prefix tree.
//!    When `~/.local/bin/tp` (dogfood) or `/opt/homebrew/bin/tp` (brew) are
//!    symlinks into `<prefix>/bin/tp`, `canonicalize` follows the symlink to the
//!    real `<prefix>/bin/tp` and `../../libexec/tp/tpd` resolves to
//!    `<prefix>/libexec/tp/tpd`.
//! 3. Sibling `tpd` next to the Rust `tp` binary — flat dogfood drop
//!    (`current_exe().parent()/tpd`).
//! 4. Dev fallback: walk up from `current_exe()` (e.g. `target/debug/tp`) until
//!    we find the repo root (a parent containing `apps/cli/src/index.ts`), then
//!    return `<repo>/dist/tp` if it exists (the `pnpm build:cli:local` / `bun
//!    build` output — locate_bun_blob fallback #4 for non-installed dev).
//! 5. Hard error → `ExitCode::FAILURE`.
//!
//! # Infinite-loop guard
//!
//! `locate_bun_blob()` MUST NEVER return a path that canonicalizes to
//! `current_exe()`. If any candidate would resolve to the Rust binary itself,
//! that candidate is rejected and the search continues. A misconfiguration where
//! all candidates map to the Rust binary causes a hard error instead of an
//! infinite process-spawn loop.
//!
//! # Architecture invariant
//!
//! The Bun blob is exec'd DIRECTLY so that `process.execPath` inside the Bun
//! process equals the blob, NOT the Rust binary. All Bun-internal daemon/runner
//! re-spawns (`spawn.ts`, `ensure-daemon.ts`) use `process.execPath`, so they
//! stay Bun→Bun, not Bun→Rust.

use std::path::{Path, PathBuf};

/// Resolve the bundled Bun SEA blob for exec. See module-level docs for the
/// resolution order and the infinite-loop guard.
///
/// Returns the path on success, or an error string (suitable for printing to
/// stderr) on failure.
pub fn locate_bun_blob() -> Result<PathBuf, String> {
    let current_canon = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());

    locate_bun_blob_inner(current_canon.as_deref())
}

/// Inner implementation with injectable current-exe canonical path for testing.
fn locate_bun_blob_inner(current_canon: Option<&Path>) -> Result<PathBuf, String> {
    // Build a guard closure: returns true if the candidate resolves to the
    // Rust binary itself (infinite-loop guard).
    let is_self = |candidate: &Path| -> bool {
        if let (Some(c), Some(me)) = (std::fs::canonicalize(candidate).ok(), current_canon) {
            c == me
        } else {
            false
        }
    };

    // ── 1. $TP_BUN_BLOB override ──────────────────────────────────────────────
    if let Ok(blob) = std::env::var("TP_BUN_BLOB") {
        if !blob.is_empty() {
            let p = PathBuf::from(&blob);
            if is_self(&p) {
                return Err(format!(
                    "tp: TP_BUN_BLOB resolves to the tp binary itself ({blob}); \
                     infinite loop prevented. Set TP_BUN_BLOB to the Bun tpd blob."
                ));
            }
            if p.exists() {
                return Ok(p);
            }
            // TP_BUN_BLOB set but doesn't exist → hard error (user intent is clear).
            return Err(format!(
                "tp: TP_BUN_BLOB is set to '{blob}' but that file does not exist."
            ));
        }
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("tp: cannot determine current executable path: {e}"))?;

    // ── 2. Release prefix tree: canonicalize → ../../libexec/tp/tpd ──────────
    let candidate2 = std::fs::canonicalize(&exe_path).ok().and_then(|canon| {
        // canon = <prefix>/bin/tp  →  parent = <prefix>/bin
        // ../../libexec/tp/tpd = <prefix>/libexec/tp/tpd
        canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tpd"))
    });

    if let Some(ref p) = candidate2 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 3. Sibling tpd next to the Rust binary ────────────────────────────────
    let candidate3 = exe_path.parent().map(|dir| dir.join("tpd"));

    if let Some(ref p) = candidate3 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 4. Dev fallback: walk up from exe to repo root, use dist/tp ──────────
    let candidate4 = find_repo_root(&exe_path).map(|root| root.join("dist").join("tp"));

    if let Some(ref p) = candidate4 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 5. Hard error ─────────────────────────────────────────────────────────
    let searched: Vec<String> = [
        candidate2.map(|p| p.to_string_lossy().into_owned()),
        candidate3.map(|p| p.to_string_lossy().into_owned()),
        candidate4.map(|p| p.to_string_lossy().into_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();

    Err(format!(
        "tp: bundled daemon runtime not found (looked in {}). \
         Reinstall tp or set TP_BUN_BLOB.",
        searched.join(", ")
    ))
}

/// Resolve the shipped Rust `tp-daemon` binary for exec (ADR-0003 Phase 4 A1).
///
/// Structurally mirrors [`locate_bun_blob`], with two intentional divergences:
/// the env override is `TP_DAEMON_BIN`, and the dev fallback is the cargo bin
/// `<repo>/rust/target/release/tp-daemon` (NOT `dist/…`, which is a bundled Bun
/// blob path — `tp-daemon` is an ordinary cargo binary).
///
/// # Resolution order (first match wins)
/// 1. `$TP_DAEMON_BIN` — absolute-path override. This is the SAME env var the
///    TS-side opt-in seam reads (`apps/cli/src/lib/daemon-bin.ts`
///    `resolveDaemonBinOverride`). The two are COHERENT, not conflicting: the TS
///    seam decides *whether* the Bun `tp` spawns the Rust daemon and hands the
///    process a concrete argv `[<path>, []]`; this Rust-side locate answers
///    "where is the shipped daemon" for the (future) native-`tp` flip path. Both
///    honor a full path the operator/harness already built — a shared escape
///    hatch, never a toggle. An operator who exports `TP_DAEMON_BIN` gets the
///    same binary regardless of which `tp` (Bun or Rust) reads it.
/// 2. `canonicalize(current_exe) → ../../libexec/tp/tp-daemon` — release prefix
///    tree, alongside `tpd`.
/// 3. Sibling `tp-daemon` next to the Rust `tp` binary — flat dogfood drop.
/// 4. Dev fallback: walk up to the repo root and use
///    `<repo>/rust/target/release/tp-daemon`.
/// 5. Hard error.
///
/// Carries the same `is_self` infinite-loop guard as [`locate_bun_blob`].
///
/// NOTE (A1 scope): added but NOT yet wired into any exec path — the daemon
/// default remains the Bun daemon (`resolveDaemonSpawnCommand` in
/// ensure-daemon.ts). The daemon default-flip PR is the first real caller and
/// removes the `#[allow(dead_code)]`.
#[allow(dead_code)] // Wired by the daemon default-flip PR (ADR-0003 Phase 4).
pub fn locate_tp_daemon() -> Result<PathBuf, String> {
    let current_canon = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());

    locate_tp_daemon_inner(current_canon.as_deref())
}

/// Inner implementation with injectable current-exe canonical path for testing.
#[allow(dead_code)] // See locate_tp_daemon.
fn locate_tp_daemon_inner(current_canon: Option<&Path>) -> Result<PathBuf, String> {
    let is_self = |candidate: &Path| -> bool {
        if let (Some(c), Some(me)) = (std::fs::canonicalize(candidate).ok(), current_canon) {
            c == me
        } else {
            false
        }
    };

    // ── 1. $TP_DAEMON_BIN override ────────────────────────────────────────────
    if let Ok(bin) = std::env::var("TP_DAEMON_BIN") {
        if !bin.is_empty() {
            let p = PathBuf::from(&bin);
            if is_self(&p) {
                return Err(format!(
                    "tp: TP_DAEMON_BIN resolves to the tp binary itself ({bin}); \
                     infinite loop prevented. Set TP_DAEMON_BIN to the tp-daemon binary."
                ));
            }
            if p.exists() {
                return Ok(p);
            }
            return Err(format!(
                "tp: TP_DAEMON_BIN is set to '{bin}' but that file does not exist."
            ));
        }
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("tp: cannot determine current executable path: {e}"))?;

    // ── 2. Release prefix tree: canonicalize → ../../libexec/tp/tp-daemon ─────
    let candidate2 = std::fs::canonicalize(&exe_path).ok().and_then(|canon| {
        canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-daemon"))
    });

    if let Some(ref p) = candidate2 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 3. Sibling tp-daemon next to the Rust binary ──────────────────────────
    let candidate3 = exe_path.parent().map(|dir| dir.join("tp-daemon"));

    if let Some(ref p) = candidate3 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 4. Dev fallback: <repo>/rust/target/release/tp-daemon ─────────────────
    let candidate4 = find_repo_root(&exe_path).map(|root| {
        root.join("rust")
            .join("target")
            .join("release")
            .join("tp-daemon")
    });

    if let Some(ref p) = candidate4 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 5. Hard error ─────────────────────────────────────────────────────────
    let searched: Vec<String> = [
        candidate2.map(|p| p.to_string_lossy().into_owned()),
        candidate3.map(|p| p.to_string_lossy().into_owned()),
        candidate4.map(|p| p.to_string_lossy().into_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();

    Err(format!(
        "tp: bundled tp-daemon not found (looked in {}). \
         Reinstall tp or set TP_DAEMON_BIN.",
        searched.join(", ")
    ))
}

/// Resolve the shipped Rust `tp-relay` binary for exec (task #17 PR — de-trampoline
/// `tp relay start`).
///
/// Structurally identical to [`locate_tp_daemon`] with `tp-relay` in place of
/// `tp-daemon` and the env override `TP_RELAY_BIN`. `tp-relay` is an ordinary
/// cargo binary (the standalone relay server, `rust/tp-relay`), so the dev
/// fallback is `<repo>/rust/target/release/tp-relay` (NOT a Bun blob path).
///
/// # Resolution order (first match wins)
/// 1. `$TP_RELAY_BIN` — absolute-path override (escape hatch for dev / test).
/// 2. `canonicalize(current_exe) → ../../libexec/tp/tp-relay` — release prefix
///    tree, alongside `tpd` / `tp-daemon`.
/// 3. Sibling `tp-relay` next to the Rust `tp` binary — flat dogfood drop.
/// 4. Dev fallback: `<repo>/rust/target/release/tp-relay`.
/// 5. Hard error.
///
/// Carries the same `is_self` infinite-loop guard as [`locate_bun_blob`].
///
/// Unlike A1's `locate_tp_daemon` (shipped unwired), this is wired the same PR:
/// `commands::relay::run` execs it for `tp relay start`, so there is no
/// `#[allow(dead_code)]`.
pub fn locate_tp_relay() -> Result<PathBuf, String> {
    let current_canon = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());

    locate_tp_relay_inner(current_canon.as_deref())
}

/// Inner implementation with injectable current-exe canonical path for testing.
fn locate_tp_relay_inner(current_canon: Option<&Path>) -> Result<PathBuf, String> {
    let is_self = |candidate: &Path| -> bool {
        if let (Some(c), Some(me)) = (std::fs::canonicalize(candidate).ok(), current_canon) {
            c == me
        } else {
            false
        }
    };

    // ── 1. $TP_RELAY_BIN override ─────────────────────────────────────────────
    if let Ok(bin) = std::env::var("TP_RELAY_BIN") {
        if !bin.is_empty() {
            let p = PathBuf::from(&bin);
            if is_self(&p) {
                return Err(format!(
                    "tp: TP_RELAY_BIN resolves to the tp binary itself ({bin}); \
                     infinite loop prevented. Set TP_RELAY_BIN to the tp-relay binary."
                ));
            }
            if p.exists() {
                return Ok(p);
            }
            return Err(format!(
                "tp: TP_RELAY_BIN is set to '{bin}' but that file does not exist."
            ));
        }
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("tp: cannot determine current executable path: {e}"))?;

    // ── 2. Release prefix tree: canonicalize → ../../libexec/tp/tp-relay ──────
    let candidate2 = std::fs::canonicalize(&exe_path).ok().and_then(|canon| {
        canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-relay"))
    });

    if let Some(ref p) = candidate2 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 3. Sibling tp-relay next to the Rust binary ───────────────────────────
    let candidate3 = exe_path.parent().map(|dir| dir.join("tp-relay"));

    if let Some(ref p) = candidate3 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 4. Dev fallback: <repo>/rust/target/release/tp-relay ──────────────────
    let candidate4 = find_repo_root(&exe_path).map(|root| {
        root.join("rust")
            .join("target")
            .join("release")
            .join("tp-relay")
    });

    if let Some(ref p) = candidate4 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 5. Hard error ─────────────────────────────────────────────────────────
    let searched: Vec<String> = [
        candidate2.map(|p| p.to_string_lossy().into_owned()),
        candidate3.map(|p| p.to_string_lossy().into_owned()),
        candidate4.map(|p| p.to_string_lossy().into_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();

    Err(format!(
        "tp: bundled tp-relay not found (looked in {}). \
         Reinstall tp or set TP_RELAY_BIN.",
        searched.join(", ")
    ))
}

/// Walk up the filesystem from `start`, looking for a directory that contains
/// `apps/cli/src/index.ts` — the repo root sentinel. Returns the first match.
pub(crate) fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    for _ in 0..16 {
        if !current.pop() {
            break;
        }
        if current
            .join("apps")
            .join("cli")
            .join("src")
            .join("index.ts")
            .exists()
        {
            return Some(current);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ── Helper: create a temp dir ────────────────────────────────────────────

    fn tmpdir() -> tempfile::TempDir {
        tempfile::TempDir::new().expect("tempdir")
    }

    // ── Prefix tree path construction (pure geometry) ────────────────────────

    #[test]
    fn prefix_tree_candidate_shape() {
        // Simulate: canon = /opt/tp/bin/tp → prefix = /opt/tp → tpd at
        // /opt/tp/libexec/tp/tpd
        let canon = PathBuf::from("/opt/tp/bin/tp");
        let candidate = canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tpd"));
        assert_eq!(candidate, Some(PathBuf::from("/opt/tp/libexec/tp/tpd")));
    }

    // ── Prefix tree with a deeper symlink path ───────────────────────────────

    #[test]
    fn prefix_tree_local_bin_shape() {
        // Simulate ~/.local/bin/tp → ~/.local/share/tp/bin/tp (after symlink
        // resolution).  Prefix = ~/.local/share/tp → tpd at
        // ~/.local/share/tp/libexec/tp/tpd.
        let canon = PathBuf::from("/home/u/.local/share/tp/bin/tp");
        let candidate = canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tpd"));
        assert_eq!(
            candidate,
            Some(PathBuf::from("/home/u/.local/share/tp/libexec/tp/tpd"))
        );
    }

    // ── find_repo_root locates the real repo ─────────────────────────────────

    #[test]
    fn find_repo_root_finds_this_repo() {
        // The test binary lives somewhere under rust/target/… — walking up should
        // reach the repo root that contains apps/cli/src/index.ts.
        let exe = std::env::current_exe().unwrap();
        let root = find_repo_root(&exe);
        assert!(
            root.is_some(),
            "should find repo root from test binary path"
        );
        let root = root.unwrap();
        assert!(
            root.join("apps")
                .join("cli")
                .join("src")
                .join("index.ts")
                .exists(),
            "repo root should contain apps/cli/src/index.ts: {root:?}"
        );
    }

    // ── find_repo_root: no sentinel → None ───────────────────────────────────

    #[test]
    fn find_repo_root_none_when_sentinel_absent() {
        // A path deep under /tmp won't have the repo sentinel.
        let p = PathBuf::from("/tmp/tp-locate-test-xyz/a/b/c/binary");
        assert!(find_repo_root(&p).is_none());
    }

    // ── dev fallback: dist/tp exists under the repo root ────────────────────

    #[test]
    fn dev_fallback_resolves_if_dist_tp_exists() {
        let exe = std::env::current_exe().unwrap();
        if let Some(root) = find_repo_root(&exe) {
            let dist_tp = root.join("dist").join("tp");
            if dist_tp.exists() {
                // If it exists, it should be a file (not the current Rust binary).
                assert!(dist_tp.is_file());
            }
        }
    }

    // ── not-found error message ───────────────────────────────────────────────

    #[test]
    fn not_found_error_mentions_reinstall_and_bun_blob() {
        // Synthesise a current_canon pointing to a non-existent path so the
        // guard never fires, but no candidate exists → hard error.
        let bogus_self = PathBuf::from("/tmp/tp-cli-bogus-self-xyz/tp");
        // candidates 2/3/4 are derived from current_exe() which we can't stub
        // here, so just verify the error shape if it fires.
        let result = locate_bun_blob_inner(Some(&bogus_self));
        // Either a real candidate was found (OK — some fallback exists on this
        // machine) or we get the hard error.
        if let Err(msg) = result {
            assert!(
                msg.contains("bundled daemon runtime not found") && msg.contains("TP_BUN_BLOB"),
                "error should mention TP_BUN_BLOB: {msg}"
            );
            assert!(msg.contains("Reinstall"), "should mention Reinstall: {msg}");
        }
    }

    // ── sibling tpd candidate ────────────────────────────────────────────────

    #[test]
    fn sibling_tpd_candidate_shape() {
        // Verify the sibling join logic.
        let exe = PathBuf::from("/usr/local/bin/tp");
        let sibling = exe.parent().map(|d| d.join("tpd"));
        assert_eq!(sibling, Some(PathBuf::from("/usr/local/bin/tpd")));
    }

    // ── TP_BUN_BLOB set and file exists (file-system level test) ────────────

    #[test]
    fn tp_bun_blob_set_and_exists_filesystem_level() {
        let dir = tmpdir();
        let blob = dir.path().join("tpd-test");
        fs::write(&blob, b"fake bun blob").unwrap();
        // Can't easily set env vars without temp_env; verify the path object is
        // correct and would pass the existence check.
        assert!(blob.exists());
        // The guard: blob path != current_exe canon
        let exe = std::env::current_exe().unwrap();
        let exe_canon = std::fs::canonicalize(&exe).ok();
        let blob_canon = std::fs::canonicalize(&blob).ok();
        assert_ne!(exe_canon, blob_canon, "fake blob must differ from our exe");
    }

    // ── never-current_exe guard (logic unit) ─────────────────────────────────

    #[test]
    fn is_self_guard_rejects_current_exe() {
        // Simulate the guard: if a candidate canonicalizes to current_exe, it
        // must be rejected.  Build a fake pair where both paths are the same.
        let dir = tmpdir();
        let fake = dir.path().join("fake_exe");
        fs::write(&fake, b"fake").unwrap();
        let fake_canon = std::fs::canonicalize(&fake).unwrap();

        // is_self(candidate) where candidate == current_canon → true (rejected).
        let is_self = |candidate: &Path| -> bool {
            if let (Some(c), Some(me)) = (
                std::fs::canonicalize(candidate).ok(),
                Some(fake_canon.as_path()),
            ) {
                c == me
            } else {
                false
            }
        };

        assert!(
            is_self(&fake),
            "guard must fire when candidate == current_canon"
        );
        assert!(
            !is_self(Path::new("/tmp/other")),
            "guard must not fire for a different path"
        );
    }

    // ── tp-daemon (A1): prefix tree path construction (pure geometry) ────────

    #[test]
    fn tp_daemon_prefix_tree_candidate_shape() {
        // canon = /opt/tp/bin/tp → prefix = /opt/tp → tp-daemon at
        // /opt/tp/libexec/tp/tp-daemon (alongside tpd).
        let canon = PathBuf::from("/opt/tp/bin/tp");
        let candidate = canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-daemon"));
        assert_eq!(
            candidate,
            Some(PathBuf::from("/opt/tp/libexec/tp/tp-daemon"))
        );
    }

    // ── tp-daemon (A1): sibling candidate ────────────────────────────────────

    #[test]
    fn tp_daemon_sibling_candidate_shape() {
        let exe = PathBuf::from("/usr/local/bin/tp");
        let sibling = exe.parent().map(|d| d.join("tp-daemon"));
        assert_eq!(sibling, Some(PathBuf::from("/usr/local/bin/tp-daemon")));
    }

    // ── tp-daemon (A1): dev fallback is rust/target/release, NOT dist/ ────────

    #[test]
    fn tp_daemon_dev_fallback_shape() {
        // Unlike locate_bun_blob's dist/tp, the daemon dev fallback is the cargo
        // bin path <repo>/rust/target/release/tp-daemon.
        let root = PathBuf::from("/home/u/teleprompter");
        let candidate = root
            .join("rust")
            .join("target")
            .join("release")
            .join("tp-daemon");
        assert_eq!(
            candidate,
            PathBuf::from("/home/u/teleprompter/rust/target/release/tp-daemon")
        );
    }

    // ── tp-daemon (A1): not-found error message ──────────────────────────────

    #[test]
    fn tp_daemon_not_found_error_mentions_reinstall_and_daemon_bin() {
        // Exercises locate_tp_daemon_inner (also its only non-test caller path):
        // a bogus current_canon so the guard never fires; if no candidate exists
        // on this machine, the hard error must name TP_DAEMON_BIN + Reinstall.
        let bogus_self = PathBuf::from("/tmp/tp-cli-bogus-self-daemon-xyz/tp");
        if let Err(msg) = locate_tp_daemon_inner(Some(&bogus_self)) {
            assert!(
                msg.contains("tp-daemon not found") && msg.contains("TP_DAEMON_BIN"),
                "error should mention TP_DAEMON_BIN: {msg}"
            );
            assert!(msg.contains("Reinstall"), "should mention Reinstall: {msg}");
        }
    }

    // ── tp-relay (#25): prefix-tree candidate ────────────────────────────────

    #[test]
    fn tp_relay_prefix_tree_candidate_shape() {
        // canon = /opt/tp/bin/tp → prefix = /opt/tp → tp-relay at
        // /opt/tp/libexec/tp/tp-relay (alongside tpd / tp-daemon).
        let canon = PathBuf::from("/opt/tp/bin/tp");
        let candidate = canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-relay"));
        assert_eq!(
            candidate,
            Some(PathBuf::from("/opt/tp/libexec/tp/tp-relay"))
        );
    }

    // ── tp-relay (#25): sibling candidate ────────────────────────────────────

    #[test]
    fn tp_relay_sibling_candidate_shape() {
        let exe = PathBuf::from("/usr/local/bin/tp");
        let sibling = exe.parent().map(|d| d.join("tp-relay"));
        assert_eq!(sibling, Some(PathBuf::from("/usr/local/bin/tp-relay")));
    }

    // ── tp-relay (#25): dev fallback is rust/target/release, NOT dist/ ────────

    #[test]
    fn tp_relay_dev_fallback_shape() {
        let root = PathBuf::from("/home/u/teleprompter");
        let candidate = root
            .join("rust")
            .join("target")
            .join("release")
            .join("tp-relay");
        assert_eq!(
            candidate,
            PathBuf::from("/home/u/teleprompter/rust/target/release/tp-relay")
        );
    }

    // ── tp-relay (#25): not-found error message ──────────────────────────────

    #[test]
    fn tp_relay_not_found_error_mentions_reinstall_and_relay_bin() {
        let bogus_self = PathBuf::from("/tmp/tp-cli-bogus-self-relay-xyz/tp");
        if let Err(msg) = locate_tp_relay_inner(Some(&bogus_self)) {
            assert!(
                msg.contains("tp-relay not found") && msg.contains("TP_RELAY_BIN"),
                "error should mention TP_RELAY_BIN: {msg}"
            );
            assert!(msg.contains("Reinstall"), "should mention Reinstall: {msg}");
        }
    }
}
