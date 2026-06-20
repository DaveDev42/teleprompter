//! Subcommand handlers. One module per command; each exposes a `run(...)`/
//! `list(...)` that returns a `std::process::ExitCode`. New tranches add modules
//! here.

pub mod completions;
pub mod completions_install;
pub mod logs;
pub mod pair;
pub mod session;
pub mod status;
pub mod version;
