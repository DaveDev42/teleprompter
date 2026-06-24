//! Two-layer rate limiting — per-client and per-daemon-group.
//!
//! Port of the TypeScript fixed-window limiter (`relay-server.ts:1287-1311`,
//! constants `71-83`), redesigned per ADR-0003 §A1.4 to use **GCRA** (the
//! `governor` crate) instead of a 1-second tumbling window.  GCRA removes the
//! tumbling-window footgun where a client can send `2 * limit` messages across
//! a window boundary (`limit` at the tail of window N, `limit` at the head of
//! window N+1, ~0 ms apart).  The per-second *limit* is preserved exactly
//! (per-client 500, per-daemon-group 5000); only the smoothing changes, and it
//! changes in the conservative direction (GCRA admits a steady `limit/sec`
//! with a burst capacity of `limit`, never `2 * limit`).
//!
//! Both layers are checked on every inbound message **except** `relay.ping`
//! from an authenticated client (`relay-server.ts:685-686`); the caller is
//! responsible for that exemption.  On a rate-limit hit the frame is **dropped**
//! and a `relay.err { RATE_LIMITED }` is returned — the socket is **not** closed
//! (that is the slow-consumer/backpressure path, a different mechanism).

use std::num::NonZeroU32;

use governor::clock::DefaultClock;
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};

/// Default per-client (per-socket) message budget per second.  Mirrors
/// `RATE_LIMIT_MAX_MESSAGES = 500` (`relay-server.ts:72`), env
/// `TP_RELAY_RATE_PER_CLIENT`.
pub const DEFAULT_RATE_PER_CLIENT: u32 = 500;

/// Default per-daemon-group message budget per second (the daemon socket plus
/// every frontend attached to it, combined).  Mirrors
/// `DAEMON_GROUP_RATE_LIMIT = 5_000` (`relay-server.ts:75`), env
/// `TP_RELAY_RATE_PER_DAEMON`.
pub const DEFAULT_RATE_PER_DAEMON: u32 = 5_000;

/// A single GCRA limiter for one client or one daemon group.
///
/// `governor`'s direct (non-keyed) `RateLimiter` is `Send + Sync` and uses
/// atomics internally, so it can be shared behind an `Arc` and checked from the
/// connection's task without an outer lock.
pub struct Limiter {
    inner: RateLimiter<NotKeyed, InMemoryState, DefaultClock>,
}

impl Limiter {
    /// Build a per-second limiter admitting `per_second` cells with a burst
    /// capacity equal to `per_second`.  A `per_second` of 0 is clamped to 1
    /// (a zero quota is meaningless and `NonZeroU32` forbids it); callers
    /// should pass a positive limit.
    #[must_use]
    pub fn per_second(per_second: u32) -> Self {
        let cells = NonZeroU32::new(per_second.max(1)).unwrap_or(NonZeroU32::MIN);
        // `Quota::per_second(n)` replenishes n cells/sec with burst = n.
        let quota = Quota::per_second(cells);
        Self {
            inner: RateLimiter::direct(quota),
        }
    }

    /// Attempt to admit one message.  Returns `true` if within budget, `false`
    /// if the limit is exceeded (the caller drops the frame and emits
    /// `RATE_LIMITED`).  Never blocks.
    #[must_use]
    pub fn check(&self) -> bool {
        self.inner.check().is_ok()
    }
}

impl std::fmt::Debug for Limiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Limiter").finish_non_exhaustive()
    }
}

/// Resolve the per-client rate from `TP_RELAY_RATE_PER_CLIENT`, falling back to
/// [`DEFAULT_RATE_PER_CLIENT`].  Mirrors `relay-server.ts:316-323`.
#[must_use]
pub fn rate_per_client_from_env() -> u32 {
    env_u32("TP_RELAY_RATE_PER_CLIENT").unwrap_or(DEFAULT_RATE_PER_CLIENT)
}

/// Resolve the per-daemon-group rate from `TP_RELAY_RATE_PER_DAEMON`, falling
/// back to [`DEFAULT_RATE_PER_DAEMON`].
#[must_use]
pub fn rate_per_daemon_from_env() -> u32 {
    env_u32("TP_RELAY_RATE_PER_DAEMON").unwrap_or(DEFAULT_RATE_PER_DAEMON)
}

fn env_u32(key: &str) -> Option<u32> {
    let raw = match std::env::var(key) {
        Ok(s) if !s.is_empty() => s,
        _ => return None,
    };
    match raw.parse::<u32>() {
        Ok(0) => {
            // 0 would disable rate limiting entirely — warn and ignore.
            eprintln!(
                "tp-relay: env {key}={raw:?} parsed to 0 — ignoring \
                 (would disable rate limiting); set to a positive integer or unset to use default"
            );
            None
        }
        Ok(v) => Some(v),
        Err(e) => {
            // Non-numeric value — warn and fall back to the default.
            eprintln!(
                "tp-relay: env {key}={raw:?} failed to parse as u32 ({e}) — \
                 ignoring, using default"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_up_to_burst_then_rejects() {
        // GCRA with quota n admits a burst of n immediately, then throttles.
        let lim = Limiter::per_second(5);
        let mut admitted = 0;
        for _ in 0..20 {
            if lim.check() {
                admitted += 1;
            }
        }
        // The initial burst is the full quota; subsequent checks in the same
        // instant are rejected (no wall-clock has passed). So exactly 5 admit.
        assert_eq!(admitted, 5, "burst capacity == quota");
    }

    #[test]
    fn fresh_limiter_admits_first_message() {
        let lim = Limiter::per_second(1);
        assert!(lim.check(), "first message always admitted");
        assert!(
            !lim.check(),
            "second within the same instant rejected at n=1"
        );
    }

    #[test]
    fn zero_clamped_to_one() {
        // A 0 limit would panic NonZeroU32; we clamp to 1 so the limiter is
        // still constructible (defensive — callers pass positive limits).
        let lim = Limiter::per_second(0);
        assert!(lim.check());
        assert!(!lim.check());
    }

    #[test]
    fn default_constants_match_ts() {
        assert_eq!(DEFAULT_RATE_PER_CLIENT, 500);
        assert_eq!(DEFAULT_RATE_PER_DAEMON, 5_000);
    }

    #[test]
    fn larger_quota_admits_more() {
        let lim = Limiter::per_second(100);
        let admitted = (0..150).filter(|_| lim.check()).count();
        assert_eq!(admitted, 100);
    }
}
