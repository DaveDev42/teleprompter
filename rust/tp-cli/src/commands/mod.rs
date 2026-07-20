//! Subcommand handlers. One module per command; each exposes a `run(...)`/
//! `list(...)` that returns a `std::process::ExitCode`. New tranches add modules
//! here.

pub mod completions;
pub mod completions_install;
pub mod daemon;
pub mod doctor;
pub mod forward;
pub mod forward_claude;
pub mod logs;
pub mod pair;
pub mod passthrough;
pub mod passthrough_split;
pub mod relay;
pub mod run;
pub mod session;
pub mod status;
pub mod upgrade;
pub mod version;
