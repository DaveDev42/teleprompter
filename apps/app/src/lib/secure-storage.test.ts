/**
 * Unit tests for secure-storage.ts.
 *
 * secure-storage.ts reads `Platform.OS` at both module load time (to decide
 * whether to `require("expo-secure-store")`) and at each call site. We mock
 * both `react-native` and `expo-secure-store` via `mock.module` so the module
 * can be loaded under Bun. To exercise both platform branches within a single
 * test file we re-import the SUT with a query-string cache-buster after
 * swapping the `react-native` mock.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

// In-memory SecureStore stub — Bun has no native keychain.
const secureStoreState = new Map<string, string>();

mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    const v = secureStoreState.get(key);
    return v === undefined ? null : v;
  },
  setItemAsync: async (key: string, value: string) => {
    secureStoreState.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStoreState.delete(key);
  },
}));

// `Platform.OS` defaults to "web". The native branch swaps this via remock +
// query-string re-import below.
mock.module("react-native", () => ({ Platform: { OS: "web" } }));

// Install a minimal localStorage shim on globalThis for the web branch.
function installLocalStorageShim() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  // @ts-expect-error — install into globalThis
  globalThis.localStorage = ls;
  return store;
}

describe("secure-storage (web branch)", () => {
  let localStorageBacking: Map<string, string>;
  // Loaded SUT — typed loosely since we re-import dynamically.
  let secureGet: (key: string) => Promise<string | null>;
  let secureSet: (key: string, value: string) => Promise<void>;
  let secureDelete: (key: string) => Promise<void>;

  beforeAll(async () => {
    localStorageBacking = installLocalStorageShim();
    const mod = await import("./secure-storage");
    secureGet = mod.secureGet;
    secureSet = mod.secureSet;
    secureDelete = mod.secureDelete;
  });

  test("get/set round-trip uses tp_ prefix in localStorage", async () => {
    await secureSet("alpha", "one");
    expect(localStorageBacking.get("tp_alpha")).toBe("one");
    expect(await secureGet("alpha")).toBe("one");
  });

  test("missing key returns null", async () => {
    expect(await secureGet("does-not-exist")).toBeNull();
  });

  test("delete removes the key", async () => {
    await secureSet("to-delete", "value");
    expect(await secureGet("to-delete")).toBe("value");
    await secureDelete("to-delete");
    expect(await secureGet("to-delete")).toBeNull();
    expect(localStorageBacking.has("tp_to-delete")).toBe(false);
  });

  test("overwrite updates the stored value", async () => {
    await secureSet("mut", "first");
    await secureSet("mut", "second");
    expect(await secureGet("mut")).toBe("second");
  });

  test("base64 serialization preserves binary payloads", async () => {
    // secure-storage stores strings only; binary is passed through via base64.
    const binary = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
    const b64 = Buffer.from(binary).toString("base64");
    await secureSet("binkey", b64);
    const fetched = await secureGet("binkey");
    expect(fetched).toBe(b64);
    const roundTripped = new Uint8Array(Buffer.from(fetched ?? "", "base64"));
    expect(Array.from(roundTripped)).toEqual(Array.from(binary));
  });

  test("localStorage throw is swallowed silently on get/set/delete", async () => {
    const original = globalThis.localStorage;
    // @ts-expect-error — temporarily replace with a throwing proxy
    globalThis.localStorage = new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error("storage full");
          };
        },
      },
    );

    await expect(secureSet("x", "y")).resolves.toBeUndefined();
    await expect(secureGet("x")).resolves.toBeNull();
    await expect(secureDelete("x")).resolves.toBeUndefined();

    // @ts-expect-error — restore real shim
    globalThis.localStorage = original;
  });
});

describe("secure-storage (native branch)", () => {
  let secureGetN: (key: string) => Promise<string | null>;
  let secureSetN: (key: string, value: string) => Promise<void>;
  let secureDeleteN: (key: string) => Promise<void>;

  beforeAll(async () => {
    secureStoreState.clear();
    // Swap react-native mock to report an iOS platform, then reload the SUT
    // with a query-string cache buster so top-level require() re-evaluates.
    mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
    const mod = await import("./secure-storage?native=1");
    secureGetN = mod.secureGet;
    secureSetN = mod.secureSet;
    secureDeleteN = mod.secureDelete;
  });

  test("set/get round-trip routes through expo-secure-store", async () => {
    await secureSetN("token", "abc123");
    expect(secureStoreState.get("token")).toBe("abc123");
    expect(await secureGetN("token")).toBe("abc123");
    // No tp_ prefix on native — the Keychain namespace is already app-scoped.
    expect(secureStoreState.has("tp_token")).toBe(false);
  });

  test("missing key returns null", async () => {
    expect(await secureGetN("missing-native")).toBeNull();
  });

  test("delete removes the SecureStore entry", async () => {
    await secureSetN("erase-me", "v");
    await secureDeleteN("erase-me");
    expect(secureStoreState.has("erase-me")).toBe(false);
  });

  test("base64 binary round-trip survives SecureStore path", async () => {
    const binary = new Uint8Array([9, 8, 7, 0, 255, 64]);
    const b64 = Buffer.from(binary).toString("base64");
    await secureSetN("binary-native", b64);
    const fetched = await secureGetN("binary-native");
    expect(fetched).toBe(b64);
    const decoded = new Uint8Array(Buffer.from(fetched ?? "", "base64"));
    expect(Array.from(decoded)).toEqual(Array.from(binary));
  });
});
