import type { SessionMeta, SessionRec } from "@teleprompter/protocol/client";
import { create } from "zustand";
import { secureGet, secureSet } from "../lib/secure-storage";

export type RecHandler = (rec: SessionRec) => void;

const SESSIONS_STORAGE_KEY = "sessions_v1";

/** Serializable shape: plain object for JSON storage */
type PersistedSessionMap = Record<string, SessionMeta[]>;

// ── Discriminated unions ──

/** Which session the UI is currently viewing / auto-selected. */
export type ActiveSession = { active: true; sid: string } | { active: false };

/** Relay WebSocket lifecycle state. */
export type RelayState =
  | { status: "connected" }
  | { status: "disconnected"; reconnectCount: number }
  | { status: "error"; message: string; reconnectCount: number };

// ── Debounced write-through ──

let _writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(data: Map<string, SessionMeta[]>): void {
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
  /** Currently viewed / auto-selected session. */
  activeSession: ActiveSession;
  /** Last received sequence number */
  lastSeq: number;
  /** All known sessions (union across all connected daemons) */
  sessions: SessionMeta[];
  /** Relay WebSocket lifecycle state (includes reconnect counter). */
  relayState: RelayState;
  /** Record handlers (multiple consumers: terminal, chat) */
  _recHandlers: Set<RecHandler>;
  /** Per-daemon last-known session list (persisted) */
  _sessionsByDaemon: Map<string, SessionMeta[]>;

  // Actions
  setActiveSession: (next: ActiveSession) => void;
  setLastSeq: (seq: number) => void;
  setRelayState: (next: RelayState) => void;
  /**
   * Race-safe reconnect counter increment. Reads the previous relayState's
   * reconnectCount and produces `{ status: 'disconnected', reconnectCount: prev+1 }`.
   * Uses the set((s)=>{}) updater form so concurrent calls never lose an increment.
   */
  bumpReconnect: () => void;
  /** Set sessions for a specific daemon. Pass daemonId so the list is persisted
   *  keyed per-daemon. The `sessions` field is the union of all per-daemon lists. */
  setSessions: (daemonId: string, sessions: SessionMeta[]) => void;
  updateSession: (sid: string, meta: SessionMeta) => void;
  /** Remove a single session from local state across all daemons. Persists the change. */
  removeSession: (sid: string) => void;
  /** Remove multiple sessions from local state. Equivalent to calling removeSession N times. */
  removeSessions: (sids: string[]) => void;
  addRecHandler: (fn: RecHandler) => void;
  removeRecHandler: (fn: RecHandler) => void;
  dispatchRec: (rec: SessionRec) => void;
  /** Load persisted session lists from secure storage (call on app init). */
  load: () => Promise<void>;
  reset: () => void;
}

// ── Helper: build flat union of all per-daemon session lists ──

function flattenSessions(map: Map<string, SessionMeta[]>): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const list of map.values()) {
    for (const s of list) out.push(s);
  }
  return out;
}

// ── Helpers ──

/**
 * Format a RelayState for display. The exhaustive switch + never-check ensures
 * tsc errors whenever a union arm is added or removed without updating this function.
 */
export function formatRelayState(state: RelayState): string {
  switch (state.status) {
    case "connected":
      return "Connected";
    case "disconnected":
      return `Disconnected (reconnects: ${state.reconnectCount})`;
    case "error":
      return `Error: ${state.message} (reconnects: ${state.reconnectCount})`;
    default: {
      // Exhaustiveness check: TypeScript will error here if a new arm is added
      // to RelayState without handling it, or if an arm the switch depends on
      // is removed while the case is still present.
      const _: never = state;
      return _;
    }
  }
}

// ── Store ──

export const useSessionStore = create<SessionState>((set, get) => ({
  activeSession: { active: false },
  lastSeq: 0,
  relayState: { status: "disconnected", reconnectCount: 0 },
  sessions: [],
  _recHandlers: new Set(),
  _sessionsByDaemon: new Map(),

  setActiveSession: (next) => set({ activeSession: next }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setRelayState: (next) => set({ relayState: next }),
  bumpReconnect: () =>
    set((s) => {
      const prev =
        s.relayState.status === "disconnected" ||
        s.relayState.status === "error"
          ? s.relayState.reconnectCount
          : 0;
      return {
        relayState: { status: "disconnected", reconnectCount: prev + 1 },
      };
    }),

  setSessions: (daemonId, sessions) => {
    const next = new Map(get()._sessionsByDaemon);
    next.set(daemonId, sessions);
    scheduleWrite(next);
    set({ _sessionsByDaemon: next, sessions: flattenSessions(next) });
  },

  updateSession: (sid, meta) => {
    // Must update BOTH _sessionsByDaemon (source of truth) AND sessions
    // (derived flat list). Updating only sessions would be reverted the next
    // time any other mutator calls flattenSessions(_sessionsByDaemon).
    const nextMap = new Map(get()._sessionsByDaemon);
    let found = false;
    for (const [daemonId, list] of nextMap) {
      const idx = list.findIndex((s) => s.sid === sid);
      if (idx >= 0) {
        const nextList = [...list];
        nextList[idx] = meta;
        nextMap.set(daemonId, nextList);
        found = true;
        break;
      }
    }
    if (!found) {
      // Append to an ephemeral "__unknown__" bucket so the session is visible
      // in the flat list. A subsequent setSessions call from the daemon will
      // replace this with the authoritative list keyed under the real daemonId.
      const existing = nextMap.get("__unknown__") ?? [];
      nextMap.set("__unknown__", [...existing, meta]);
    }
    scheduleWrite(nextMap);
    set({ _sessionsByDaemon: nextMap, sessions: flattenSessions(nextMap) });
  },

  removeSession: (sid) => {
    const next = new Map(get()._sessionsByDaemon);
    for (const [daemonId, list] of next) {
      const filtered = list.filter((s) => s.sid !== sid);
      if (filtered.length !== list.length) {
        next.set(daemonId, filtered);
      }
    }
    scheduleWrite(next);
    set({ _sessionsByDaemon: next, sessions: flattenSessions(next) });
  },

  removeSessions: (sids) => {
    const sidSet = new Set(sids);
    const next = new Map(get()._sessionsByDaemon);
    for (const [daemonId, list] of next) {
      const filtered = list.filter((s) => !sidSet.has(s.sid));
      if (filtered.length !== list.length) {
        next.set(daemonId, filtered);
      }
    }
    scheduleWrite(next);
    set({ _sessionsByDaemon: next, sessions: flattenSessions(next) });
  },

  addRecHandler: (fn) => {
    // Use set() with a new Set so Zustand subscribers see the update and so
    // that reset() (which replaces _recHandlers entirely) doesn't leave stale
    // mutations on the old Set reference. _recHandlers has no reactive
    // consumers today, but immutable updates are cheaper to reason about than
    // in-place mutation on shared state.
    set((s) => ({ _recHandlers: new Set([...s._recHandlers, fn]) }));
  },
  removeRecHandler: (fn) => {
    set((s) => {
      const next = new Set(s._recHandlers);
      next.delete(fn);
      return { _recHandlers: next };
    });
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
      const map = new Map<string, SessionMeta[]>();
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
      activeSession: { active: false },
      lastSeq: 0,
      relayState: { status: "disconnected", reconnectCount: 0 },
      sessions: [],
      _recHandlers: new Set(),
      _sessionsByDaemon: new Map(),
    }),
}));
