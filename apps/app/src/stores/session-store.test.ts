/**
 * Unit tests for session-store.
 *
 * Covers:
 *  - simple field setters (sid, lastSeq, lastError, reconnectCount)
 *  - session list updates (setSessions, updateSession)
 *  - record handler multicast: 2 handlers + one dispatch -> both invoked
 *  - handler unsubscribe stops future invocations
 *  - reset clears all fields and handler set
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";
import { useSessionStore } from "./session-store";

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
  useSessionStore.getState().reset();
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

  test("setSessions replaces the list", () => {
    const s = useSessionStore.getState();
    s.setSessions([makeMeta("a"), makeMeta("b")]);
    expect(useSessionStore.getState().sessions.length).toBe(2);
  });

  test("updateSession updates existing by sid", () => {
    const s = useSessionStore.getState();
    s.setSessions([makeMeta("a"), makeMeta("b")]);
    s.updateSession("a", { ...makeMeta("a"), state: "idle" });
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.find((x) => x.sid === "a")?.state).toBe("idle");
    expect(sessions.find((x) => x.sid === "b")?.state).toBe("running");
  });

  test("updateSession appends if sid unknown", () => {
    const s = useSessionStore.getState();
    s.setSessions([makeMeta("a")]);
    s.updateSession("new", makeMeta("new"));
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.find((x) => x.sid === "new")).toBeDefined();
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
  test("reset clears all fields including handlers", () => {
    const h = mock((_rec: WsRec) => {});
    const s = useSessionStore.getState();

    s.setSid("x");
    s.setLastSeq(99);
    s.setError("oops");
    s.incrementReconnect();
    s.setSessions([makeMeta("a")]);
    s.addRecHandler(h);

    s.reset();

    const after = useSessionStore.getState();
    expect(after.sid).toBeNull();
    expect(after.lastSeq).toBe(0);
    expect(after.lastError).toBeNull();
    expect(after.reconnectCount).toBe(0);
    expect(after.sessions).toEqual([]);
    expect(after._recHandlers.size).toBe(0);

    // Dispatched records should not reach the cleared handler.
    after.dispatchRec(makeRec("s", 1));
    expect(h).not.toHaveBeenCalled();
  });
});
