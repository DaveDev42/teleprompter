//! Build script: surface the canonical `tp` version to the binary as
//! `TP_CLI_VERSION` so `tp version` reports the release-please-managed number.
//!
//! The canonical version lives in the root `version.txt` (release-please
//! `release-type: simple` bumps that file — it replaced the root
//! `package.json` `"version"` field when the Node toolchain was removed in
//! #5 PR7). To avoid a second source of truth drifting out of sync, this
//! script reads that same file at build time and bakes its contents into the
//! binary. `tp-cli/Cargo.toml`'s own `version` is intentionally NOT the
//! user-facing version (it stays a placeholder); release-please keeps touching
//! only `version.txt`, and this script forwards that value.
//!
//! Resolution order for the version string:
//!   1. `TP_CLI_VERSION` env (CI/release can inject an exact value)
//!   2. root `version.txt` (the normal dev/build path)
//!   3. `CARGO_PKG_VERSION` (last-resort fallback so a build never fails here)

use std::path::PathBuf;

fn main() {
    // Re-run if either the env override or the root version file changes.
    println!("cargo:rerun-if-env-changed=TP_CLI_VERSION");

    let version = resolve_version();
    println!("cargo:rustc-env=TP_CLI_VERSION={version}");
}

fn resolve_version() -> String {
    // 1. Explicit env override (CI/release path).
    if let Ok(v) = std::env::var("TP_CLI_VERSION") {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }

    // 2. Root version.txt. CARGO_MANIFEST_DIR = rust/tp-cli, so the repo root
    //    is two levels up (rust/tp-cli -> rust -> <root>).
    let manifest_dir = PathBuf::from(env_or_empty("CARGO_MANIFEST_DIR"));
    let version_file = manifest_dir
        .parent() // rust/
        .and_then(|p| p.parent()) // <root>/
        .map(|root| root.join("version.txt"));

    if let Some(path) = version_file {
        println!("cargo:rerun-if-changed={}", path.display());
        if let Ok(contents) = std::fs::read_to_string(&path) {
            let v = contents.trim();
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }

    // 3. Fallback: the crate's own Cargo.toml version (placeholder).
    env_or_empty("CARGO_PKG_VERSION")
}

fn env_or_empty(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}
