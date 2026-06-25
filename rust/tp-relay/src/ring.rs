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

/// Default cap on the number of distinct `"daemonId:sid"` keys per daemon.
/// When a daemon exceeds this, the oldest key (by insertion order) is evicted.
/// Prevents unbounded key growth when a single daemon opens many sessions.
pub const DEFAULT_MAX_RECENT_FRAME_KEYS_PER_DAEMON: usize = 256;

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
    /// Maximum distinct `"daemonId:sid"` keys per daemon.  When a new key
    /// would exceed this, the oldest key (by insertion order) for that daemon
    /// is evicted before the new key is created.  `0` disables the cap.
    max_keys_per_daemon: usize,
    /// Insertion-ordered log of all keys, oldest first.  Used to find the
    /// oldest eviction candidate for a given daemon prefix in O(n) time.
    /// Bounded by (number of live daemons × `max_keys_per_daemon`).
    key_insertion_order: VecDeque<String>,
}

impl RecentFrames {
    /// Construct with an explicit cache depth and the default per-daemon key
    /// cap ([`DEFAULT_MAX_RECENT_FRAME_KEYS_PER_DAEMON`]).  A `cache_size` of
    /// 0 disables frame caching (every push is immediately trimmed to empty).
    #[must_use]
    pub fn with_cache_size(cache_size: usize) -> Self {
        Self::with_cache_and_key_cap(cache_size, DEFAULT_MAX_RECENT_FRAME_KEYS_PER_DAEMON)
    }

    /// Construct with an explicit cache depth AND an explicit per-daemon key
    /// cap.  `max_keys_per_daemon = 0` disables the per-daemon key cap.
    #[must_use]
    pub fn with_cache_and_key_cap(cache_size: usize, max_keys_per_daemon: usize) -> Self {
        Self {
            buffers: HashMap::new(),
            cache_size,
            max_keys_per_daemon,
            key_insertion_order: VecDeque::new(),
        }
    }

