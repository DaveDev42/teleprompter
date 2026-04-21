import type { WsRec } from "@teleprompter/protocol/client";
import { create } from "zustand";

const MAX_CACHED_FRAMES = 10;

/**
 * Minimum wait between Zustand notifications for `recentFrames`. PTY bursts
 * push dozens of frames per second through `cacheFrame`; notifying on every
 * frame re-renders every subscriber (the DiagnosticsPanel is the only one,
 * and it refreshes fine at 120ms). Mutate the underlying Map in place and
 * only publish a new reference at most once per interval.
 */
const RECENT_FRAMES_FLUSH_MS = 120;

export interface OfflineStore {
  /** Recent frames per session (ring buffer of 10) */
  recentFrames: Map<string, WsRec[]>;
  /** Last known session states */
  lastStates: Map<string, { state: string; lastSeen: number }>;

  // Actions
  cacheFrame: (rec: WsRec) => void;
  updateState: (sid: string, state: string) => void;
  getRecentFrames: (sid: string) => WsRec[];
  getLastState: (
    sid: string,
  ) => { state: string; lastSeen: number } | undefined;
}

export const useOfflineStore = create<OfflineStore>((set, get) => {
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  const scheduleFlush = () => {
    if (pendingFlush !== null) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      // New Map reference so Zustand's strict-equality check fires.
      set({ recentFrames: new Map(get().recentFrames) });
    }, RECENT_FRAMES_FLUSH_MS);
  };

  return {
    recentFrames: new Map(),
    lastStates: new Map(),

    cacheFrame: (rec: WsRec) => {
      const frames = get().recentFrames;
      const existing = frames.get(rec.sid);
      if (existing) {
        existing.push(rec);
        if (existing.length > MAX_CACHED_FRAMES) existing.shift();
      } else {
        frames.set(rec.sid, [rec]);
      }
      scheduleFlush();
    },

    updateState: (sid: string, state: string) => {
      const next = new Map(get().lastStates);
      next.set(sid, { state, lastSeen: Date.now() });
      set({ lastStates: next });
    },

    getRecentFrames: (sid: string) => {
      return get().recentFrames.get(sid) ?? [];
    },

    getLastState: (sid: string) => {
      return get().lastStates.get(sid);
    },
  };
});
