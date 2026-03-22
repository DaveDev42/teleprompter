import { create } from "zustand";
import type { WsRec } from "@teleprompter/protocol";

export type RecHandler = (rec: WsRec) => void;

export interface SessionState {
  /** Current session ID */
  sid: string | null;
  /** Whether connected to Daemon WebSocket */
  connected: boolean;
  /** Last received sequence number */
  lastSeq: number;
  /** Record handlers (multiple consumers: terminal, chat) */
  _recHandlers: Set<RecHandler>;

  // Actions
  setSid: (sid: string | null) => void;
  setConnected: (connected: boolean) => void;
  setLastSeq: (seq: number) => void;
  addRecHandler: (fn: RecHandler) => void;
  removeRecHandler: (fn: RecHandler) => void;
  dispatchRec: (rec: WsRec) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sid: null,
  connected: false,
  lastSeq: 0,
  _recHandlers: new Set(),

  setSid: (sid) => set({ sid }),
  setConnected: (connected) => set({ connected }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
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
    set({ sid: null, connected: false, lastSeq: 0, _recHandlers: new Set() }),
}));
