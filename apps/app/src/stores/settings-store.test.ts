/**
 * Unit tests for settings-store.
 *
 * Covers:
 *  - load() validates JSON fields before spreading (idx 22)
 *  - persist() writes current Zustand state to storage without a pre-read
 *    (idx 68: no read-before-write race)
 *  - round-trip: set → persist → load restores state
 *  - corrupt / extra / missing fields in storage are handled gracefully
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must run before dynamic import) ──

mock.module("react-native", () => ({
  Platform: { OS: "web" },
}));

// In-memory localStorage shim (secure-storage.ts web branch).
const fakeStorage = new Map<string, string>();
// biome-ignore lint/suspicious/noExplicitAny: test shim
(globalThis as any).localStorage = {
  getItem: (k: string) => fakeStorage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    fakeStorage.set(k, v);
  },
  removeItem: (k: string) => {
    fakeStorage.delete(k);
  },
  clear: () => {
    fakeStorage.clear();
  },
};

// Dynamic import — evaluated AFTER mocks are registered.
const { useSettingsStore } = await import("./settings-store");

const STORAGE_KEY = "app_settings";
const WEB_PREFIX = "tp_";

function storageGet(key: string): string | null {
  return fakeStorage.get(WEB_PREFIX + key) ?? null;
}

function resetStore() {
  fakeStorage.clear();
  useSettingsStore.setState({
    chatFont: "Inter",
    codeFont: "JetBrains Mono",
    terminalFont: "JetBrains Mono",
    fontSize: 15,
    loaded: false,
  });
}

describe("settings-store: load()", () => {
  beforeEach(resetStore);

  test("load() with empty storage sets loaded:true and keeps defaults", async () => {
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.chatFont).toBe("Inter");
    expect(s.fontSize).toBe(15);
  });

  test("load() restores valid fields from storage", async () => {
    fakeStorage.set(
      WEB_PREFIX + STORAGE_KEY,
      JSON.stringify({ chatFont: "Roboto", fontSize: 18 }),
    );
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.chatFont).toBe("Roboto");
    expect(s.fontSize).toBe(18);
    // Unspecified fields fall back to defaults.
    expect(s.codeFont).toBe("JetBrains Mono");
  });

  test("load() ignores fields with wrong types — no store pollution (idx 22)", async () => {
    // fontSize is a number field; an injected string must be ignored (falls back to default).
    fakeStorage.set(
      WEB_PREFIX + STORAGE_KEY,
      JSON.stringify({ chatFont: "Roboto", fontSize: "not-a-number" }),
    );
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.chatFont).toBe("Roboto");
    // fontSize must stay at the default (15), not "not-a-number".
    expect(s.fontSize).toBe(15);
  });

  test("load() ignores unknown extra fields (idx 22)", async () => {
    fakeStorage.set(
      WEB_PREFIX + STORAGE_KEY,
      JSON.stringify({
        chatFont: "Arial",
        fontSize: 14,
        unknownField: "should be ignored",
      }),
    );
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.chatFont).toBe("Arial");
    expect(s.fontSize).toBe(14);
    // TypeScript type guard: unknownField must not appear on the store.
    expect(("unknownField" in s) as boolean).toBe(false);
  });

  test("load() with non-object JSON falls back to defaults (idx 22)", async () => {
    fakeStorage.set(
      WEB_PREFIX + STORAGE_KEY,
      JSON.stringify(["not", "an", "object"]),
    );
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.chatFont).toBe("Inter");
    expect(s.fontSize).toBe(15);
  });

  test("load() with corrupt JSON does not throw, sets loaded:true", async () => {
    fakeStorage.set(WEB_PREFIX + STORAGE_KEY, "{{not json");
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().loaded).toBe(true);
  });
});

describe("settings-store: persist writes from Zustand state not secureGet (idx 68)", () => {
  beforeEach(resetStore);

  test("setChatFont writes the new value to storage without reading storage first", async () => {
    // No prior storage value — the setter must derive the persisted blob from
    // the in-memory store state, not from a secureGet round-trip.
    await useSettingsStore.getState().setChatFont("Hack");
    expect(useSettingsStore.getState().chatFont).toBe("Hack");
    const raw = storageGet(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "");
    expect(parsed.chatFont).toBe("Hack");
    // Other fields must match defaults.
    expect(parsed.codeFont).toBe("JetBrains Mono");
    expect(parsed.fontSize).toBe(15);
  });

  test("setFontSize merges with the current in-memory state", async () => {
    // Set chatFont first (changes in-memory state), then fontSize.
    // The fontSize persist must see the already-changed chatFont.
    await useSettingsStore.getState().setChatFont("Inconsolata");
    await useSettingsStore.getState().setFontSize(20);
    const raw = storageGet(STORAGE_KEY);
    const parsed = JSON.parse(raw ?? "");
    expect(parsed.chatFont).toBe("Inconsolata");
    expect(parsed.fontSize).toBe(20);
  });
});

describe("settings-store: round-trip", () => {
  beforeEach(resetStore);

  test("set → persist → load restores all settings", async () => {
    await useSettingsStore.getState().setChatFont("Courier");
    await useSettingsStore.getState().setCodeFont("Fira Code");
    await useSettingsStore.getState().setTerminalFont("Consolas");
    await useSettingsStore.getState().setFontSize(13);

    // Save the storage state that was written by the setters.
    const savedStorage = new Map(fakeStorage);

    // Wipe in-memory state only (restore storage so load() can read it).
    useSettingsStore.setState({
      chatFont: "Inter",
      codeFont: "JetBrains Mono",
      terminalFont: "JetBrains Mono",
      fontSize: 15,
      loaded: false,
    });
    // Restore storage so load() can read what the setters persisted.
    fakeStorage.clear();
    for (const [k, v] of savedStorage) fakeStorage.set(k, v);

    expect(useSettingsStore.getState().chatFont).toBe("Inter");

    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.chatFont).toBe("Courier");
    expect(s.codeFont).toBe("Fira Code");
    expect(s.terminalFont).toBe("Consolas");
    expect(s.fontSize).toBe(13);
    expect(s.loaded).toBe(true);
  });
});
