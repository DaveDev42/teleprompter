//! Sidecar binary resolvers — find the shipped `tp-daemon` / `tp-relay` that
//! the Rust `tp` CLI execs.
//!
//! All resolvers share one shape (first match wins):
//!
//! 1. `$TP_<NAME>_BIN` — absolute path override for dev / test / harness.
//! 2. `canonicalize(current_exe()) → ../../libexec/tp/<name>` — release prefix
//!    tree. When `~/.local/bin/tp` (dogfood) or `/opt/homebrew/bin/tp` (brew)
//!    are symlinks into `<prefix>/bin/tp`, `canonicalize` follows the symlink
//!    so `../../libexec/tp/<name>` resolves inside the real prefix.
//! 3. Sibling `<name>` next to the Rust `tp` binary — flat dogfood drop.
//! 4. Dev fallback: walk up from `current_exe()` (e.g. `target/debug/tp`) to
//!    the repo root (parent containing `rust/tp-cli/Cargo.toml`), then
//!    `<repo>/rust/target/release/<name>` (ordinary cargo binaries).
//! 5. Hard error.
//!
//! # Infinite-loop guard
//!
//! A resolver MUST NEVER return a path that canonicalizes to `current_exe()`.
//! Any candidate resolving to the Rust binary itself is rejected and the
//! search continues; if every candidate maps to the Rust binary, that's a hard
//! error instead of an infinite process-spawn loop.
//!
//! (`locate_tp_runner` lives in `tp-proto::locate` — see the note above
//! `find_repo_root`. The Bun-blob resolver `locate_bun_blob` that used to live
//! here was deleted with the `tpd` blob in PR6 of the #5 zero-Bun cascade.)

use std::path::{Path, PathBuf};

/// Resolve the shipped Rust `tp-daemon` binary for exec (ADR-0003 Phase 4 A1).
///
/// The env override is `TP_DAEMON_BIN`; the dev fallback is the cargo bin
/// `<repo>/rust/target/release/tp-daemon`.
///
/// # Resolution order (first match wins)
/// 1. `$TP_DAEMON_BIN` — absolute-path override: honors a full path the
///    operator/harness already built (an escape hatch, never a toggle). The E2E
///    harness (`tp-e2e-holder` spawn seam) injects it. Historical note: the same
///    env var was read by the retired TS-side dual-run seam
///    (`apps/cli/src/lib/daemon-bin.ts` `resolveDaemonBinOverride`, deleted with
///    the Bun CLI in #5 PR6), so during the migration either `tp` resolved the
///    same binary from it.
/// 2. `canonicalize(current_exe) → ../../libexec/tp/tp-daemon` — release prefix
///    tree, alongside `tp-relay` / `tp-runner`.
/// 3. Sibling `tp-daemon` next to the Rust `tp` binary — flat dogfood drop.
/// 4. Dev fallback: walk up to the repo root and use
///    `<repo>/rust/target/release/tp-daemon`.
/// 5. Hard error.
///
/// Carries the shared `is_self` infinite-loop guard (module docs).
///
/// Wired by the daemon default-flip (task #4): the real callers are
/// `ensure_daemon.rs::spawn_background_daemon` (background auto-spawn) and
/// `commands/daemon.rs::start` (foreground `tp daemon start` — the seam
/// installed launchd/systemd services exec).
pub fn locate_tp_daemon() -> Result<PathBuf, String> {
    let current_canon = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());

    locate_tp_daemon_inner(current_canon.as_deref())
}

/// Inner implementation with injectable current-exe canonical path for testing.
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
/// cargo binary (the standalone relay server, `rust/tp-relay`).
///
/// # Resolution order (first match wins)
/// 1. `$TP_RELAY_BIN` — absolute-path override (escape hatch for dev / test).
/// 2. `canonicalize(current_exe) → ../../libexec/tp/tp-relay` — release prefix
///    tree, alongside `tp-daemon` / `tp-runner`.
/// 3. Sibling `tp-relay` next to the Rust `tp` binary — flat dogfood drop.
/// 4. Dev fallback: `<repo>/rust/target/release/tp-relay`.
/// 5. Hard error.
///
/// Carries the shared `is_self` infinite-loop guard (module docs).
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

// NOTE: `locate_tp_runner` moved to `tp-proto::locate` (task #4 runner flip).
// After the flip, both `tp-daemon` (per-session spawn via
// `session::manager::default_runner_command`) and `tp-cli` need to resolve the
// SAME `tp-runner`, and `tp-daemon` cannot depend on `tp-cli` (circular — the
// CLI locates and spawns the daemon). The shared home is `tp-proto`, which both
// crates already depend on and which already hosts sibling path-resolution
// (`socket_path::resolve_runtime_dir`). The `locate_tp_daemon` /
// `locate_tp_relay` resolvers above STAY here — each has a single (CLI-only)
// consumer, so no cross-crate agreement invariant applies to them.

