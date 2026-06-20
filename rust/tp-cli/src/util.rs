//! Small shared utilities.

use std::time::{SystemTime, UNIX_EPOCH};

/// Current wall-clock time in milliseconds since the Unix epoch — the Rust
/// equivalent of `Date.now()`. Read once per command and threaded into pure
/// formatting (`format_age`) so the formatting stays testable.
pub fn now_ms() -> i64 {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // u128 ms → i64 is safe for any realistic date (i64 ms overflows in year
    // ~292 million).
    #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
    {
        dur.as_millis() as i64
    }
}
