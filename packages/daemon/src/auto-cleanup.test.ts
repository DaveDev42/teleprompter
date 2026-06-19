import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmRetry } from "@teleprompter/protocol/test-utils";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
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

  // ── Invalid TTL fallback: protect against silent data-loss or disabled pruning ──

  test("startAutoCleanup(0) falls back to DEFAULT_PRUNE_TTL_DAYS, does not wipe all sessions", () => {
    const store = getStore(daemon);

    // A session stopped within 7 days must survive — the fallback is 7d
    store.createSession("recent-stopped", tmpdir());
    store.updateSessionState("recent-stopped", "stopped");

    // A very old session should still be pruned (> 7d default)
    store.createSession("ancient", tmpdir());
    store.updateSessionState("ancient", "stopped");
    backdateSession(store, "ancient", 30 * 24 * 60 * 60 * 1000);

    daemon.startAutoCleanup(0); // 0 must fall back to default (7d)

    // Recent session must survive — not wiped wholesale
    expect(store.getSession("recent-stopped")).toBeDefined();
    // Ancient session is beyond the fallback 7d TTL and gets pruned
    expect(store.getSession("ancient")).toBeUndefined();
  });

  test("startAutoCleanup(-1) falls back to DEFAULT_PRUNE_TTL_DAYS", () => {
    const store = getStore(daemon);

    store.createSession("safe-session", tmpdir());
    store.updateSessionState("safe-session", "stopped");

    daemon.startAutoCleanup(-1); // negative must fall back to default

    // Session within default 7d TTL must survive
    expect(store.getSession("safe-session")).toBeDefined();
  });

  test("TP_PRUNE_TTL_DAYS=abc falls back to DEFAULT_PRUNE_TTL_DAYS", () => {
    const store = getStore(daemon);

    store.createSession("safe-session", tmpdir());
    store.updateSessionState("safe-session", "stopped");

    const original = process.env.TP_PRUNE_TTL_DAYS;
    try {
      process.env.TP_PRUNE_TTL_DAYS = "abc"; // NaN after Number()
      daemon.startAutoCleanup(); // no explicit arg, reads env

      // Session must survive — NaN should fall back to 7d default, not wipe all
      expect(store.getSession("safe-session")).toBeDefined();
    } finally {
      if (original === undefined) {
        delete process.env.TP_PRUNE_TTL_DAYS;
      } else {
        process.env.TP_PRUNE_TTL_DAYS = original;
      }
    }
  });

  test("TP_PRUNE_TTL_DAYS=0 falls back to DEFAULT_PRUNE_TTL_DAYS", () => {
    const store = getStore(daemon);

    store.createSession("safe-session", tmpdir());
    store.updateSessionState("safe-session", "stopped");

    const original = process.env.TP_PRUNE_TTL_DAYS;
    try {
      process.env.TP_PRUNE_TTL_DAYS = "0";
      daemon.startAutoCleanup();

      expect(store.getSession("safe-session")).toBeDefined();
    } finally {
      if (original === undefined) {
        delete process.env.TP_PRUNE_TTL_DAYS;
      } else {
        process.env.TP_PRUNE_TTL_DAYS = original;
      }
    }
  });
});
