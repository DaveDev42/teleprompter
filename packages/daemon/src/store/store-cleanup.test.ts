import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "./store";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";

describe("Store session cleanup", () => {
  let vault: Store;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "tp-vault-cleanup-"));
    vault = new Store(storeDir);
  });

  afterEach(async () => {
    vault.close();
    await rm(storeDir, { recursive: true, force: true });
  });

  test("deleteSession removes metadata and db file", () => {
    vault.createSession("s1", "/tmp");
    const db = vault.getSessionDb("s1");
    db!.append("io", Date.now(), Buffer.from("test"));

    expect(vault.getSession("s1")).toBeDefined();
    const dbPath = join(storeDir, "sessions", "s1.sqlite");
    expect(existsSync(dbPath)).toBe(true);

    vault.deleteSession("s1");

    expect(vault.getSession("s1")).toBeUndefined();
    expect(existsSync(dbPath)).toBe(false);
  });

  test("pruneOldSessions removes stopped sessions older than threshold", () => {
    // Create sessions with different ages
    vault.createSession("old-1", "/tmp");
    vault.createSession("old-2", "/tmp");
    vault.createSession("new-1", "/tmp");
    vault.createSession("running-1", "/tmp");

    // Mark old sessions as stopped and backdate
    vault.updateSessionState("old-1", "stopped");
    vault.updateSessionState("old-2", "error");
    vault.updateSessionState("new-1", "stopped");
    // running-1 stays as "running"

    // Backdate old sessions (simulate 2 hours ago)
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const metaDb = (vault as any).metaDb;
    metaDb.run("UPDATE sessions SET updated_at = ? WHERE sid IN ('old-1', 'old-2')", [twoHoursAgo]);

    // Prune sessions older than 1 hour
    const pruned = vault.pruneOldSessions(60 * 60 * 1000);
    expect(pruned).toBe(2); // old-1 and old-2

    // Verify
    expect(vault.getSession("old-1")).toBeUndefined();
    expect(vault.getSession("old-2")).toBeUndefined();
    expect(vault.getSession("new-1")).toBeDefined(); // too recent
    expect(vault.getSession("running-1")).toBeDefined(); // still running
  });

  test("pruneOldSessions returns 0 when nothing to prune", () => {
    vault.createSession("s1", "/tmp");
    const pruned = vault.pruneOldSessions(60 * 60 * 1000);
    expect(pruned).toBe(0);
  });
});
