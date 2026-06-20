//! Terminal UI utilities for interactive subcommands.
//!
//! Currently contains:
//!  - [`raw_mode`] — RAII guard that ensures raw mode is always restored.
//!
//! Future interactive commands (`pair new`, etc.) should add modules here
//! rather than inlining crossterm usage in their command handlers.

pub mod raw_mode;
