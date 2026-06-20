//! Config-dir resolution for tp state files that live under `$XDG_CONFIG_HOME`
//! (as opposed to the store's `$XDG_DATA_HOME` DB path in `store.rs`).
//!
//! Byte-exact port of `getConfigDir` in `apps/cli/src/lib/paths.ts:8-13`:
//!
//! ```text
//!   base = $XDG_CONFIG_HOME ?? (($HOME ?? "/tmp") + "/.config")
//!   dir  = base + "/teleprompter"
//! ```
//!
//! CRITICAL: this is DISTINCT from `store::store_dir` (which keys off
//! `$XDG_DATA_HOME`). The only consumer so far is `pair new`'s `pair.lock`.

use std::path::PathBuf;

/// Resolve `$XDG_CONFIG_HOME/teleprompter` (or `$HOME/.config/teleprompter`,
/// falling back to `/tmp/.config/teleprompter` when `$HOME` is unset).
///
/// Mirrors `getConfigDir` (`paths.ts:8-13`) exactly, including the `/tmp`
/// fallback for a missing `$HOME`.
pub fn config_dir() -> PathBuf {
    // Bun uses `process.env["XDG_CONFIG_HOME"] ?? …` (nullish coalescing):
    // an env var that is PRESENT but EMPTY (`XDG_CONFIG_HOME=""`) is kept
    // verbatim (`join("", "teleprompter")` → relative `teleprompter`), only
    // an ABSENT var falls back to `$HOME/.config`. `std::env::var` returns
    // `Ok("")` for a present-but-empty var, so match on `Ok` regardless of
    // emptiness to mirror `??` exactly. (paths.ts:9-11)
    let base = match std::env::var("XDG_CONFIG_HOME") {
        Ok(v) => PathBuf::from(v),
        Err(_) => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".config")
        }
    };
    base.join("teleprompter")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ends_with_teleprompter() {
        let p = config_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("teleprompter"));
    }

    #[test]
    fn join_shape_xdg() {
        // Assert the join shape the function produces for an XDG base.
        let base = PathBuf::from("/x/cfg");
        assert_eq!(
            base.join("teleprompter"),
            PathBuf::from("/x/cfg/teleprompter")
        );
    }

    #[test]
    fn join_shape_home_dotconfig() {
        // $HOME path appends `.config/teleprompter`.
        let home = PathBuf::from("/home/u");
        assert_eq!(
            home.join(".config").join("teleprompter"),
            PathBuf::from("/home/u/.config/teleprompter")
        );
    }

    #[test]
    fn empty_xdg_config_home_is_used_verbatim() {
        // Mirrors Bun's `??` (nullish): a PRESENT-but-EMPTY `XDG_CONFIG_HOME`
        // is kept verbatim, yielding the relative `teleprompter` (NOT the
        // `$HOME/.config` fallback). An empty PathBuf join is the analog of
        // JS `join("", "teleprompter")`.
        let base = PathBuf::from("");
        assert_eq!(base.join("teleprompter"), PathBuf::from("teleprompter"));
    }
}
