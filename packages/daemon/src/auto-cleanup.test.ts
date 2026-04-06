import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { rmRetry } from "@teleprompter/protocol";
import { Daemon } from "./daemon";
import type { Store } from "./store";
import { backdateSession } from "./store/test-helpers";

function getStore(daemon: Daemon): Store {
  return (daemon as unknown as { store: Store }).store;
}

describe("Daemon auto-cleanup", () => {
  let daemon: Daemon;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "tp-daemon-cleanup-"));
    daemon = new Daemon(storeDir);
  });

  afterEach(async () => {
    daemon.stop();
    await rmRetry(storeDir);
  });

  test("startAutoCleanup prunes old sessions on startup", () => {
    const store = getStore(daemon);

    store.createSession("old-session", tmpdir());
    store.updateSessionState("old-session", "stopped");
    backdateSession(store, "old-session", 10 * 24 * 60 * 60 * 1000);

    store.createSession("new-session", tmpdir());
    store.updateSessionState("new-session", "stopped");

    daemon.startAutoCleanup(7);

    expect(store.getSession("old-session")).toBeUndefined();
    expect(store.getSession("new-session")).toBeDefined();
  });

  test("startAutoCleanup uses default 7-day TTL", () => {
    const store = getStore(daemon);

    store.createSession("s1", tmpdir());
    store.updateSessionState("s1", "stopped");
    backdateSession(store, "s1", 6 * 24 * 60 * 60 * 1000);

    daemon.startAutoCleanup(); // default TTL

    expect(store.getSession("s1")).toBeDefined();
  });

  test("startAutoCleanup respects TP_PRUNE_TTL_DAYS env var", () => {
    const store = getStore(daemon);

    store.createSession("s1", tmpdir());
    store.updateSessionState("s1", "stopped");
    backdateSession(store, "s1", 2 * 24 * 60 * 60 * 1000);

    const original = process.env.TP_PRUNE_TTL_DAYS;
    try {
      process.env.TP_PRUNE_TTL_DAYS = "1";
      daemon.startAutoCleanup(); // should use 1 day from env
      expect(store.getSession("s1")).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.TP_PRUNE_TTL_DAYS;
      } else {
        process.env.TP_PRUNE_TTL_DAYS = original;
      }
    }
  });

  test("stopAutoCleanup clears the interval", () => {
    daemon.startAutoCleanup(7);
    const timer = (
      daemon as unknown as {
        pruneTimer: ReturnType<typeof setInterval> | null;
      }
    ).pruneTimer;
    expect(timer).not.toBeNull();

    daemon.stopAutoCleanup();
    const timerAfter = (
      daemon as unknown as {
        pruneTimer: ReturnType<typeof setInterval> | null;
      }
    ).pruneTimer;
    expect(timerAfter).toBeNull();
  });

  test("stop() clears auto-cleanup timer", () => {
    daemon.startAutoCleanup(7);
    daemon.stop();
    const timer = (
      daemon as unknown as {
        pruneTimer: ReturnType<typeof setInterval> | null;
      }
    ).pruneTimer;
    expect(timer).toBeNull();
  });

  test("running sessions are not pruned regardless of age", () => {
    const store = getStore(daemon);

    store.createSession("running-old", tmpdir());
    // Don't change state — stays "running"
    backdateSession(store, "running-old", 30 * 24 * 60 * 60 * 1000);

    daemon.startAutoCleanup(7);

    expect(store.getSession("running-old")).toBeDefined();
  });
});
