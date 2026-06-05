/**
 * Unit tests for offline-store.
 *
 * Covers:
 *  - updateState accepts only SessionState union values (idx 71)
 *  - cacheFrame ring-buffer eviction at MAX_CACHED_FRAMES
 *  - getRecentFrames / getLastState accessors
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("react-native", () => ({
  Platform: { OS: "web" },
}));

import type { SessionRec, SessionState } from "@teleprompter/protocol/client";

// Dynamic import — evaluated AFTER mocks are registered.
const { useOfflineStore } = await import("./offline-store");

function makeRec(sid: string, seq: number): SessionRec {
  return { t: "rec", sid, seq, k: "io", d: "", ts: Date.now() };
}

function resetStore() {
  useOfflineStore.setState({
    recentFrames: new Map(),
    lastStates: new Map(),
  });
}

describe("offline-store: updateState with SessionState union (idx 71)", () => {
  beforeEach(resetStore);

  test("updateState stores 'running' state", () => {
    const state: SessionState = "running";
    useOfflineStore.getState().updateState("sid-1", state);
    const entry = useOfflineStore.getState().getLastState("sid-1");
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("running");
    expect(typeof entry?.lastSeen).toBe("number");
  });

  test("updateState stores 'stopped' state", () => {
    const state: SessionState = "stopped";
    useOfflineStore.getState().updateState("sid-2", state);
    expect(useOfflineStore.getState().getLastState("sid-2")?.state).toBe(
      "stopped",
    );
  });

  test("updateState stores 'error' state", () => {
    const state: SessionState = "error";
    useOfflineStore.getState().updateState("sid-3", state);
    expect(useOfflineStore.getState().getLastState("sid-3")?.state).toBe(
      "error",
    );
  });

  test("updateState overwrites a previous value for the same sid", () => {
    useOfflineStore.getState().updateState("sid-x", "running");
    useOfflineStore.getState().updateState("sid-x", "stopped");
    expect(useOfflineStore.getState().getLastState("sid-x")?.state).toBe(
      "stopped",
    );
  });

  test("getLastState returns undefined for unknown sid", () => {
    expect(useOfflineStore.getState().getLastState("ghost")).toBeUndefined();
  });

  test("lastStates Map value type is { state: SessionState; lastSeen: number }", () => {
    useOfflineStore.getState().updateState("sid-t", "running");
    const entry = useOfflineStore.getState().getLastState("sid-t");
    // Compile-time: if state were typed as `string`, this equality check
    // would still pass, but the assignment to `SessionState` above would
    // error — the test itself encodes the type constraint.
    const _typed: SessionState = entry!.state;
    expect(["running", "stopped", "error"].includes(_typed)).toBe(true);
  });
});

describe("offline-store: cacheFrame ring-buffer", () => {
  beforeEach(resetStore);

  test("cacheFrame accumulates frames up to MAX_CACHED_FRAMES (10)", () => {
    for (let i = 0; i < 10; i++) {
      useOfflineStore.getState().cacheFrame(makeRec("s", i));
    }
    expect(useOfflineStore.getState().getRecentFrames("s").length).toBe(10);
  });

  test("cacheFrame evicts oldest frame when over the limit", () => {
    for (let i = 0; i < 11; i++) {
      useOfflineStore.getState().cacheFrame(makeRec("s", i));
    }
    const frames = useOfflineStore.getState().getRecentFrames("s");
    expect(frames.length).toBe(10);
    // seq 0 was evicted; seq 1 is now the oldest.
    expect(frames[0]?.seq).toBe(1);
    expect(frames[9]?.seq).toBe(10);
  });

  test("getRecentFrames returns [] for unknown sid", () => {
    expect(useOfflineStore.getState().getRecentFrames("ghost")).toEqual([]);
  });

  test("frames for different sids are independent", () => {
    useOfflineStore.getState().cacheFrame(makeRec("a", 1));
    useOfflineStore.getState().cacheFrame(makeRec("b", 2));
    expect(useOfflineStore.getState().getRecentFrames("a").length).toBe(1);
    expect(useOfflineStore.getState().getRecentFrames("b").length).toBe(1);
  });
});
