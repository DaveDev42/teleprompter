//! `locate_tp_runner()` — resolve the shipped Rust `tp-runner` binary for exec.
//!
//! # Why this lives in `tp-proto` (not `tp-cli`)
//!
//! After the daemon+runner default-flip (task #4) TWO crates must agree on the
//! same `tp-runner` path:
//!   - the Rust daemon (`tp-daemon`) spawns it per session
//!     (`session::manager::default_runner_command`), and
//!   - the CLI (`tp-cli`) resolves it for its own runner call site.
//!
//! `tp-daemon` cannot call `tp-cli` (that would be circular — `tp-cli` locates
//! and spawns `tp-daemon`). Both already depend on `tp-proto`, which is the
//! natural shared home for this path-resolution (it already hosts
//! `socket_path::resolve_runtime_dir`, the same category of env+XDG path logic).
//! Keeping the resolver here is a single source of truth, so the daemon and the
//! CLI can never drift to different `tp-runner` binaries.
//!
//! The sibling resolvers `locate_tp_daemon` / `locate_tp_relay` / `locate_bun_blob`
//! stay in `tp-cli::locate` — each has a single consumer (the CLI), so no
//! cross-crate agreement invariant applies to them; only `tp-runner` gained a
//! second consumer at the flip.
//!
//! # Resolution order (first match wins)
//!
//! 1. `$TP_RUNNER_BIN` — absolute-path override. This is the SAME env var the
//!    TS-side opt-in seam reads (`apps/cli/src/lib/runner-bin.ts`
//!    `resolveRunnerBinOverride`) and the E2E parity harness injects — a shared
//!    escape hatch the operator/harness already built, never a toggle.
//! 2. `canonicalize(current_exe) → ../../libexec/tp/tp-runner` — release prefix
//!    tree, alongside `tpd` / `tp-daemon` / `tp-relay`. When the exe is
//!    `<prefix>/bin/tp` (or the `tp-daemon` binary at `<prefix>/libexec/tp/tp-daemon`),
//!    `canonicalize` + `../..` lands on `<prefix>`.
//! 3. Sibling `tp-runner` next to the current binary — flat dogfood drop.
//! 4. Dev fallback: walk up to the repo root and use
//!    `<repo>/rust/target/release/tp-runner`.
//! 5. Hard error.
//!
//! # Infinite-loop guard
//!
//! Carries the same `is_self` guard as `tp-cli`'s `locate_bun_blob`: a candidate
//! that canonicalizes to the current executable is rejected so a
//! misconfiguration cannot spawn the caller as its own runner.

use std::path::{Path, PathBuf};

/// Resolve the shipped Rust `tp-runner` binary for exec. See module docs for the
/// resolution order and the infinite-loop guard.
///
/// Returns the path on success, or an error string (suitable for printing to
/// stderr) on failure.
pub fn locate_tp_runner() -> Result<PathBuf, String> {
    let current_canon = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());

    locate_tp_runner_inner(current_canon.as_deref())
}

/// Inner implementation with injectable current-exe canonical path for testing.
fn locate_tp_runner_inner(current_canon: Option<&Path>) -> Result<PathBuf, String> {
    let is_self = |candidate: &Path| -> bool {
        if let (Some(c), Some(me)) = (std::fs::canonicalize(candidate).ok(), current_canon) {
            c == me
        } else {
            false
        }
    };

    // ── 1. $TP_RUNNER_BIN override ────────────────────────────────────────────
    if let Ok(bin) = std::env::var("TP_RUNNER_BIN") {
        if !bin.is_empty() {
            let p = PathBuf::from(&bin);
            if is_self(&p) {
                return Err(format!(
                    "tp: TP_RUNNER_BIN resolves to the tp binary itself ({bin}); \
                     infinite loop prevented. Set TP_RUNNER_BIN to the tp-runner binary."
                ));
            }
            if p.exists() {
                return Ok(p);
            }
            return Err(format!(
                "tp: TP_RUNNER_BIN is set to '{bin}' but that file does not exist."
            ));
        }
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("tp: cannot determine current executable path: {e}"))?;

    // ── 2. Release prefix tree: canonicalize → ../../libexec/tp/tp-runner ─────
    let candidate2 = std::fs::canonicalize(&exe_path).ok().and_then(|canon| {
        canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-runner"))
    });

    if let Some(ref p) = candidate2 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 3. Sibling tp-runner next to the current binary ───────────────────────
    let candidate3 = exe_path.parent().map(|dir| dir.join("tp-runner"));

    if let Some(ref p) = candidate3 {
        if !is_self(p) && p.exists() {
            return Ok(p.clone());
        }
    }

    // ── 4. Dev fallback: <repo>/rust/target/release/tp-runner ─────────────────
    let candidate4 = find_repo_root(&exe_path).map(|root| {
        root.join("rust")
            .join("target")
            .join("release")
            .join("tp-runner")
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
        "tp: bundled tp-runner not found (looked in {}). \
         Reinstall tp or set TP_RUNNER_BIN.",
        searched.join(", ")
    ))
}

