import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";
import { create } from "zustand";
import { secureGet, secureSet } from "../lib/secure-storage";

export type RecHandler = (rec: WsRec) => void;

const SESSIONS_STORAGE_KEY = "sessions_v1";

/** Serializable shape: plain object for JSON storage */
type PersistedSessionMap = Record<string, WsSessionMeta[]>;

// ── Debounced write-through ──

let _writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(data: Map<string, WsSessionMeta[]>): void {
  if (_writeTimer !== null) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    const obj: PersistedSessionMap = {};
    for (const [daemonId, sessions] of data) {
      obj[daemonId] = sessions;
    }
    void secureSet(SESSIONS_STORAGE_KEY, JSON.stringify(obj));
  }, 300);
}

// ── Store interface ──

export interface SessionState {
  /** Current session ID */
  sid: string | null;
  /** Last received sequence number */
  lastSeq: number;
  /** All known sessions (union across all connected daemons) */
  sessions: WsSessionMeta[];
  /** Last error message */
  lastError: string | null;
  /** Number of reconnect attempts */
  reconnectCount: number;
  /** Record handlers (multiple consumers: terminal, chat) */
  _recHandlers: Set<RecHandler>;
  /** Per-daemon last-known session list (persisted) */
  _sessionsByDaemon: Map<string, WsSessionMeta[]>;

  // Actions
  setSid: (sid: string | null) => void;
  setLastSeq: (seq: number) => void;
  setError: (error: string | null) => void;
  incrementReconnect: () => void;
  /** Set sessions for a specific daemon. Pass daemonId so the list is persisted
   *  keyed per-daemon. The `sessions` field is the union of all per-daemon lists. */
  setSessions: (daemonId: string, sessions: WsSessionMeta[]) => void;
  updateSession: (sid: string, meta: WsSessionMeta) => void;
  addRecHandler: (fn: RecHandler) => void;
  removeRecHandler: (fn: RecHandler) => void;
  dispatchRec: (rec: WsRec) => void;
  /** Load persisted session lists from secure storage (call on app init). */
  load: () => Promise<void>;
  reset: () => void;
}

// ── Helper: build flat union of all per-daemon session lists ──

function flattenSessions(map: Map<string, WsSessionMeta[]>): WsSessionMeta[] {
  const out: WsSessionMeta[] = [];
  for (const list of map.values()) {
    for (const s of list) out.push(s);
  }
  return out;
}

// ── Store ──

export const useSessionStore = create<SessionState>((set, get) => ({
  sid: null,
  lastSeq: 0,
  lastError: null,
  reconnectCount: 0,
  sessions: [],
  _recHandlers: new Set(),
  _sessionsByDaemon: new Map(),

  setSid: (sid) => set({ sid }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setError: (error) => set({ lastError: error }),
  incrementReconnect: () =>
    set((s) => ({ reconnectCount: s.reconnectCount + 1 })),

  setSessions: (daemonId, sessions) => {
    const next = new Map(get()._sessionsByDaemon);
    next.set(daemonId, sessions);
    scheduleWrite(next);
    set({ _sessionsByDaemon: next, sessions: flattenSessions(next) });
  },

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

  load: async () => {
    try {
      const raw = await secureGet(SESSIONS_STORAGE_KEY);
      if (!raw) return;
      const obj: PersistedSessionMap = JSON.parse(raw);
      const map = new Map<string, WsSessionMeta[]>();
      for (const [daemonId, sessions] of Object.entries(obj)) {
        if (Array.isArray(sessions)) {
          map.set(daemonId, sessions);
        }
      }
      if (map.size > 0) {
        set({ _sessionsByDaemon: map, sessions: flattenSessions(map) });
      }
    } catch {
      // Corrupted data — start fresh
    }
  },

  reset: () =>
    set({
      sid: null,
      lastSeq: 0,
      lastError: null,
      reconnectCount: 0,
      sessions: [],
      _recHandlers: new Set(),
      _sessionsByDaemon: new Map(),
    }),
}));