/// Walk up the filesystem from `start`, looking for a directory that contains
/// `rust/tp-cli/Cargo.toml` — the repo root sentinel. Returns the first match.
///
/// Chosen over `apps/cli/src/index.ts` (deleted in #5 PR6) and over
/// `rust/Cargo.lock` (committed, but a generic 2-segment workspace-convention
/// path with higher false-positive risk). `rust/tp-cli/Cargo.toml` names this
/// specific tp-cli crate (`name = "tp-cli"`), preserving the original
/// sentinel's intent: identify the root of the tp CLI's own source tree.
pub(crate) fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    for _ in 0..16 {
        if !current.pop() {
            break;
        }
        if current
            .join("rust")
            .join("tp-cli")
            .join("Cargo.toml")
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

    // ── Prefix tree with a deeper symlink path ───────────────────────────────

    #[test]
    fn prefix_tree_local_bin_shape() {
        // Simulate ~/.local/bin/tp → ~/.local/share/tp/bin/tp (after symlink
        // resolution).  Prefix = ~/.local/share/tp → tp-daemon at
        // ~/.local/share/tp/libexec/tp/tp-daemon.
        let canon = PathBuf::from("/home/u/.local/share/tp/bin/tp");
        let candidate = canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-daemon"));
        assert_eq!(
            candidate,
            Some(PathBuf::from(
                "/home/u/.local/share/tp/libexec/tp/tp-daemon"
            ))
        );
    }

    // ── find_repo_root locates the real repo ─────────────────────────────────

    #[test]
    fn find_repo_root_finds_this_repo() {
        // The test binary lives somewhere under rust/target/… — walking up should
        // reach the repo root that contains rust/tp-cli/Cargo.toml.
        let exe = std::env::current_exe().unwrap();
        let root = find_repo_root(&exe);
        assert!(
            root.is_some(),
            "should find repo root from test binary path"
        );
        let root = root.unwrap();
        assert!(
            root.join("rust").join("tp-cli").join("Cargo.toml").exists(),
            "repo root should contain rust/tp-cli/Cargo.toml: {root:?}"
        );
    }

    // ── find_repo_root: no sentinel → None ───────────────────────────────────

    #[test]
    fn find_repo_root_none_when_sentinel_absent() {
        // A path deep under /tmp won't have the repo sentinel.
        let p = PathBuf::from("/tmp/tp-locate-test-xyz/a/b/c/binary");
        assert!(find_repo_root(&p).is_none());
    }

    // ── find_repo_root: pins WHICH sentinel file is recognized ──────────────

    #[test]
    fn find_repo_root_pins_new_sentinel_not_old() {
        // apps/cli/src/index.ts (the retired Bun CLI sentinel) was deleted in
        // #5 PR6. This synthetic tree pins the sentinel choice: the old
        // sentinel alone must NOT be recognized, the new one alone must be.
        let tmp = tmpdir();
        let root = tmp.path().join("repo");
        let old_sentinel = root.join("apps").join("cli").join("src").join("index.ts");
        fs::create_dir_all(old_sentinel.parent().unwrap()).unwrap();
        fs::write(&old_sentinel, "// legacy sentinel").unwrap();
        let start = root.join("rust").join("target").join("debug").join("tp");
        fs::create_dir_all(start.parent().unwrap()).unwrap();
        assert!(
            find_repo_root(&start).is_none(),
            "retired apps/cli sentinel alone must not mark a repo root"
        );

        let new_sentinel = root.join("rust").join("tp-cli").join("Cargo.toml");
        fs::create_dir_all(new_sentinel.parent().unwrap()).unwrap();
        fs::write(&new_sentinel, "[package]\nname = \"tp-cli\"\n").unwrap();
        assert_eq!(find_repo_root(&start).as_deref(), Some(root.as_path()));
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
        // /opt/tp/libexec/tp/tp-daemon (alongside tp-relay / tp-runner).
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
        // The daemon dev fallback is the cargo bin path
        // <repo>/rust/target/release/tp-daemon.
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
        // /opt/tp/libexec/tp/tp-relay (alongside tp-daemon / tp-runner).
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

    // NOTE: the tp-runner resolver + its geometry/error tests moved to
    // `tp-proto::locate` (task #4 runner flip). The daemon/relay resolver
    // tests above stay here with their resolvers.
}
