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

/**
 * Validate and extract known fields from an unknown JSON value.
 * Returns only fields present in SerializedSettings with the correct primitive
 * type so that corrupt / future-versioned storage values cannot poison the store.
 */
function validateSettings(raw: unknown): Partial<SerializedSettings> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<SerializedSettings> = {};
  const obj = raw as Record<string, unknown>;
  if (typeof obj["chatFont"] === "string") out.chatFont = obj["chatFont"];
  if (typeof obj["codeFont"] === "string") out.codeFont = obj["codeFont"];
  if (typeof obj["terminalFont"] === "string")
    out.terminalFont = obj["terminalFont"];
  if (typeof obj["fontSize"] === "number") out.fontSize = obj["fontSize"];
  return out;
}

/**
 * Write the current in-memory settings to secure storage.
 * Reads the current values from the Zustand store (via `get()`) instead of
 * issuing a redundant `secureGet` — the store is always the freshest source
 * of truth after a `set()` call, and the extra read would introduce a
 * read-before-write race on native (expo-secure-store is async).
 */
function makePersist(get: () => SettingsStore) {
  return async function persist(partial: Partial<SerializedSettings>) {
    const { chatFont, codeFont, terminalFont, fontSize } = get();
    const updated: SerializedSettings = {
      chatFont,
      codeFont,
      terminalFont,
      fontSize,
      ...partial,
    };
    await secureSet(STORAGE_KEY, JSON.stringify(updated));
  };
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  const persist = makePersist(get);

  return {
    ...DEFAULTS,
    loaded: false,

    load: async () => {
      try {
        const raw = await secureGet(STORAGE_KEY);
        if (raw) {
          const parsed = validateSettings(JSON.parse(raw));
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
  };
});
