//! Per-session recent-frame ring buffer — the relay's only durability.
//!
//! Port of the TypeScript `recentFrames` map (`relay-server.ts:250-251`,
//! push/trim `1130-1146`, replay `1200-1209`).  Redesign per ADR-0003 §A1.4:
//!
//! * `Array` + `push`/`shift` (O(n) head removal) → `VecDeque` + `push_back` /
//!   `pop_front` (O(1)).
//! * `CachedFrame` value clones on fan-out → `Arc<Frame>` (one allocation,
//!   ref-counted; the ciphertext `String` is never copied when replayed to N
//!   subscribers).
//!
//! Keying is unchanged: `"daemonId:sid"` (per-daemon **and** per-session), so a
//! frame cached for one session of one daemon never replays to another.
//!
//! This module is pure data — no async, no I/O — and is exhaustively unit
//! tested.  The async server (Step 4 WS layer) owns one `RecentFrames` behind
//! the connection registry's lock.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;

use crate::messages::Frame;

/// Default recent-frame cache depth per `"daemonId:sid"`.  Mirrors
/// `DEFAULT_MAX_RECENT_FRAMES = 10` (`relay-server.ts:69`).
pub const DEFAULT_CACHE_SIZE: usize = 10;

/// Per-`"daemonId:sid"` ring buffer of recent ciphertext frames.
///
/// The relay never decrypts `ct`; the cache exists purely so a reconnecting
/// frontend can `relay.sub { after }` and replay the frames it missed.
#[derive(Debug, Clone)]
pub struct RecentFrames {
    /// `"daemonId:sid"` → ordered ring of recent frames (oldest at the front).
    buffers: HashMap<String, VecDeque<Arc<Frame>>>,
    /// Maximum frames retained per key.  Excess oldest frames are dropped on
    /// push.
    cache_size: usize,
}

impl RecentFrames {
    /// Construct with an explicit cache depth.  A `cache_size` of 0 disables
    /// caching (every push is immediately at/over cap and trimmed to empty).
    #[must_use]
    pub fn with_cache_size(cache_size: usize) -> Self {
        Self {
            buffers: HashMap::new(),
            cache_size,
        }
    }

