import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "@teleprompter/daemon";

describe("tp status (store-backed)", () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-status-test-"));
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  test("listSessions returns an array on a fresh store", () => {
    const daemon = new Daemon(storeDir);
    const sessions = daemon.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
    daemon.close();
  });

  test("listSessions reflects a seeded session", () => {
    // Seed via one Daemon instance, then read via another, simulating the
    // CLI reading the store while another daemon wrote to it.
    const seed = new Daemon(storeDir);
    // Access the store through a second path: create a session via the
    // internal Store by triggering createSession on the Daemon's handleHello
    // path requires IPC. Instead, use the exposed Store directly.
    // The Daemon constructor already owns a Store; poke it via listSessions
    // after inserting through the Store export.
    seed.close();

    // Reopen and seed via Store directly for a deterministic fixture.
    const { Store } = require("@teleprompter/daemon") as typeof import("@teleprompter/daemon");
    const store = new Store(storeDir);
    store.createSession("test-sid", "/tmp/some-cwd");
    store.close();

    const daemon = new Daemon(storeDir);
    const sessions = daemon.listSessions();
    expect(sessions.length).toBe(1);
    const s = sessions[0];
    expect(s.sid).toBe("test-sid");
    expect(s.cwd).toBe("/tmp/some-cwd");
    expect(typeof s.last_seq).toBe("number");
    daemon.close();
  });
});