/// Walk up the filesystem from `start`, looking for a directory that contains
/// `rust/tp-cli/Cargo.toml` — the repo root sentinel. Returns the first match.
///
/// Chosen over `apps/cli/src/index.ts` (task #5 deletes it) and over
/// `rust/Cargo.lock` (committed, but a generic 2-segment workspace-convention
/// path with higher false-positive risk). `rust/tp-cli/Cargo.toml` names this
/// specific tp-cli crate (`name = "tp-cli"`), preserving the original
/// sentinel's intent: identify the root of the tp CLI's own source tree.
///
/// This is a scoped copy of `tp-cli::locate::find_repo_root` — a trivial
/// directory-walk with a sentinel string, duplicated (rather than shared)
/// because `tp-cli` retains three live callers of its own copy
/// (`locate_bun_blob` / `locate_tp_daemon` / `locate_tp_relay`) and the walk
/// carries no cross-crate agreement invariant (both copies key off the same
/// committed sentinel path).
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
// Unit tests (relocated verbatim from tp-cli::locate — pure path geometry +
// the exact error strings; assertions unchanged, only the crate moved).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::TempDir::new().expect("tempdir")
    }

    // ── tp-runner: prefix-tree candidate ──────────────────────────────────────

    #[test]
    fn tp_runner_prefix_tree_candidate_shape() {
        // canon = /opt/tp/bin/tp → prefix = /opt/tp → tp-runner at
        // /opt/tp/libexec/tp/tp-runner (alongside tpd / tp-daemon / tp-relay).
        let canon = PathBuf::from("/opt/tp/bin/tp");
        let candidate = canon
            .parent()
            .and_then(|bin| bin.parent())
            .map(|prefix| prefix.join("libexec").join("tp").join("tp-runner"));
        assert_eq!(
            candidate,
            Some(PathBuf::from("/opt/tp/libexec/tp/tp-runner"))
        );
    }

    // ── tp-runner: sibling candidate ──────────────────────────────────────────

    #[test]
    fn tp_runner_sibling_candidate_shape() {
        let exe = PathBuf::from("/usr/local/bin/tp");
        let sibling = exe.parent().map(|d| d.join("tp-runner"));
        assert_eq!(sibling, Some(PathBuf::from("/usr/local/bin/tp-runner")));
    }

    // ── tp-runner: dev fallback is rust/target/release ────────────────────────

    #[test]
    fn tp_runner_dev_fallback_shape() {
        let root = PathBuf::from("/home/u/teleprompter");
        let candidate = root
            .join("rust")
            .join("target")
            .join("release")
            .join("tp-runner");
        assert_eq!(
            candidate,
            PathBuf::from("/home/u/teleprompter/rust/target/release/tp-runner")
        );
    }

    // ── tp-runner: not-found error message ────────────────────────────────────

    #[test]
    fn tp_runner_not_found_error_mentions_reinstall_and_runner_bin() {
        let bogus_self = PathBuf::from("/tmp/tp-proto-bogus-self-runner-xyz/tp");
        if let Err(msg) = locate_tp_runner_inner(Some(&bogus_self)) {
            assert!(
                msg.contains("tp-runner not found") && msg.contains("TP_RUNNER_BIN"),
                "error should mention TP_RUNNER_BIN: {msg}"
            );
            assert!(msg.contains("Reinstall"), "should mention Reinstall: {msg}");
        }
    }

    // ── find_repo_root locates the real repo ──────────────────────────────────

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

    // ── find_repo_root: no sentinel → None ────────────────────────────────────

    #[test]
    fn find_repo_root_none_when_sentinel_absent() {
        let p = PathBuf::from("/tmp/tp-locate-test-xyz/a/b/c/binary");
        assert!(find_repo_root(&p).is_none());
    }

    // ── find_repo_root: pins WHICH sentinel file is recognized ────────────────

    #[test]
    fn find_repo_root_pins_new_sentinel_not_old() {
        // The old apps/cli/src/index.ts sentinel alone must NOT be recognized;
        // the new rust/tp-cli/Cargo.toml alone must be.
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
}
