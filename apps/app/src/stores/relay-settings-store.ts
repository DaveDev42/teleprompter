import { create } from "zustand";
import { secureGet, secureSet } from "../lib/secure-storage";

export interface RelayEndpoint {
  url: string;
  label: string;
  active: boolean;
}

export interface RelaySettingsStore {
  relays: RelayEndpoint[];
  loaded: boolean;

  load: () => Promise<void>;
  addRelay: (url: string, label?: string) => Promise<void>;
  removeRelay: (url: string) => Promise<void>;
  toggleRelay: (url: string) => Promise<void>;
}

const STORAGE_KEY = "relay_endpoints";

export const useRelaySettingsStore = create<RelaySettingsStore>((set, get) => ({
  relays: [],
  loaded: false,

  load: async () => {
    const raw = await secureGet(STORAGE_KEY);
    if (raw) {
      try {
        const relays = JSON.parse(raw) as RelayEndpoint[];
        set({ relays, loaded: true });
        return;
      } catch (e) {
        console.warn(
          "[relay-settings] failed to parse stored relay endpoints:",
          e,
        );
      }
    }
    set({ loaded: true });
  },

  addRelay: async (url: string, label?: string) => {
    const existing = get().relays;
    if (existing.some((r) => r.url === url)) return;
    const next = [...existing, { url, label: label ?? url, active: true }];
    set({ relays: next });
    await secureSet(STORAGE_KEY, JSON.stringify(next));
  },

  removeRelay: async (url: string) => {
    const next = get().relays.filter((r) => r.url !== url);
    set({ relays: next });
    await secureSet(STORAGE_KEY, JSON.stringify(next));
  },

  toggleRelay: async (url: string) => {
    const next = get().relays.map((r) =>
      r.url === url ? { ...r, active: !r.active } : r,
    );
    set({ relays: next });
    await secureSet(STORAGE_KEY, JSON.stringify(next));
  },
}));
