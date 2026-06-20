//! Raw-mode RAII guard for crossterm terminal manipulation.
//!
//! The `RawModeGuard` enables raw mode on construction and unconditionally
//! restores the terminal (disables raw mode) on `Drop` — this means every
//! exit path from the interactive TUI (clean return, `?`-propagation, or
//! panic) automatically restores the user's terminal. Without this guard a
//! panic or early return would leave the shell stuck in raw mode.
//!
//! Usage (typical):
//! ```ignore
//! let _guard = RawModeGuard::enable()?;
//! // ... draw TUI, read key events ...
//! // guard drops here (or on any `?`-return), restoring the terminal
//! ```
//!
//! The guard is reusable: `session cleanup` and future interactive commands
//! (`pair new`, etc.) all import from this module.

use std::io;

use crossterm::terminal;

/// RAII guard that enables raw mode on creation and disables it on `Drop`.
///
/// Constructed via [`RawModeGuard::enable`]. Holding this value keeps the
/// terminal in raw mode; dropping it (on any code path) restores it.
pub struct RawModeGuard;

impl RawModeGuard {
    /// Enable raw mode and return a guard that will disable it on drop.
    ///
    /// Returns an `io::Error` if the terminal cannot be put into raw mode
    /// (e.g. not a real TTY — callers should guard with `IsTerminal` first).
    pub fn enable() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        // Best-effort: errors during cleanup cannot propagate, so discard.
        let _ = terminal::disable_raw_mode();
    }
}
