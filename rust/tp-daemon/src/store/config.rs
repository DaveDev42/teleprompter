//! Store directory resolution.
//!
//! Byte-exact port of `packages/daemon/src/store/config.ts`. Resolves the
//! same on-disk vault directory the Bun daemon uses, so both binaries share
//! one `sessions.sqlite` + per-session `<sid>.sqlite` tree.

use std::env;
use std::fs;
use std::path::PathBuf;

/// Pure resolution of the store directory path from the two env inputs the TS
/// `getStoreDir()` reads (`XDG_DATA_HOME`, `HOME`). Factored out of
/// [`get_store_dir`] so tests can exercise the XDG/HOME fallback logic
/// without mutating real process environment variables — `std::env::set_var`
/// requires `unsafe` (Rust 2024 edition semantics) and this workspace forbids
/// `unsafe_code` even in tests (`[workspace.lints.rust] unsafe_code =
/// "forbid"`).
///
/// # Panics
/// Panics if both `xdg_data_home` and `home` are `None` (mirrors the TS
/// `os.homedir()` call, which assumes a POSIX environment with a resolvable
/// home directory).
fn resolve_store_dir(xdg_data_home: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    let data_home = xdg_data_home.unwrap_or_else(|| {
        home.expect("HOME must be set to resolve the store dir")
            .join(".local")
            .join("share")
    });
    data_home.join("teleprompter").join("vault")
}

/// Resolve (and create) the store directory: `$XDG_DATA_HOME/teleprompter/vault`,
/// falling back to `$HOME/.local/share/teleprompter/vault` when
/// `XDG_DATA_HOME` is unset. Also creates the `<vault>/sessions` subdirectory
/// (recursive) as a side effect, mirroring the TS `getStoreDir()`.
///
/// # Panics
/// Panics if `HOME` cannot be resolved (mirrors the TS `os.homedir()` — both
/// assume a POSIX environment with a resolvable home directory) or if the
/// directory cannot be created.
#[must_use]
pub fn get_store_dir() -> PathBuf {
    let store_dir = resolve_store_dir(
        env::var_os("XDG_DATA_HOME").map(PathBuf::from),
        env::var_os("HOME").map(PathBuf::from),
    );
    fs::create_dir_all(store_dir.join("sessions"))
        .expect("failed to create the teleprompter vault sessions dir");
    store_dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_under_xdg_data_home_when_set() {
        let dir = resolve_store_dir(
            Some(PathBuf::from("/tmp/xdg")),
            Some(PathBuf::from("/home/dave")),
        );
        assert_eq!(dir, PathBuf::from("/tmp/xdg/teleprompter/vault"));
    }

    #[test]
    fn falls_back_to_home_local_share_when_xdg_unset() {
        let dir = resolve_store_dir(None, Some(PathBuf::from("/home/dave")));
        assert_eq!(
            dir,
            PathBuf::from("/home/dave/.local/share/teleprompter/vault")
        );
    }

    #[test]
    #[should_panic(expected = "HOME must be set")]
    fn panics_when_neither_xdg_nor_home_set() {
        let _ = resolve_store_dir(None, None);
    }

    #[test]
    fn get_store_dir_creates_sessions_subdir() {
        // Exercise the real env-reading + mkdir path at least once (without
        // mutating env — this just asserts the live process env resolves to
        // *some* dir and that dir + its sessions subdir exist afterward).
        let dir = get_store_dir();
        assert!(dir.join("sessions").is_dir());
    }
}
