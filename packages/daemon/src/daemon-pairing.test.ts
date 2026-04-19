import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "./daemon";
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

    daemon.stop();
  });
});
