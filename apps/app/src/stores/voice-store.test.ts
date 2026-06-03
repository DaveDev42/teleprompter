/**
 * Unit tests for voice-store.ts — VoiceConnectionState + VoiceKeyState unions.
 *
 * Strategy: mock all external I/O (react-native Platform, secure-storage,
 * RealtimeClient, audio-web, terminal-context) so tests run fully in-process
 * with no native modules, network, or audio. The SUT is loaded via dynamic
 * import after all mocks are registered, following the relay-client.test.ts
 * pattern — static imports are hoisted above mock.module() calls.
 *
 * Run with:
 *   bun test apps/app/src/stores/voice-store.test.ts
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level mocks — must come BEFORE any import that touches react-native.
// Bun hoists mock.module() calls above static imports, but to be safe we
// use a dynamic import for the SUT below.
// ---------------------------------------------------------------------------

mock.module("react-native", () => ({ Platform: { OS: "web" as const } }));
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

// Mutable cells so individual tests can swap behaviour
let mockSecureGetImpl: (_key: string) => Promise<string | null> = async () =>
  null;
let mockSecureSetImpl: (_key: string, _value: string) => Promise<void> =
  async () => {};
let mockSecureDeleteImpl: (_key: string) => Promise<void> = async () => {};

const secureGetCalls: string[] = [];
const secureSetCalls: Array<[string, string]> = [];
const secureDeleteCalls: string[] = [];

mock.module("../lib/secure-storage", () => ({
  secureGet: async (key: string) => {
    secureGetCalls.push(key);
    return mockSecureGetImpl(key);
  },
  secureSet: async (key: string, value: string) => {
    secureSetCalls.push([key, value]);
    return mockSecureSetImpl(key, value);
  },
  secureDelete: async (key: string) => {
    secureDeleteCalls.push(key);
    return mockSecureDeleteImpl(key);
  },
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

// Install a minimal localStorage shim (used by secure-storage web branch)
const lsStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => {
    lsStore.set(k, v);
  },
  removeItem: (k: string) => {
    lsStore.delete(k);
  },
  clear: () => {
    lsStore.clear();
  },
  get length() {
    return lsStore.size;
  },
  key: (i: number) => Array.from(lsStore.keys())[i] ?? null,
};

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
  useVoiceStore.setState({
    connection: { status: "idle" } satisfies VoiceConnectionState,
    refinedPrompt: "",
    includeTerminal: false,
    keyState: { status: "loading" } satisfies VoiceKeyState,
    _onPromptReady: null,
  });
  // Reset call-tracking arrays
  secureGetCalls.length = 0;
  secureSetCalls.length = 0;
  secureDeleteCalls.length = 0;
  // Reset mock implementations to safe defaults
  mockSecureGetImpl = async () => null;
  mockSecureSetImpl = async () => {};
  mockSecureDeleteImpl = async () => {};
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
    mockSecureGetImpl = async () => null;
    await useVoiceStore.getState().load();
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("absent");
  });

  test("load() resolves to present when secureGet returns a key", async () => {
    mockSecureGetImpl = async () => "sk-test-key";
    await useVoiceStore.getState().load();
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("present");
    if (keyState.status === "present") {
      expect(keyState.key).toBe("sk-test-key");
    }
  });

  test("load() resolves to absent when secureGet throws", async () => {
    mockSecureGetImpl = async () => {
      throw new Error("storage error");
    };
    await useVoiceStore.getState().load();
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// Tests — setApiKey()
// ---------------------------------------------------------------------------

describe("VoiceKeyState union — setApiKey()", () => {
  beforeEach(resetStore);

  test("setApiKey('') sets absent and calls secureDelete", async () => {
    useVoiceStore.setState({
      keyState: { status: "present", key: "sk-old" },
    });
    await useVoiceStore.getState().setApiKey("");
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("absent");
    expect(secureDeleteCalls.length).toBe(1);
    expect(secureSetCalls.length).toBe(0);
  });

  test("setApiKey('sk-x') sets present with key and calls secureSet", async () => {
    await useVoiceStore.getState().setApiKey("sk-x");
    const { keyState } = useVoiceStore.getState();
    expect(keyState.status).toBe("present");
    if (keyState.status === "present") {
      expect(keyState.key).toBe("sk-x");
    }
    expect(secureSetCalls.length).toBe(1);
    expect(secureDeleteCalls.length).toBe(0);
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
