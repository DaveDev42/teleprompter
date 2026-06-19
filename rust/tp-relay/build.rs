//! Build script — inject the compile-time build identity the `/health` and
//! `/metrics` endpoints report, mirroring the TS `bun build --define` of
//! `TP_BUILD_SHA` / `TP_BUILD_TIME` (`relay-server.ts:19-26`).
//!
//! The binary reads these via `env!("TP_BUILD_SHA")` / `env!("TP_BUILD_TIME")`
//! (see `http.rs`). The deploy pipeline asserts `/health.buildSha == github.sha`
//! to catch a stale binary, so CI MUST be able to set the SHA explicitly.
//!
//! ## Precedence
//!
//! * **`TP_BUILD_SHA`**: env `TP_BUILD_SHA` (CI passes `github.sha`) → else
//!   `git rev-parse --short HEAD` → else `"unknown"`.
//! * **`TP_BUILD_TIME`**: env `TP_BUILD_TIME` → else, if `SOURCE_DATE_EPOCH` is
//!   set (reproducible-build clock), an RFC-3339 UTC timestamp from it → else
//!   `"unknown"`.
//!
//! `rerun-if-env-changed` is declared for both override vars (and
//! `SOURCE_DATE_EPOCH`) so a changed value re-runs the script; the git HEAD is
//! also tracked so a new commit refreshes the fallback SHA.

use std::process::Command;

fn main() {
    // Re-run when any input that feeds the injected constants changes.
    println!("cargo:rerun-if-env-changed=TP_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=TP_BUILD_TIME");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    // Track HEAD so the git-fallback SHA refreshes on a new commit.
    println!("cargo:rerun-if-changed=../../.git/HEAD");

    let build_sha = resolve_build_sha();
    let build_time = resolve_build_time();

    println!("cargo:rustc-env=TP_BUILD_SHA={build_sha}");
    println!("cargo:rustc-env=TP_BUILD_TIME={build_time}");
}

/// env `TP_BUILD_SHA` → `git rev-parse --short HEAD` → `"unknown"`.
fn resolve_build_sha() -> String {
    if let Some(sha) = non_empty_env("TP_BUILD_SHA") {
        return sha;
    }
    git_short_head().unwrap_or_else(|| "unknown".to_string())
}

/// env `TP_BUILD_TIME` → RFC-3339 from `SOURCE_DATE_EPOCH` → `"unknown"`.
fn resolve_build_time() -> String {
    if let Some(t) = non_empty_env("TP_BUILD_TIME") {
        return t;
    }
    if let Some(epoch) = non_empty_env("SOURCE_DATE_EPOCH") {
        if let Ok(secs) = epoch.parse::<u64>() {
            return rfc3339_utc(secs);
        }
    }
    "unknown".to_string()
}

/// Read an env var, returning `None` for absent OR empty (so `FOO=` falls back).
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// `git rev-parse --short HEAD`, or `None` if git is absent / not a repo.
fn git_short_head() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Format a Unix-epoch-seconds timestamp as `YYYY-MM-DDTHH:MM:SSZ` (UTC). Pure
/// integer civil-calendar math — no chrono dependency in the build graph.
#[allow(clippy::many_single_char_names, clippy::cast_possible_wrap)]
fn rfc3339_utc(secs: u64) -> String {
    let day_secs = secs % 86_400;
    let s = day_secs % 60;
    let m = (day_secs / 60) % 60;
    let h = day_secs / 3600;
    let days = secs / 86_400; // days since 1970-01-01

    // Civil-from-days (Howard Hinnant), days are non-negative.
    let z = days as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}
