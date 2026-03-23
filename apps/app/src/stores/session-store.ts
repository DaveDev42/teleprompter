import { create } from "zustand";
import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";

export type RecHandler = (rec: WsRec) => void;

export interface SessionState {
  /** Current session ID */
  sid: string | null;
  /** Whether connected to Daemon WebSocket */
  connected: boolean;
  /** Last received sequence number */
  lastSeq: number;
  /** All known sessions */
  sessions: WsSessionMeta[];
  /** Last error message */
  lastError: string | null;
  /** Number of reconnect attempts */
  reconnectCount: number;
  /** Record handlers (multiple consumers: terminal, chat) */
  _recHandlers: Set<RecHandler>;

  // Actions
  setSid: (sid: string | null) => void;
  setConnected: (connected: boolean) => void;
  setLastSeq: (seq: number) => void;
  setError: (error: string | null) => void;
  incrementReconnect: () => void;
  setSessions: (sessions: WsSessionMeta[]) => void;
  updateSession: (sid: string, meta: WsSessionMeta) => void;
  addRecHandler: (fn: RecHandler) => void;
  removeRecHandler: (fn: RecHandler) => void;
  dispatchRec: (rec: WsRec) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sid: null,
  connected: false,
  lastSeq: 0,
  lastError: null,
  reconnectCount: 0,
  sessions: [],
  _recHandlers: new Set(),

  setSid: (sid) => set({ sid }),
  setConnected: (connected) => set({ connected, lastError: connected ? null : get().lastError }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setError: (error) => set({ lastError: error }),
  incrementReconnect: () => set((s) => ({ reconnectCount: s.reconnectCount + 1 })),
  setSessions: (sessions) => set({ sessions }),
  updateSession: (sid, meta) => {
    set((s) => {
      const idx = s.sessions.findIndex((ss) => ss.sid === sid);
      if (idx >= 0) {
        const next = [...s.sessions];
        next[idx] = meta;
        return { sessions: next };
      }
      return { sessions: [...s.sessions, meta] };
    });
  },
  addRecHandler: (fn) => {
    get()._recHandlers.add(fn);
  },
  removeRecHandler: (fn) => {
    get()._recHandlers.delete(fn);
  },
  dispatchRec: (rec) => {
    for (const fn of get()._recHandlers) {
      fn(rec);
    }
  },
  reset: () =>
    set({
      sid: null,
      connected: false,
      lastSeq: 0,
      lastError: null,
      reconnectCount: 0,
      sessions: [],
      _recHandlers: new Set(),
    }),
}));
