//! Byte-exact port of `apps/cli/src/lib/format.ts` helpers.
//!
//! - `format_age` — `formatAge(ms)` time-since humanizer.
//! - `error_with_hints` — `errorWithHints(msg, hints[])` error formatter
//!   (upgrade.ts consumer; `apps/cli/src/lib/format.ts:14`).
//!
//! Renders an age in milliseconds as "N unit ago", rolling up
//! seconds → minutes → hours → days, and falling back to an ISO date
//! (`YYYY-MM-DD`) for ages ≥ 7 days. The ≥7d branch is computed as
//! `(now_ms - age_ms)` rendered as a UTC calendar date — so the Rust port must
//! reproduce the same UTC date arithmetic, NOT local time, to stay byte-exact.

/// Byte-exact port of `errorWithHints(message, hints)` from
/// `apps/cli/src/lib/format.ts:14`.
///
/// Returns:
/// ```text
/// <message>
///   → <hint0>
///   → <hint1>
/// ```
/// Each hint is prefixed with exactly two spaces + U+2192 (→) + one space.
/// The result joins with `\n`, message first. Byte-exact:
/// `error_with_hints("X", &["a","b"]) == "X\n  → a\n  → b"`.
pub fn error_with_hints(message: &str, hints: &[&str]) -> String {
    let mut parts = vec![message.to_string()];
    for h in hints {
        parts.push(format!("  \u{2192} {h}"));
    }
    parts.join("\n")
}

/// Render an age in milliseconds, given the current wall-clock `now_ms`
/// (passed in so the function is pure and testable — the caller reads the clock
/// once and derives `age_ms = now_ms - updated_at_ms`).
pub fn format_age(age_ms: i64, now_ms: i64) -> String {
    let seconds = age_ms.div_euclid(1000);
    if seconds < 60 {
        return format!("{seconds}s ago");
    }
    let minutes = seconds.div_euclid(60);
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes.div_euclid(60);
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours.div_euclid(24);
    if days < 7 {
        return format!("{days}d ago");
    }
    // ≥7d: ISO date of (now - age) in UTC, sliced to YYYY-MM-DD. Mirrors
    // `new Date(Date.now() - ms).toISOString().slice(0, 10)`.
    iso_date_utc(now_ms - age_ms)
}

/// Format a millisecond UTC epoch as `YYYY-MM-DD`. Implements the same civil
/// date computation as JS `Date#toISOString().slice(0,10)` without pulling in a
/// datetime crate (the algorithm is Howard Hinnant's `civil_from_days`, the
/// canonical proleptic-Gregorian conversion that matches ECMAScript's date math).
fn iso_date_utc(epoch_ms: i64) -> String {
    // Days since the Unix epoch, flooring toward negative infinity so dates
    // before 1970 (age far in the future is impossible, but be correct anyway)
    // round the same way JS does.
    let days = epoch_ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Convert a day count since 1970-01-01 to a `(year, month, day)` civil date.
/// Howard Hinnant's algorithm (`http://howardhinnant.github.io/date_algorithms.html`),
/// valid for the full range JS dates can express.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (year, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── error_with_hints ─────────────────────────────────────────────────────

    #[test]
    fn error_with_hints_byte_exact_no_hints() {
        assert_eq!(error_with_hints("X", &[]), "X");
    }

    #[test]
    fn error_with_hints_byte_exact_two_hints() {
        // Byte-exact assertion from the brief: "X\n  → a\n  → b"
        // U+2192 = → (RIGHT ARROW, 3 UTF-8 bytes: 0xE2 0x86 0x92)
        let got = error_with_hints("X", &["a", "b"]);
        assert_eq!(got, "X\n  \u{2192} a\n  \u{2192} b");
    }

    #[test]
    fn error_with_hints_arrow_is_u2192() {
        let got = error_with_hints("msg", &["hint"]);
        // Confirm the arrow character is exactly U+2192, not an ASCII replacement.
        assert!(got.contains('\u{2192}'), "must use U+2192 arrow: {got:?}");
    }

    #[test]
    fn error_with_hints_format_ts_parity() {
        // mirrors apps/cli/src/lib/format.ts:14 — same join/map shape
        let got = error_with_hints(
            "Connection timed out.",
            &[
                "Check if daemon is running: tp status",
                "Diagnose: tp doctor",
            ],
        );
        let expected = "Connection timed out.\n  \u{2192} Check if daemon is running: tp status\n  \u{2192} Diagnose: tp doctor";
        assert_eq!(got, expected);
    }

    // Fixed clock for determinism: 2026-06-20T00:00:00Z = 1_781_000_000_000 ms
    // is close enough; we just need a stable reference.
    const NOW: i64 = 1_781_000_000_000;

    #[test]
    fn seconds_bucket() {
        assert_eq!(format_age(0, NOW), "0s ago");
        assert_eq!(format_age(59_000, NOW), "59s ago");
    }

    #[test]
    fn minutes_bucket() {
        assert_eq!(format_age(60_000, NOW), "1m ago");
        assert_eq!(format_age(59 * 60_000, NOW), "59m ago");
    }

    #[test]
    fn hours_bucket() {
        assert_eq!(format_age(60 * 60_000, NOW), "1h ago");
        assert_eq!(format_age(23 * 60 * 60_000, NOW), "23h ago");
    }

    #[test]
    fn days_bucket() {
        assert_eq!(format_age(24 * 60 * 60_000, NOW), "1d ago");
        assert_eq!(format_age(6 * 24 * 60 * 60_000, NOW), "6d ago");
    }

    #[test]
    fn iso_fallback_at_seven_days() {
        // 7 days before NOW. NOW = 1_781_000_000_000 ms.
        let seven_days_ms = 7 * 24 * 60 * 60 * 1000;
        let out = format_age(seven_days_ms, NOW);
        // Must be a YYYY-MM-DD shape, not "7d ago".
        assert_eq!(out.len(), 10);
        assert_eq!(out.as_bytes()[4], b'-');
        assert_eq!(out.as_bytes()[7], b'-');
        assert!(out.chars().filter(|&c| c == '-').count() == 2);
    }

    #[test]
    fn civil_date_known_values() {
        // Day 0 = 1970-01-01.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-03-01 is day 11017.
        assert_eq!(civil_from_days(11017), (2000, 3, 1));
        // 2026-06-20 — cross-check against a known epoch.
        // 1_781_000_000_000 ms / 86_400_000 = 20613 days → compute the date.
        let (y, _m, _d) = civil_from_days(20613);
        assert_eq!(y, 2026);
    }
}
