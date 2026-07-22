//! Env handling — empty string == unset for EVERY variable (the harness passes
//! `TP_RUNNER_BIN`/`TP_DAEMON_BIN` unconditionally, empty when a gate is off),
//! plus the isolated-XDG directory bootstrap.

use crate::out::die;

/// Read an env var, treating the empty string as unset (Bun-holder parity:
/// `process.env[k] || undefined` style reads).
pub fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Ensure the isolated XDG dirs exist (the daemon mkdir's the store itself, but
/// the runtime dir for the socket must be present + 0700 before the daemon
/// binds). Mirrors `ensureIsolationDirs` in the retired Bun holder.
pub fn ensure_isolation_dirs() {
    let Some(runtime) = env_nonempty("XDG_RUNTIME_DIR") else {
        die("XDG_RUNTIME_DIR must be set (isolated socket dir)");
    };
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    if let Err(err) = builder.create(&runtime) {
        die(&format!("mkdir {runtime} failed: {err}"));
    }
    for var in ["XDG_DATA_HOME", "XDG_CONFIG_HOME"] {
        if let Some(dir) = env_nonempty(var) {
            if let Err(err) = std::fs::create_dir_all(&dir) {
                die(&format!("mkdir {dir} failed: {err}"));
            }
        }
    }
}