    /// Construct from the `TP_RELAY_CACHE_SIZE` env var, falling back to
    /// [`DEFAULT_CACHE_SIZE`].  A non-numeric or absent value uses the default.
    /// Mirrors `options?.cacheSize ?? envInt(...) ?? DEFAULT` at
    /// `relay-server.ts:308-311`.
    #[must_use]
    pub fn from_env() -> Self {
        let cache_size = std::env::var("TP_RELAY_CACHE_SIZE")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_CACHE_SIZE);
        Self::with_cache_size(cache_size)
    }

    /// The configured cache depth.
    #[must_use]
    pub fn cache_size(&self) -> usize {
        self.cache_size
    }

    /// Compose the `"daemonId:sid"` cache key.
    fn key(daemon_id: &str, sid: &str) -> String {
        format!("{daemon_id}:{sid}")
    }

    /// Append `frame` to the ring for `(daemon_id, frame.sid)` and trim the
    /// oldest entries past the cap.  Mirrors `relay-server.ts:1130-1146`
    /// (`frames.push(...)` then `if (frames.length > max) frames.shift()`).
    ///
    /// The frame's `sid` is taken from `frame.sid` (the TS code keys on
    /// `msg.sid`, which is the same field).
    pub fn push(&mut self, daemon_id: &str, frame: Arc<Frame>) {
        let key = Self::key(daemon_id, &frame.sid);
        let ring = self.buffers.entry(key).or_default();
        ring.push_back(frame);
        // Trim oldest-first until at or below the cap.  `while`, not `if`, so a
        // shrunk `cache_size` still converges (the TS code only ever pushes one
        // at a time, so a single `shift` suffices there — `while` is strictly
        // safer and identical for the steady-state single-push case).
        while ring.len() > self.cache_size {
            ring.pop_front();
        }
    }

    /// Replay all cached frames for `(daemon_id, sid)` whose `seq` is strictly
    /// greater than `after`.  Mirrors the `relay.sub { after }` replay loop at
    /// `relay-server.ts:1200-1209` (`if (frame.seq > msg.after) send(...)`).
    ///
    /// Returns cheap `Arc` clones — the ciphertext `String` inside each frame is
    /// shared, never copied, even when fanned out to many subscribers.  An
    /// absent key yields an empty `Vec` (no replay), matching the TS
    /// `?? []` fallback.
    #[must_use]
    pub fn replay_after(&self, daemon_id: &str, sid: &str, after: u64) -> Vec<Arc<Frame>> {
        let key = Self::key(daemon_id, sid);
        let Some(ring) = self.buffers.get(&key) else {
            return Vec::new();
        };
        ring.iter()
            .filter(|f| f.seq > after)
            .map(Arc::clone)
            .collect()
    }

    /// Drop the entire cache for a daemon — every `"daemonId:*"` key.  Called on
    /// daemon eviction (`evictDaemon` purges `recentFrames` for the daemon so a
    /// re-registering daemon does not replay a dead session's frames).
    pub fn purge_daemon(&mut self, daemon_id: &str) {
        let prefix = format!("{daemon_id}:");
        self.buffers.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Number of distinct `"daemonId:sid"` keys currently cached (test/metric
    /// helper).
    #[must_use]
    pub fn key_count(&self) -> usize {
        self.buffers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::Frame;
    use tp_proto::relay_client::Role;

    fn frame(sid: &str, seq: u64, from: Role, fid: Option<&str>) -> Arc<Frame> {
        Arc::new(Frame {
            sid: sid.to_string(),
            ct: format!("ct-{seq}"),
            seq,
            from,
            frontend_id: fid.map(String::from),
        })
    }

    #[test]
    fn push_and_replay_after_cursor() {
        let mut rf = RecentFrames::with_cache_size(10);
        for seq in 1..=5 {
            rf.push("d", frame("s", seq, Role::Daemon, None));
        }
        // after=2 → seqs 3,4,5.
        let out = rf.replay_after("d", "s", 2);
        let seqs: Vec<u64> = out.iter().map(|f| f.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
    }

    #[test]
    fn replay_after_zero_returns_all() {
        let mut rf = RecentFrames::with_cache_size(10);
        rf.push("d", frame("s", 1, Role::Daemon, None));
        rf.push("d", frame("s", 2, Role::Daemon, None));
        let out = rf.replay_after("d", "s", 0);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn ring_trims_oldest_at_cap() {
        let mut rf = RecentFrames::with_cache_size(3);
        for seq in 1..=6 {
            rf.push("d", frame("s", seq, Role::Daemon, None));
        }
        // Only the last 3 (seq 4,5,6) survive.
        let out = rf.replay_after("d", "s", 0);
        let seqs: Vec<u64> = out.iter().map(|f| f.seq).collect();
        assert_eq!(seqs, vec![4, 5, 6]);
    }

    #[test]
    fn keys_are_per_daemon_and_per_session() {
        let mut rf = RecentFrames::with_cache_size(10);
        rf.push("d1", frame("s", 1, Role::Daemon, None));
        rf.push("d2", frame("s", 1, Role::Daemon, None));
        rf.push("d1", frame("other", 1, Role::Daemon, None));
        assert_eq!(rf.key_count(), 3, "d1:s, d2:s, d1:other are distinct");
        // d1:s frame must not leak into d2:s.
        assert_eq!(rf.replay_after("d2", "s", 0).len(), 1);
        assert_eq!(rf.replay_after("d1", "other", 0).len(), 1);
    }

    #[test]
    fn absent_key_replays_empty() {
        let rf = RecentFrames::with_cache_size(10);
        assert!(rf.replay_after("nope", "nada", 0).is_empty());
    }

    #[test]
    fn frontend_frame_preserves_frontend_id() {
        let mut rf = RecentFrames::with_cache_size(10);
        rf.push("d", frame("s", 1, Role::Frontend, Some("f1")));
        let out = rf.replay_after("d", "s", 0);
        assert_eq!(out[0].from, Role::Frontend);
        assert_eq!(out[0].frontend_id.as_deref(), Some("f1"));
    }

    #[test]
    fn purge_daemon_drops_all_its_sessions_only() {
        let mut rf = RecentFrames::with_cache_size(10);
        rf.push("d1", frame("s1", 1, Role::Daemon, None));
        rf.push("d1", frame("s2", 1, Role::Daemon, None));
        rf.push("d2", frame("s1", 1, Role::Daemon, None));
        rf.purge_daemon("d1");
        assert_eq!(rf.key_count(), 1, "only d2:s1 remains");
        assert_eq!(rf.replay_after("d2", "s1", 0).len(), 1);
        assert!(rf.replay_after("d1", "s1", 0).is_empty());
    }

    #[test]
    fn purge_daemon_prefix_is_exact() {
        // Guard against a `starts_with("d")` matching "d10:" when purging "d1".
        let mut rf = RecentFrames::with_cache_size(10);
        rf.push("d1", frame("s", 1, Role::Daemon, None));
        rf.push("d10", frame("s", 1, Role::Daemon, None));
        rf.purge_daemon("d1");
        // "d10:s" must survive because the prefix is "d1:" not "d1".
        assert!(rf.replay_after("d1", "s", 0).is_empty());
        assert_eq!(rf.replay_after("d10", "s", 0).len(), 1);
    }

    #[test]
    fn arc_is_shared_not_copied_on_replay() {
        let mut rf = RecentFrames::with_cache_size(10);
        let f = frame("s", 1, Role::Daemon, None);
        rf.push("d", Arc::clone(&f));
        let a = rf.replay_after("d", "s", 0);
        let b = rf.replay_after("d", "s", 0);
        // Both replays + the local `f` + the one in the ring share one alloc.
        assert!(Arc::ptr_eq(&a[0], &b[0]));
        assert!(Arc::ptr_eq(&a[0], &f));
    }

    #[test]
    fn cache_size_zero_keeps_nothing() {
        let mut rf = RecentFrames::with_cache_size(0);
        rf.push("d", frame("s", 1, Role::Daemon, None));
        assert!(rf.replay_after("d", "s", 0).is_empty());
    }
}
