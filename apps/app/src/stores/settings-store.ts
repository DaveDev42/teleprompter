import { create } from "zustand";
import { secureGet, secureSet } from "../lib/secure-storage";

export interface SettingsStore {
  chatFont: string;
  codeFont: string;
  terminalFont: string;
  fontSize: number;
  loaded: boolean;
  load: () => Promise<void>;
  setChatFont: (font: string) => Promise<void>;
  setCodeFont: (font: string) => Promise<void>;
  setTerminalFont: (font: string) => Promise<void>;
  setFontSize: (size: number) => Promise<void>;
}

const STORAGE_KEY = "app_settings";

interface SerializedSettings {
  chatFont: string;
  codeFont: string;
  terminalFont: string;
  fontSize: number;
}

const DEFAULTS: SerializedSettings = {
  chatFont: "Inter",
  codeFont: "JetBrains Mono",
  terminalFont: "JetBrains Mono",
  fontSize: 15,
};

async function persist(partial: Partial<SerializedSettings>) {
  const raw = await secureGet(STORAGE_KEY);
  const current: SerializedSettings = raw
    ? { ...DEFAULTS, ...JSON.parse(raw) }
    : { ...DEFAULTS };
  const updated = { ...current, ...partial };
  await secureSet(STORAGE_KEY, JSON.stringify(updated));
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  ...DEFAULTS,
  loaded: false,

  load: async () => {
    try {
      const raw = await secureGet(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SerializedSettings>;
        set({ ...DEFAULTS, ...parsed, loaded: true });
        return;
      }
    } catch {
      // ignore
    }
    set({ loaded: true });
  },

  setChatFont: async (font) => {
    set({ chatFont: font });
    await persist({ chatFont: font });
  },
  setCodeFont: async (font) => {
    set({ codeFont: font });
    await persist({ codeFont: font });
  },
  setTerminalFont: async (font) => {
    set({ terminalFont: font });
    await persist({ terminalFont: font });
  },
  setFontSize: async (size) => {
    set({ fontSize: size });
    await persist({ fontSize: size });
  },
}));
