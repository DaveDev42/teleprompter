//! Relay capacity counters — the Rust port of the TS `RelayMetrics` interface
//! (`relay-server.ts:173-187`).
//!
//! ## Shape
//!
//! [`Metrics`] holds the 12 since-process-start counters as [`AtomicU64`],
//! named in `snake_case` to mirror the TS `camelCase` fields one-for-one:
//!
//! | TS field (`relay-server.ts`) | Rust field |
//! |------------------------------|------------|
//! | `framesIn`                   | `frames_in` |
//! | `framesOut`                  | `frames_out` |
//! | `rateLimitedDrops`           | `rate_limited_drops` |
//! | `daemonRateLimitedDrops`     | `daemon_rate_limited_drops` |
//! | `backpressureDisconnects`    | `backpressure_disconnects` |
//! | `authTimeouts`               | `auth_timeouts` |
//! | `oversizedDrops`             | `oversized_drops` |
//! | `unknownTypeDrops`           | `unknown_type_drops` |
//! | `evictions`                  | `evictions` |
//! | `resumesAttempted`           | `resumes_attempted` |
//! | `resumesAccepted`            | `resumes_accepted` |
//! | `resumesRejected`            | `resumes_rejected` |
//!
//! ## Reconciliation of the pre-existing scattered statics
//!
//! Two `AtomicU64` statics existed before this module:
//!
//! * `conn::OVERSIZED_DROPS` — a genuine `/metrics` counter. **Folded in**: its
//!   emit site (`conn.rs` oversize guard) now calls [`Metrics::inc_oversized_drops`]
//!   on the shared [`Metrics`], and the free `conn::oversized_drops()` reader is
//!   removed. There is no longer a process-global oversize static — every emit
//!   reaches the `Arc<Metrics>` carried in `SharedState`.
//! * `handshake::VERSION_MISMATCH_COUNT` — **NOT a `/metrics` counter.** It tracks
//!   `relay.hello` `v < 2` rejects, but `relay.hello` has no wire parser / dispatch
//!   arm, so a live socket can never increment it (see the `handshake.rs`
//!   module note). The TS `/metrics` output has no corresponding line either, so
//!   it is intentionally left where it is and is **not** part of [`snapshot`].
//!
//! [`snapshot`]: Metrics::snapshot

use std::sync::atomic::{AtomicU64, Ordering};

/// All relay capacity counters. Shared as an `Arc<Metrics>` in `SharedState` so
/// every emit site and every HTTP handler reaches it **without** taking the
/// `RelayCore` routing lock — reads/writes are lock-free atomics (`Relaxed`,
/// matching the TS `metrics.x++` non-synchronised increment semantics).
#[derive(Debug, Default)]
pub struct Metrics {
    /// Inbound relay frames accepted past the oversize guard (`framesIn`).
    pub frames_in: AtomicU64,
    /// Outbound `relay.frame`/`relay.kx.frame` deliveries (`framesOut`).
    pub frames_out: AtomicU64,
    /// Frames dropped by the per-client rate limiter (`rateLimitedDrops`).
    pub rate_limited_drops: AtomicU64,
    /// Frames dropped by the per-daemon-group rate limiter (`daemonRateLimitedDrops`).
    pub daemon_rate_limited_drops: AtomicU64,
    /// Slow consumers force-closed with 1013 (`backpressureDisconnects`).
    pub backpressure_disconnects: AtomicU64,
    /// Sockets closed for missing the auth deadline (`authTimeouts`).
    pub auth_timeouts: AtomicU64,
    /// Frames dropped for exceeding `max_frame_size` (`oversizedDrops`).
    pub oversized_drops: AtomicU64,
    /// Frames that parsed as JSON but were not a valid message (`unknownTypeDrops`).
    pub unknown_type_drops: AtomicU64,
    /// Daemons evicted after the offline TTL (`evictions`).
    pub evictions: AtomicU64,
    /// `relay.auth.resume` attempts (`resumesAttempted`).
    pub resumes_attempted: AtomicU64,
    /// `relay.auth.resume` accepted (`resumesAccepted`).
    pub resumes_accepted: AtomicU64,
    /// `relay.auth.resume` rejected (`resumesRejected`).
    pub resumes_rejected: AtomicU64,
}

/// A plain (non-atomic) snapshot of [`Metrics`] for the route bodies. Field
/// order mirrors the TS `RelayMetrics` interface so the `/health` `metrics`
/// object and the `/metrics` text body can be built positionally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricsSnapshot {
    /// `framesIn`.
    pub frames_in: u64,
    /// `framesOut`.
    pub frames_out: u64,
    /// `rateLimitedDrops`.
    pub rate_limited_drops: u64,
    /// `daemonRateLimitedDrops`.
    pub daemon_rate_limited_drops: u64,
    /// `backpressureDisconnects`.
    pub backpressure_disconnects: u64,
    /// `authTimeouts`.
    pub auth_timeouts: u64,
    /// `oversizedDrops`.
    pub oversized_drops: u64,
    /// `unknownTypeDrops`.
    pub unknown_type_drops: u64,
    /// `evictions`.
    pub evictions: u64,
    /// `resumesAttempted`.
    pub resumes_attempted: u64,
    /// `resumesAccepted`.
    pub resumes_accepted: u64,
    /// `resumesRejected`.
    pub resumes_rejected: u64,
}