    /// Construct from environment variables, falling back to defaults.
    ///
    /// `TP_RELAY_CACHE_SIZE` → per-key frame depth (default [`DEFAULT_CACHE_SIZE`]).
    /// `TP_RELAY_MAX_RECENT_FRAME_KEYS` → per-daemon key cap
    /// (default [`DEFAULT_MAX_RECENT_FRAME_KEYS_PER_DAEMON`]).
    ///
    /// Mirrors `options?.cacheSize ?? envInt(...) ?? DEFAULT` at
    /// `relay-server.ts:308-311`.
    #[must_use]
    pub fn from_env() -> Self {
        let cache_size = std::env::var("TP_RELAY_CACHE_SIZE")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_CACHE_SIZE);
        let max_keys_per_daemon = std::env::var("TP_RELAY_MAX_RECENT_FRAME_KEYS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_MAX_RECENT_FRAME_KEYS_PER_DAEMON);
        Self::with_cache_and_key_cap(cache_size, max_keys_per_daemon)
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
    /// When `max_keys_per_daemon > 0` and this push would create a NEW key
    /// that exceeds the per-daemon cap, the oldest key (insertion order) for
    /// this daemon is evicted first.
    ///
    /// The frame's `sid` is taken from `frame.sid` (the TS code keys on
    /// `msg.sid`, which is the same field).
    pub fn push(&mut self, daemon_id: &str, frame: Arc<Frame>) {
        let key = Self::key(daemon_id, &frame.sid);
        let is_new = !self.buffers.contains_key(&key);

        if is_new && self.max_keys_per_daemon > 0 {
            // Count existing keys for this daemon.
            let prefix = format!("{daemon_id}:");
            let daemon_key_count = self
                .buffers
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .count();

            // Evict oldest keys for this daemon until we have room for the new one.
            if daemon_key_count >= self.max_keys_per_daemon {
                let mut evict_count = daemon_key_count + 1 - self.max_keys_per_daemon;
                let mut i = 0;
                while evict_count > 0 && i < self.key_insertion_order.len() {
                    // `remove(i)` returns `Some` because `i < len` is the loop
                    // guard; `map` over it keeps this branch panic-free.
                    if self.key_insertion_order[i].starts_with(&prefix) {
                        if let Some(old_key) = self.key_insertion_order.remove(i) {
                            self.buffers.remove(&old_key);
                            evict_count -= 1;
                        }
                        // Do NOT increment i: the next element shifted into position i.
                    } else {
                        i += 1;
                    }
                }
            }

            // Record this new key's insertion order.
            self.key_insertion_order.push_back(key.clone());
        }

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
        self.key_insertion_order.retain(|k| !k.starts_with(&prefix));
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

    // ── Per-daemon key cap ────────────────────────────────────────────────────

    #[test]
    fn key_cap_evicts_oldest_daemon_keys() {
        let mut rf = RecentFrames::with_cache_and_key_cap(10, 3);
        // Push to 4 distinct sids for daemon "d".
        rf.push("d", frame("s1", 1, Role::Daemon, None));
        rf.push("d", frame("s2", 1, Role::Daemon, None));
        rf.push("d", frame("s3", 1, Role::Daemon, None));
        // Now at cap (3 keys). Adding s4 should evict s1 (oldest).
        rf.push("d", frame("s4", 1, Role::Daemon, None));
        assert_eq!(rf.key_count(), 3, "still at cap after eviction");
        // s1 (oldest) must be gone.
        assert!(
            rf.replay_after("d", "s1", 0).is_empty(),
            "s1 must be evicted"
        );
        // s4 (newest) must be present.
        assert!(
            !rf.replay_after("d", "s4", 0).is_empty(),
            "s4 must be retained"
        );
        // s2, s3 still present.
        assert!(!rf.replay_after("d", "s2", 0).is_empty());
        assert!(!rf.replay_after("d", "s3", 0).is_empty());
    }

    #[test]
    fn key_cap_is_per_daemon_not_global() {
        // Daemon "a" and daemon "b" have independent key caps.
        let mut rf = RecentFrames::with_cache_and_key_cap(10, 2);
        rf.push("a", frame("s1", 1, Role::Daemon, None));
        rf.push("a", frame("s2", 1, Role::Daemon, None));
        rf.push("b", frame("s1", 1, Role::Daemon, None));
        rf.push("b", frame("s2", 1, Role::Daemon, None));
        // 4 keys total, 2 per daemon — no eviction yet.
        assert_eq!(rf.key_count(), 4);
        // Adding a 3rd key for "a" evicts a's oldest.
        rf.push("a", frame("s3", 1, Role::Daemon, None));
        assert_eq!(
            rf.key_count(),
            4,
            "total stays 4 (a evicted s1, b unchanged)"
        );
        assert!(rf.replay_after("a", "s1", 0).is_empty(), "a:s1 evicted");
        assert!(!rf.replay_after("b", "s1", 0).is_empty(), "b:s1 intact");
    }

    #[test]
    fn key_cap_zero_disables_cap() {
        // max_keys_per_daemon=0 → no eviction, keys grow unbounded.
        let mut rf = RecentFrames::with_cache_and_key_cap(10, 0);
        for i in 0..10u64 {
            rf.push("d", frame(&format!("s{i}"), 1, Role::Daemon, None));
        }
        assert_eq!(rf.key_count(), 10, "all keys retained when cap is 0");
    }

    #[test]
    fn purge_daemon_also_cleans_key_insertion_order() {
        let mut rf = RecentFrames::with_cache_and_key_cap(10, 3);
        rf.push("d1", frame("s1", 1, Role::Daemon, None));
        rf.push("d1", frame("s2", 1, Role::Daemon, None));
        rf.push("d2", frame("s1", 1, Role::Daemon, None));
        assert_eq!(rf.key_insertion_order.len(), 3);
        rf.purge_daemon("d1");
        assert_eq!(rf.key_count(), 1, "d2:s1 remains");
        assert_eq!(
            rf.key_insertion_order.len(),
            1,
            "insertion order cleaned for d1"
        );
        // Verify d2 can still fill its cap without hitting stale d1 entries.
        rf.push("d2", frame("s2", 1, Role::Daemon, None));
        rf.push("d2", frame("s3", 1, Role::Daemon, None));
        rf.push("d2", frame("s4", 1, Role::Daemon, None));
        assert_eq!(rf.key_count(), 3, "d2 at cap after adding 3 new keys");
        assert!(
            rf.replay_after("d2", "s1", 0).is_empty(),
            "d2:s1 evicted as oldest"
        );
    }
}
