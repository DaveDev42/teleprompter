import { create } from "zustand";
import { secureGet, secureSet } from "../lib/secure-storage";

export interface ConnectionStore {
  /** Custom daemon WS URL (null = auto-detect) */
  daemonUrl: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  setDaemonUrl: (url: string | null) => Promise<void>;
}

const STORAGE_KEY = "daemon_url";

export const useConnectionStore = create<ConnectionStore>((set) => ({
  daemonUrl: null,
  loaded: false,

  load: async () => {
    const url = await secureGet(STORAGE_KEY);
    set({ daemonUrl: url || null, loaded: true });
  },

  setDaemonUrl: async (url) => {
    set({ daemonUrl: url });
    if (url) {
      await secureSet(STORAGE_KEY, url);
    } else {
      // Clear by setting empty
      await secureSet(STORAGE_KEY, "");
    }
  },
}));
