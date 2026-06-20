//! Build script: surface the canonical `tp` version to the binary as
//! `TP_CLI_VERSION` so `tp version` reports the SAME number the Bun CLI did.
//!
//! The Bun CLI read the version from the root `package.json` (the field
//! release-please bumps — `apps/cli/src/commands/version.ts:16`). To avoid a
//! second source of truth drifting out of sync, this script parses that same
//! root `package.json` at build time and bakes its `version` into the binary.
//! `tp-cli/Cargo.toml`'s own `version` is intentionally NOT the user-facing
//! version (it stays a placeholder); release-please keeps touching only
//! `package.json`, and this script forwards that value.
//!
//! Resolution order for the version string:
//!   1. `TP_CLI_VERSION` env (CI/release can inject an exact value)
//!   2. root `package.json` `"version"` (the normal dev/build path)
//!   3. `CARGO_PKG_VERSION` (last-resort fallback so a build never fails here)

use std::path::PathBuf;

fn main() {
    // Re-run if either the env override or the root manifest changes.
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

    // 2. Root package.json. CARGO_MANIFEST_DIR = rust/tp-cli, so the repo root
    //    is two levels up (rust/tp-cli -> rust -> <root>).
    let manifest_dir = PathBuf::from(env_or_empty("CARGO_MANIFEST_DIR"));
    let root_pkg = manifest_dir
        .parent() // rust/
        .and_then(|p| p.parent()) // <root>/
        .map(|root| root.join("package.json"));

    if let Some(pkg_path) = root_pkg {
        println!("cargo:rerun-if-changed={}", pkg_path.display());
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if let Some(v) = parse_version_field(&contents) {
                return v;
            }
        }
    }

    // 3. Fallback: the crate's own Cargo.toml version (placeholder).
    env_or_empty("CARGO_PKG_VERSION")
}

/// Minimal `"version": "x.y.z"` extractor — avoids pulling `serde_json` into
/// the build-dependency graph for one field. `package.json` is machine-generated
/// by release-please, so the field shape is stable.
fn parse_version_field(json: &str) -> Option<String> {
    let key = "\"version\"";
    let key_pos = json.find(key)?;
    let after_key = &json[key_pos + key.len()..];
    let colon_pos = after_key.find(':')?;
    let after_colon = &after_key[colon_pos + 1..];
    let open_quote = after_colon.find('"')?;
    let rest = &after_colon[open_quote + 1..];
    let close_quote = rest.find('"')?;
    let value = &rest[..close_quote];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn env_or_empty(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}
