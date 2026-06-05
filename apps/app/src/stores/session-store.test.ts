/**
 * Unit tests for session-store.
 *
 * Covers:
 *  - union setters (activeSession, relayState, bumpReconnect)
 *  - simple field setters (lastSeq)
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

import type { SessionMeta, SessionRec } from "@teleprompter/protocol/client";

// Dynamic import — evaluated AFTER mocks are registered.
const { useSessionStore } = await import("./session-store");

const SESSIONS_KEY = "tp_sessions_v1";

function storageGet(key: string): string | null {
  return fakeStorage.get(key) ?? null;
}

function makeRec(sid: string, seq: number): SessionRec {
  return {
    t: "rec",
    sid,
    seq,
    k: "io",
    d: "",
    ts: Date.now(),
  };
}

function makeMeta(sid: string): SessionMeta {
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

  test("setActiveSession / setLastSeq / setRelayState / bumpReconnect", () => {
    const s = useSessionStore.getState();

    // setActiveSession
    s.setActiveSession({ active: true, sid: "abc" });
    expect(useSessionStore.getState().activeSession).toEqual({
      active: true,
      sid: "abc",
    });

    // setActiveSession to inactive
    s.setActiveSession({ active: false });
    expect(useSessionStore.getState().activeSession).toEqual({ active: false });

    // setLastSeq
    s.setLastSeq(42);
    expect(useSessionStore.getState().lastSeq).toBe(42);

    // setRelayState to error
    s.setRelayState({ status: "error", message: "boom", reconnectCount: 0 });
    expect(useSessionStore.getState().relayState).toEqual({
      status: "error",
      message: "boom",
      reconnectCount: 0,
    });

    // setRelayState to connected
    s.setRelayState({ status: "connected" });
    expect(useSessionStore.getState().relayState).toEqual({
      status: "connected",
    });

    // bumpReconnect increments from current count
    s.setRelayState({ status: "disconnected", reconnectCount: 0 });
    s.bumpReconnect();
    s.bumpReconnect();
    expect(useSessionStore.getState().relayState).toEqual({
      status: "disconnected",
      reconnectCount: 2,
    });
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

  // ── H7 regression: updateSession must survive a subsequent rebuild ──
  //
  // Before the fix, updateSession patched `sessions` (the flat array) but
  // NOT `_sessionsByDaemon` (the source of truth). Any later mutator that
  // called flattenSessions(_sessionsByDaemon) — setSessions, removeSession,
  // removeSessions — would re-derive `sessions` from the stale map, silently
  // reverting the update. After a reconnect cycle the UI showed old state.
  test("H7 regression: updateSession survives a subsequent setSessions rebuild", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a"), makeMeta("b")]);

    // Update session "a" to state "idle"
    s.updateSession("a", { ...makeMeta("a"), state: "idle" });
    expect(
      useSessionStore.getState().sessions.find((x) => x.sid === "a")?.state,
    ).toBe("idle");

    // Now trigger a rebuild by calling setSessions for another daemon.
    // This calls flattenSessions internally. The update must survive.
    s.setSessions("d2", [makeMeta("c")]);
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.find((x) => x.sid === "a")?.state).toBe("idle");
    expect(sessions.find((x) => x.sid === "b")?.state).toBe("running");
    expect(sessions.find((x) => x.sid === "c")).toBeDefined();
  });

  test("H7 regression: updateSession survives a subsequent removeSession rebuild", () => {
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a"), makeMeta("b"), makeMeta("c")]);

    s.updateSession("a", { ...makeMeta("a"), state: "idle" });
    expect(
      useSessionStore.getState().sessions.find((x) => x.sid === "a")?.state,
    ).toBe("idle");

    // removeSession also calls flattenSessions — the updated state must survive.
    s.removeSession("c");
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.find((x) => x.sid === "a")?.state).toBe("idle");
    expect(sessions.find((x) => x.sid === "c")).toBeUndefined();
  });

  test("H7 regression: updateSession also updates _sessionsByDaemon", () => {
    // _sessionsByDaemon is the single source of truth. After updateSession the
    // map must contain the updated entry, not the stale one.
    const s = useSessionStore.getState();
    s.setSessions("d1", [makeMeta("a")]);

    s.updateSession("a", { ...makeMeta("a"), state: "idle" });

    const map = useSessionStore.getState()._sessionsByDaemon;
    const d1List = map.get("d1");
    expect(d1List?.find((x) => x.sid === "a")?.state).toBe("idle");
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
    const h1 = mock((_rec: SessionRec) => {});
    const h2 = mock((_rec: SessionRec) => {});

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
    const h1 = mock((_rec: SessionRec) => {});
    const h2 = mock((_rec: SessionRec) => {});

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
    const h = mock((_rec: SessionRec) => {});
    const s = useSessionStore.getState();
    s.addRecHandler(h);
    s.addRecHandler(h);

    s.dispatchRec(makeRec("s", 1));
    expect(h).toHaveBeenCalledTimes(1);
  });

  test("removeRecHandler stops future invocations", () => {
    const h1 = mock((_rec: SessionRec) => {});
    const h2 = mock((_rec: SessionRec) => {});

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
    expect(useSessionStore.getState().activeSession).toEqual({ active: false });
  });
});

describe("session-store: reset", () => {
  test("reset clears all fields including handlers and persisted map", () => {
    const h = mock((_rec: SessionRec) => {});
    const s = useSessionStore.getState();

    s.setActiveSession({ active: true, sid: "x" });
    s.setLastSeq(99);
    s.setRelayState({ status: "error", message: "oops", reconnectCount: 1 });
    s.bumpReconnect();
    s.setSessions("d1", [makeMeta("a")]);
    s.addRecHandler(h);

    s.reset();

    const after = useSessionStore.getState();
    expect(after.activeSession).toEqual({ active: false });
    expect(after.lastSeq).toBe(0);
    expect(after.relayState).toEqual({
      status: "disconnected",
      reconnectCount: 0,
    });
    expect(after.sessions).toEqual([]);
    expect(after._recHandlers.size).toBe(0);
    expect(after._sessionsByDaemon.size).toBe(0);

    // Dispatched records should not reach the cleared handler.
    after.dispatchRec(makeRec("s", 1));
    expect(h).not.toHaveBeenCalled();
  });
});
