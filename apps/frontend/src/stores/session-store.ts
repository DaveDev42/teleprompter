import { create } from "zustand";
import type { WsRec } from "@teleprompter/protocol";

export interface SessionState {
  /** Current session ID */
  sid: string | null;
  /** Whether connected to Daemon WebSocket */
  connected: boolean;
  /** Last received sequence number */
  lastSeq: number;
  /** Record callback (set by terminal/chat consumers) */
  _onRec: ((rec: WsRec) => void) | null;

  // Actions
  setSid: (sid: string | null) => void;
  setConnected: (connected: boolean) => void;
  setLastSeq: (seq: number) => void;
  setOnRec: (fn: ((rec: WsRec) => void) | null) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sid: null,
  connected: false,
  lastSeq: 0,
  _onRec: null,

  setSid: (sid) => set({ sid }),
  setConnected: (connected) => set({ connected }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setOnRec: (fn) => set({ _onRec: fn }),
  reset: () => set({ sid: null, connected: false, lastSeq: 0, _onRec: null }),
}));
