import type { WsRec } from "@teleprompter/protocol/client";
import { create } from "zustand";

const MAX_CACHED_FRAMES = 10;

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

export const useOfflineStore = create<OfflineStore>((set, get) => ({
  recentFrames: new Map(),
  lastStates: new Map(),

  cacheFrame: (rec: WsRec) => {
    const frames = get().recentFrames;
    const existing = frames.get(rec.sid) ?? [];
    const updated = [...existing, rec];
    if (updated.length > MAX_CACHED_FRAMES) {
      updated.shift();
    }
    const next = new Map(frames);
    next.set(rec.sid, updated);
    set({ recentFrames: next });
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
}));