macro_rules! inc_fn {
    ($(#[$m:meta])* $name:ident, $field:ident) => {
        $(#[$m])*
        #[inline]
        pub fn $name(&self) {
            self.$field.fetch_add(1, Ordering::Relaxed);
        }
    };
}

impl Metrics {
    /// Construct a fresh all-zero counter set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    inc_fn!(
        /// `metrics.framesIn++` (`relay-server.ts:648`).
        inc_frames_in, frames_in
    );
    inc_fn!(
        /// `metrics.framesOut++` (`relay-server.ts:619`).
        inc_frames_out, frames_out
    );
    inc_fn!(
        /// `metrics.rateLimitedDrops++` (`relay-server.ts:688`).
        inc_rate_limited_drops, rate_limited_drops
    );
    inc_fn!(
        /// `metrics.daemonRateLimitedDrops++` (`relay-server.ts:697`).
        inc_daemon_rate_limited_drops, daemon_rate_limited_drops
    );
    inc_fn!(
        /// `metrics.backpressureDisconnects++` (`relay-server.ts:606`).
        inc_backpressure_disconnects, backpressure_disconnects
    );
    inc_fn!(
        /// `metrics.authTimeouts++` (`relay-server.ts:522`).
        inc_auth_timeouts, auth_timeouts
    );
    inc_fn!(
        /// `metrics.oversizedDrops++` (`relay-server.ts:636`).
        inc_oversized_drops, oversized_drops
    );
    inc_fn!(
        /// `metrics.unknownTypeDrops++` (`relay-server.ts:675`).
        inc_unknown_type_drops, unknown_type_drops
    );
    inc_fn!(
        /// `metrics.evictions++` (`relay-server.ts` `evictDaemon`).
        inc_evictions, evictions
    );
    inc_fn!(
        /// `metrics.resumesAttempted++` (`relay-server.ts:889`).
        inc_resumes_attempted, resumes_attempted
    );
    inc_fn!(
        /// `metrics.resumesAccepted++` (`relay-server.ts:947`).
        inc_resumes_accepted, resumes_accepted
    );
    inc_fn!(
        /// `metrics.resumesRejected++` (`relay-server.ts:892/911`).
        inc_resumes_rejected, resumes_rejected
    );

    /// Read every counter into a plain [`MetricsSnapshot`] (one `Relaxed` load
    /// each). Used by `/health` + `/metrics` to build their bodies without
    /// re-reading atomics mid-render.
    #[must_use]
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            frames_in: self.frames_in.load(Ordering::Relaxed),
            frames_out: self.frames_out.load(Ordering::Relaxed),
            rate_limited_drops: self.rate_limited_drops.load(Ordering::Relaxed),
            daemon_rate_limited_drops: self.daemon_rate_limited_drops.load(Ordering::Relaxed),
            backpressure_disconnects: self.backpressure_disconnects.load(Ordering::Relaxed),
            auth_timeouts: self.auth_timeouts.load(Ordering::Relaxed),
            oversized_drops: self.oversized_drops.load(Ordering::Relaxed),
            unknown_type_drops: self.unknown_type_drops.load(Ordering::Relaxed),
            evictions: self.evictions.load(Ordering::Relaxed),
            resumes_attempted: self.resumes_attempted.load(Ordering::Relaxed),
            resumes_accepted: self.resumes_accepted.load(Ordering::Relaxed),
            resumes_rejected: self.resumes_rejected.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each `inc_*` bumps exactly its own counter, and `snapshot()` reads each
    /// one back distinctly. We bump each counter a unique number of times (its
    /// 1-based index) so a cross-wired increment/read would show up as a
    /// mismatched value rather than slip through an all-equal check.
    #[test]
    fn snapshot_round_trips_each_counter() {
        let m = Metrics::new();
        // Distinct call counts per counter.
        m.inc_frames_in();
        for _ in 0..2 {
            m.inc_frames_out();
        }
        for _ in 0..3 {
            m.inc_rate_limited_drops();
        }
        for _ in 0..4 {
            m.inc_daemon_rate_limited_drops();
        }
        for _ in 0..5 {
            m.inc_backpressure_disconnects();
        }
        for _ in 0..6 {
            m.inc_auth_timeouts();
        }
        for _ in 0..7 {
            m.inc_oversized_drops();
        }
        for _ in 0..8 {
            m.inc_unknown_type_drops();
        }
        for _ in 0..9 {
            m.inc_evictions();
        }
        for _ in 0..10 {
            m.inc_resumes_attempted();
        }
        for _ in 0..11 {
            m.inc_resumes_accepted();
        }
        for _ in 0..12 {
            m.inc_resumes_rejected();
        }

        let s = m.snapshot();
        assert_eq!(
            s,
            MetricsSnapshot {
                frames_in: 1,
                frames_out: 2,
                rate_limited_drops: 3,
                daemon_rate_limited_drops: 4,
                backpressure_disconnects: 5,
                auth_timeouts: 6,
                oversized_drops: 7,
                unknown_type_drops: 8,
                evictions: 9,
                resumes_attempted: 10,
                resumes_accepted: 11,
                resumes_rejected: 12,
            }
        );
    }

    #[test]
    fn fresh_metrics_snapshot_is_all_zero() {
        let s = Metrics::new().snapshot();
        assert_eq!(
            s,
            MetricsSnapshot {
                frames_in: 0,
                frames_out: 0,
                rate_limited_drops: 0,
                daemon_rate_limited_drops: 0,
                backpressure_disconnects: 0,
                auth_timeouts: 0,
                oversized_drops: 0,
                unknown_type_drops: 0,
                evictions: 0,
                resumes_attempted: 0,
                resumes_accepted: 0,
                resumes_rejected: 0,
            }
        );
    }
}
