import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "./daemon";
import { BeginPairingError } from "./pairing/begin-pairing-error";
import type { RelayClient } from "./transport/relay-client";

describe("Daemon.beginPairing", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fakeRelay() {
    return {
      connect: async () => {},
      subscribe: () => {},
      dispose: () => {},
      isConnected: () => true,
    } as unknown as RelayClient;
  }

  test("begin generates a pairingId, qrString, and daemonId", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const info = await daemon.beginPairing({
      relayUrl: "wss://r",
      daemonId: "d1",
      label: "host-1",
    });
    expect(info.pairingId.length).toBeGreaterThan(0);
    expect(info.qrString.length).toBeGreaterThan(0);
    expect(info.daemonId).toBe("d1");

    daemon.cancelPendingPairing();
    daemon.stop();
  });

  test("auto-generates daemonId when none provided", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const info = await daemon.beginPairing({ relayUrl: "wss://r" });
    expect(info.daemonId).toMatch(/^daemon-/);

    daemon.cancelPendingPairing();
    daemon.stop();
  });

  test("second concurrent begin rejects with already-pending", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    await daemon.beginPairing({ relayUrl: "wss://r", daemonId: "d1" });
    await expect(
      daemon.beginPairing({ relayUrl: "wss://r", daemonId: "d2" }),
    ).rejects.toMatchObject({ reason: "already-pending" });

    daemon.cancelPendingPairing();
    daemon.stop();
  });

  test("begin with existing daemonId in store rejects with daemon-id-taken", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    // Seed the store with a pairing
    (daemon as unknown as {
      store: {
        savePairing: (x: unknown) => void;
      };
    }).store.savePairing({
      daemonId: "taken",
      relayUrl: "wss://r",
      relayToken: "t",
      registrationProof: "p",
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
      pairingSecret: new Uint8Array(32),
      label: null,
    });
    daemon.__setRelayFactory(() => fakeRelay());

    await expect(
      daemon.beginPairing({ relayUrl: "wss://r", daemonId: "taken" }),
    ).rejects.toMatchObject({ reason: "daemon-id-taken" });
    daemon.stop();
  });

  test("cancelPendingPairing resolves awaitPendingPairing with cancelled", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    await daemon.beginPairing({ relayUrl: "wss://r", daemonId: "d1" });
    const p = daemon.awaitPendingPairing();
    expect(p).not.toBeNull();
    daemon.cancelPendingPairing();
    const result = await p!;
    expect(result.kind).toBe("cancelled");
    daemon.stop();
  });

  test("promoteCompletedPairing persists and adds relay client to pool", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    await daemon.beginPairing({
      relayUrl: "wss://r",
      daemonId: "d1",
      label: "my-host",
    });
    // Simulate completion
    (daemon as unknown as { pendingPairing: { __markCompleted: (f: string) => void } }).pendingPairing.__markCompleted("frontend-1");
    const p = daemon.awaitPendingPairing();
    const result = await p!;
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("unreachable");
    daemon.promoteCompletedPairing(result);

    // Store should now have the pairing
    const pairings = (daemon as unknown as {
      store: { listPairings: () => Array<{ daemonId: string; label: string | null }> };
    }).store.listPairings();
    expect(pairings.some((p) => p.daemonId === "d1")).toBe(true);

    // Relay pool should now contain the promoted client
    const relayCount = (daemon as unknown as { relayClients: Array<unknown> }).relayClients.length;
    expect(relayCount).toBeGreaterThanOrEqual(1);

    daemon.stop();
  });

  test("awaitPendingPairing returns null when no pending", () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    expect(daemon.awaitPendingPairing()).toBeNull();
    daemon.stop();
  });

  test("cancelPendingPairing with mismatched pairingId is a no-op", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const info = await daemon.beginPairing({ relayUrl: "wss://r", daemonId: "d1" });
    daemon.cancelPendingPairing("wrong-id");
    // Pending still active
    expect(daemon.awaitPendingPairing()).not.toBeNull();

    daemon.cancelPendingPairing(info.pairingId);
    daemon.stop();
  });

  test("begin rejects with relay-unreachable when relay.connect throws", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => ({
      connect: async () => { throw new Error("ECONNREFUSED"); },
      subscribe: () => {},
      dispose: () => {},
      isConnected: () => false,
    } as unknown as RelayClient));

    await expect(
      daemon.beginPairing({ relayUrl: "wss://r", daemonId: "d1" }),
    ).rejects.toMatchObject({ reason: "relay-unreachable" });
    daemon.stop();
  });

  test("cancel after completion is a no-op (promote still works)", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    await daemon.beginPairing({ relayUrl: "wss://r", daemonId: "d-race", label: "x" });
    const pp = (daemon as unknown as { pendingPairing: { __markCompleted: (f: string) => void } }).pendingPairing;
    pp.__markCompleted("f1");
    const result = await daemon.awaitPendingPairing()!;
    expect(result.kind).toBe("completed");

    // Race: cancel after completion
    daemon.cancelPendingPairing();

    // Promote must still succeed, pairing persisted, relay in pool.
    if (result.kind !== "completed") throw new Error("unreachable");
    daemon.promoteCompletedPairing(result);

    const pairings = (daemon as unknown as { store: { listPairings: () => Array<{ daemonId: string }> } }).store.listPairings();
    expect(pairings.some((p) => p.daemonId === "d-race")).toBe(true);

    const relayCount = (daemon as unknown as { relayClients: Array<unknown> }).relayClients.length;
    expect(relayCount).toBeGreaterThanOrEqual(1);

    daemon.stop();
  });

  test("BeginPairingError has correct name and reason fields", () => {
    const e = new BeginPairingError("relay-unreachable", "ECONNREFUSED");
    expect(e.name).toBe("BeginPairingError");
    expect(e.reason).toBe("relay-unreachable");
    expect(e.message).toBe("ECONNREFUSED");
    expect(e instanceof Error).toBe(true);
  });
});
