import { create } from "zustand";

export interface SessionState {
  /** Current session ID */
  sid: string | null;
  /** Whether connected to Daemon WebSocket */
  connected: boolean;
  /** Last received sequence number */
  lastSeq: number;

  // Actions
  setSid: (sid: string | null) => void;
  setConnected: (connected: boolean) => void;
  setLastSeq: (seq: number) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sid: null,
  connected: false,
  lastSeq: 0,

  setSid: (sid) => set({ sid }),
  setConnected: (connected) => set({ connected }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  reset: () => set({ sid: null, connected: false, lastSeq: 0 }),
}));
