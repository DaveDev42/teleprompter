//! Subcommand handlers. One module per command; each exposes a `run(...)` that
//! returns a `std::process::ExitCode`. New tranches add modules here.

pub mod version;
