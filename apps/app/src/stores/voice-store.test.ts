/**
 * Unit tests for voice-store.ts — VoiceConnectionState + VoiceKeyState unions.
 *
 * Strategy: mock all external I/O (react-native Platform, expo-secure-store,
 * RealtimeClient, audio-web, terminal-context) so tests run fully in-process
 * with no native modules, network, or audio. The SUT is loaded via dynamic
 * import after all mocks are registered, following the relay-client.test.ts
 * pattern — static imports are hoisted above mock.module() calls.
 *
 * Isolation contract:
 *   This file does NOT mock "../lib/secure-storage". Instead it mocks the LEAF
 *   modules that secure-storage.ts dispatches to — react-native (Platform.OS)
 *   and expo-secure-store — then drives the REAL secure-storage wrapper through
 *   a fake localStorage backed by a local Map (voiceStorage).
 *   globalThis.localStorage is saved in beforeAll and restored in afterAll so
 *   that any sibling test file's localStorage shim (e.g. relay-client.test.ts's
 *   fakeStorage) is not permanently displaced when both files run in the same
 *   bun test process.
 *
 * Run with:
 *   bun test apps/app/src/stores/voice-store.test.ts
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Leaf-module mocks — must come BEFORE any import that touches react-native.
// Bun hoists mock.module() calls above static imports, but to be safe we
// use a dynamic import for the SUT below.
//
// We mock react-native and expo-secure-store (leaf modules) so that
// secure-storage.ts's web branch is active (Platform.OS === "web"), and the
// expo-secure-store branch is bypassed. This is identical to what
// relay-client.test.ts does, so these two mocks do NOT collide across files.
// ---------------------------------------------------------------------------

mock.module("react-native", () => ({ Platform: { OS: "web" as const } }));
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

// Mock RealtimeClient — no actual WebSocket / OpenAI calls
mock.module("../voice/realtime-client", () => ({
  RealtimeClient: class {
    connect() {}
    sendAudio(_chunk: string) {}
    dispose() {}
  },
}));

// Mock audio-web (dynamic import inside startVoice callback)
mock.module("../voice/audio-web", () => ({
  AudioCapture: class {
    async start(_cb: (chunk: string) => void) {}
    stop() {}
  },
  AudioPlayer: class {
    start() {}
    stop() {}
    play(_b64: string) {}
  },
}));

// Mock terminal-context
mock.module("../voice/terminal-context", () => ({
  formatTerminalContext: (_ref: unknown) => "",
}));

// ---------------------------------------------------------------------------
// Fake localStorage — drives the REAL secure-storage wrapper's web branch.
// We save and restore globalThis.localStorage across the suite so sibling
// test files' localStorage shims are not permanently displaced.
// ---------------------------------------------------------------------------

const voiceStorage = new Map<string, string>();

function makeVoiceLocalStorage(): Storage {
  return {
    getItem: (k: string) => voiceStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      voiceStorage.set(k, String(v));
    },
    removeItem: (k: string) => {
      voiceStorage.delete(k);
    },
    clear: () => {
      voiceStorage.clear();
    },
    get length() {
      return voiceStorage.size;
    },
    key: (i: number) => Array.from(voiceStorage.keys())[i] ?? null,
  };
}

type GlobalWithLocalStorage = { localStorage?: Storage };

let savedLocalStorage: Storage | undefined;

beforeAll(() => {
  savedLocalStorage = (globalThis as GlobalWithLocalStorage).localStorage;
  (globalThis as GlobalWithLocalStorage).localStorage = makeVoiceLocalStorage();
});

afterAll(() => {
  // Restore the previous value (may be relay-client.test.ts's fakeStorage shim
  // or undefined if this file ran first).
  if (savedLocalStorage !== undefined) {
    (globalThis as GlobalWithLocalStorage).localStorage = savedLocalStorage;
  } else {
    delete (globalThis as GlobalWithLocalStorage).localStorage;
  }
});

// ---------------------------------------------------------------------------
// Dynamic import of the SUT — evaluated AFTER all mocks are registered
// ---------------------------------------------------------------------------
const voiceStoreModule = await import("./voice-store");
const { useVoiceStore } = voiceStoreModule;
type VoiceConnectionState = import("./voice-store").VoiceConnectionState;
type VoiceKeyState = import("./voice-store").VoiceKeyState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  voiceStorage.clear();
  useVoiceStore.setState({
    connection: { status: "idle" } satisfies VoiceConnectionState,
    refinedPrompt: "",
    includeTerminal: false,
    keyState: { status: "loading" } satisfies VoiceKeyState,
    _onPromptReady: null,
  });
}

// ---------------------------------------------------------------------------
// Tests — initial state
// ---------------------------------------------------------------------------

describe("VoiceConnectionState union — initial state", () => {
  beforeEach(resetStore);

  test("initial connection is idle", () => {
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("idle");
  });

  test("initial keyState is loading", () => {
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("loading");
  });
});

// ---------------------------------------------------------------------------
// Tests — load()
// ---------------------------------------------------------------------------

describe("VoiceKeyState union — load()", () => {
  beforeEach(resetStore);

  test("load() resolves to absent when secureGet returns null", async () => {
    // voiceStorage is empty → localStorage.getItem returns null → secureGet → null
    await useVoiceStore.getState().load();
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("absent");
  });

  test("load() resolves to present when secureGet returns a key", async () => {
    // Pre-populate storage with the key that secure-storage prefixes with "tp_"
    voiceStorage.set("tp_voice_api_key", "sk-test-key");
    await useVoiceStore.getState().load();
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("present");
    if (keyState.status === "present") {
      expect(keyState.key).toBe("sk-test-key");
    }
  });

  test("load() resolves to absent when secureGet throws", async () => {
    // Temporarily replace localStorage with a shim whose getItem throws so
    // secureGet's try/catch fires.  We swap back in the finally block so
    // subsequent tests see the normal voiceStorage-backed shim.
    const savedLs = (globalThis as GlobalWithLocalStorage).localStorage;
    (globalThis as GlobalWithLocalStorage).localStorage = {
      ...makeVoiceLocalStorage(),
      getItem: () => {
        throw new Error("storage error");
      },
    };
    try {
      await useVoiceStore.getState().load();
      const { keyState } = useVoiceStore.getState();
      expect(keyState.status).toBe("absent");
    } finally {
      (globalThis as GlobalWithLocalStorage).localStorage = savedLs;
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — setApiKey()
// ---------------------------------------------------------------------------

describe("VoiceKeyState union — setApiKey()", () => {
  beforeEach(resetStore);

  test("setApiKey('') sets absent and removes key from storage", async () => {
    // Start from a present state with something in storage.
    voiceStorage.set("tp_voice_api_key", "sk-old");
    useVoiceStore.setState({
      keyState: { status: "present", key: "sk-old" },
    });
    await useVoiceStore.getState().setApiKey("");
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("absent");
    // The real secure-storage must have called localStorage.removeItem.
    expect(voiceStorage.has("tp_voice_api_key")).toBe(false);
  });

  test("setApiKey('sk-x') sets present with key and persists to storage", async () => {
    await useVoiceStore.getState().setApiKey("sk-x");
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("present");
    if (keyState.status === "present") {
      expect(keyState.key).toBe("sk-x");
    }
    // The real secure-storage must have called localStorage.setItem.
    expect(voiceStorage.get("tp_voice_api_key")).toBe("sk-x");
  });
});

// ---------------------------------------------------------------------------
// Tests — startVoice() guard
// ---------------------------------------------------------------------------

describe("VoiceConnectionState union — startVoice guard", () => {
  beforeEach(resetStore);

  test("startVoice is a no-op when keyState is absent (guard)", async () => {
    useVoiceStore.setState({ keyState: { status: "absent" } });
    await useVoiceStore.getState().startVoice();
    const { connection } = useVoiceStore.getState();
    // Guard must have returned early — connection stays idle
    expect(connection.status).toBe("idle");
  });

  test("startVoice is a no-op when keyState is loading (guard)", async () => {
    useVoiceStore.setState({ keyState: { status: "loading" } });
    await useVoiceStore.getState().startVoice();
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Tests — stopVoice()
// ---------------------------------------------------------------------------

describe("VoiceConnectionState union — stopVoice", () => {
  beforeEach(resetStore);

  test("stopVoice resets connection to idle from listening", () => {
    useVoiceStore.setState({
      connection: {
        status: "listening",
        isSpeaking: true,
        transcript: "hello",
      },
    });
    useVoiceStore.getState().stopVoice();
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("idle");
  });

  test("stopVoice resets connection to idle from processing", () => {
    useVoiceStore.setState({
      connection: { status: "processing", transcript: "test" },
    });
    useVoiceStore.getState().stopVoice();
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Tests — union arm type narrowing
// ---------------------------------------------------------------------------

describe("VoiceConnectionState union — type narrowing", () => {
  beforeEach(resetStore);

  test("listening arm carries isSpeaking and transcript fields", () => {
    useVoiceStore.setState({
      connection: {
        status: "listening",
        isSpeaking: false,
        transcript: "hello world",
      },
    });
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("listening");
    if (connection.status === "listening") {
      expect(connection.isSpeaking).toBe(false);
      expect(connection.transcript).toBe("hello world");
    }
  });

  test("processing arm carries transcript field (no isSpeaking)", () => {
    useVoiceStore.setState({
      connection: { status: "processing", transcript: "think" },
    });
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("processing");
    if (connection.status === "processing") {
      expect(connection.transcript).toBe("think");
      // isSpeaking does NOT exist on the processing arm
      expect("isSpeaking" in connection).toBe(false);
    }
  });

  test("connecting arm has no extra payload fields", () => {
    useVoiceStore.setState({ connection: { status: "connecting" } });
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("connecting");
    expect("transcript" in connection).toBe(false);
    expect("isSpeaking" in connection).toBe(false);
  });

  test("idle arm has no extra payload fields", () => {
    useVoiceStore.setState({ connection: { status: "idle" } });
    const { connection } = useVoiceStore.getState();
    expect(connection.status).toBe("idle");
    expect("transcript" in connection).toBe(false);
  });
});
