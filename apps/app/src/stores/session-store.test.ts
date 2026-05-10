/**
 * Unit tests for session-store.
 *
 * Covers:
 *  - simple field setters (sid, lastSeq, lastError, reconnectCount)
 *  - session list updates (setSessions, updateSession)
 *  - record handler multicast: 2 handlers + one dispatch -> both invoked
 *  - handler unsubscribe stops future invocations
 *  - reset clears all fields and handler set
 *  - persistence: load + setSessions round-trip via mocked secureGet/secureSet
 *  - multi-daemon: sessions from two daemons are flattened into a single list
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must run before store dynamic import) ──

mock.module("react-native", () => ({
  Platform: { OS: "web" },
}));

// In-memory localStorage shim for secure-storage.ts (web code path).
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

import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";

// Dynamic import — evaluated AFTER mocks are registered.
const { useSessionStore } = await import("./session-store");

const SESSIONS_KEY = "tp_sessions_v1";

function storageGet(key: string): string | null {
  return fakeStorage.get(key) ?? null;
}

function makeRec(sid: string, seq: number): WsRec {
  return {
    t: "rec",
    sid,
    seq,
    k: "io",
    d: "",
    ts: Date.now(),
  };
}

function makeMeta(sid: string): WsSessionMeta {
  return {
    sid,
    state: "running",
    cwd: "/tmp",
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 0,
  };
}

function resetStore() {
  fakeStorage.clear();
  useSessionStore.getState().reset();
}

// ── Wait for debounced storage write to flush ──
function waitWrite(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

describe("session-store: simple setters", () => {
  beforeEach(resetStore);

  test("setSid / setLastSeq / setError / incrementReconnect", () => {
    const s = useSessionStore.getState();
    s.setSid("abc");
    expect(useSessionStore.getState().sid).toBe("abc");

    s.setLastSeq(42);
    expect(useSessionStore.getState().lastSeq).toBe(42);

    s.setError("boom");
    expect(useSessionStore.getState().lastError).toBe("boom");

    s.incrementReconnect();
    s.incrementReconnect();
    expect(useSessionStore.getState().reconnectCount).toBe(2);
  });
});

describe("session-store: session list", () => {
  beforeEach(resetStore);

  test("setSessions replaces the list for a daemon", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a"), makeMeta("b")]);
    expect(useSessionStore.getState().sessions.length).toBe(2);
  });

  test("setSessions for two daemons flattens into one list", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a")]);
    s.setSessions("d2", [makeMeta("b"), makeMeta("c")]);
    expect(useSessionStore.getState().sessions.length).toBe(3);
  });

  test("setSessions for same daemon overwrites its slot", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a"), makeMeta("b")]);
    s.setSessions("d1", [makeMeta("x")]);
    // d1's list is now just [x]
    expect(useSessionStore.getState().sessions.length).toBe(1);
    expect(useSessionStore.getState().sessions[0].sid).toBe("x");
  });

  test("updateSession updates existing by sid", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a"), makeMeta("b")]);
    s.updateSession("a", { ...makeMeta("a"), state: "idle" });
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.find((x) => x.sid === "a")?.state).toBe("idle");
    expect(sessions.find((x) => x.sid === "b")?.state).toBe("running");
  });

  test("updateSession appends if sid unknown", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a")]);
    s.updateSession("new", makeMeta("new"));
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.find((x) => x.sid === "new")).toBeDefined();
  });
});

describe("session-store: persistence", () => {
  beforeEach(resetStore);

  test("setSessions writes to storage after debounce", async () => {
    const s = useSessionStore.getState();
    s.setSessions("daemon-a", [makeMeta("sess-1"), makeMeta("sess-2")]);
    await waitWrite();

    const raw = storageGet(SESSIONS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "");
    expect(parsed["daemon-a"]).toHaveLength(2);
    expect(parsed["daemon-a"][0].sid).toBe("sess-1");
  });

  test("load restores sessions from storage", async () => {
    // Seed storage directly
    const data = {
      "daemon-x": [makeMeta("s1"), makeMeta("s2")],
      "daemon-y": [makeMeta("s3")],
    };
    fakeStorage.set(SESSIONS_KEY, JSON.stringify(data));

    // Reset in-memory state and reload
    useSessionStore.setState({
      sessions: [],
      _sessionsByDaemon: new Map(),
    });

    await useSessionStore.getState().load();

    const { sessions, _sessionsByDaemon } = useSessionStore.getState();
    expect(sessions.length).toBe(3);
    expect(_sessionsByDaemon.size).toBe(2);
    expect(_sessionsByDaemon.get("daemon-x")).toHaveLength(2);
    expect(_sessionsByDaemon.get("daemon-y")).toHaveLength(1);
  });

  test("load with empty/missing storage is a no-op", async () => {
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState()._sessionsByDaemon.size).toBe(0);
  });

  test("load with corrupted storage silently fails", async () => {
    fakeStorage.set(SESSIONS_KEY, "{{not json");
    await useSessionStore.getState().load();
    // Should not throw; state stays empty
    expect(useSessionStore.getState().sessions).toEqual([]);
  });

  test("round-trip: setSessions → load restores correct data", async () => {
    const s = useSessionStore.getState();
    s.setSessions("daemon-a", [makeMeta("sess-1")]);
    s.setSessions("daemon-b", [makeMeta("sess-2"), makeMeta("sess-3")]);
    await waitWrite();

    // Wipe in-memory state
    useSessionStore.setState({
      sessions: [],
      _sessionsByDaemon: new Map(),
    });
    expect(useSessionStore.getState().sessions.length).toBe(0);

    await useSessionStore.getState().load();

    const { sessions, _sessionsByDaemon } = useSessionStore.getState();
    expect(sessions.length).toBe(3);
    expect(_sessionsByDaemon.get("daemon-a")).toHaveLength(1);
    expect(_sessionsByDaemon.get("daemon-b")).toHaveLength(2);
    const sids = sessions.map((x) => x.sid).sort();
    expect(sids).toEqual(["sess-1", "sess-2", "sess-3"]);
  });
});

describe("session-store: record handler multicast", () => {
  beforeEach(resetStore);

  test("two handlers both receive a dispatched record", () => {
    const h1 = mock((_rec: WsRec) => {});
    const h2 = mock((_rec: WsRec) => {});

    const s = useSessionStore.getState();
    s.addRecHandler(h1);
    s.addRecHandler(h2);

    const rec = makeRec("sess-1", 1);
    s.dispatchRec(rec);

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h1.mock.calls[0][0]).toBe(rec);
    expect(h2.mock.calls[0][0]).toBe(rec);
  });

  test("dispatching multiple records delivers each to every handler", () => {
    const h1 = mock((_rec: WsRec) => {});
    const h2 = mock((_rec: WsRec) => {});

    const s = useSessionStore.getState();
    s.addRecHandler(h1);
    s.addRecHandler(h2);

    s.dispatchRec(makeRec("s", 1));
    s.dispatchRec(makeRec("s", 2));
    s.dispatchRec(makeRec("s", 3));

    expect(h1).toHaveBeenCalledTimes(3);
    expect(h2).toHaveBeenCalledTimes(3);
  });

  test("adding the same handler twice deduplicates via Set", () => {
    const h = mock((_rec: WsRec) => {});
    const s = useSessionStore.getState();
    s.addRecHandler(h);
    s.addRecHandler(h);

    s.dispatchRec(makeRec("s", 1));
    expect(h).toHaveBeenCalledTimes(1);
  });

  test("removeRecHandler stops future invocations", () => {
    const h1 = mock((_rec: WsRec) => {});
    const h2 = mock((_rec: WsRec) => {});

    const s = useSessionStore.getState();
    s.addRecHandler(h1);
    s.addRecHandler(h2);

    s.dispatchRec(makeRec("s", 1));
    s.removeRecHandler(h1);
    s.dispatchRec(makeRec("s", 2));

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(2);
  });

  test("dispatch with no handlers is a no-op", () => {
    const s = useSessionStore.getState();
    // Should not throw.
    s.dispatchRec(makeRec("s", 1));
    expect(useSessionStore.getState().sid).toBeNull();
  });
});

describe("session-store: reset", () => {
  test("reset clears all fields including handlers and persisted map", () => {
    const h = mock((_rec: WsRec) => {});
    const s = useSessionStore.getState();

    s.setSid("x");
    s.setLastSeq(99);
    s.setError("oops");
    s.incrementReconnect();
    s.setSessions("d1", [makeMeta("a")]);
    s.addRecHandler(h);

    s.reset();

    const after = useSessionStore.getState();
    expect(after.sid).toBeNull();
    expect(after.lastSeq).toBe(0);
    expect(after.lastError).toBeNull();
    expect(after.reconnectCount).toBe(0);
    expect(after.sessions).toEqual([]);
    expect(after._recHandlers.size).toBe(0);
    expect(after._sessionsByDaemon.size).toBe(0);

    // Dispatched records should not reach the cleared handler.
    after.dispatchRec(makeRec("s", 1));
    expect(h).not.toHaveBeenCalled();
  });
});
