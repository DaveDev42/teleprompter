import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FrameDecoder } from "@teleprompter/protocol";
import { Daemon } from "./daemon";
import { BeginPairingError } from "./pairing/begin-pairing-error";
import type { ConnectedRunner } from "./ipc/server";
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

  // Helper: build a fake ConnectedRunner whose writer captures sent frames as parsed JSON.
  function makeFakeCli(): {
    runner: ConnectedRunner;
    messages: unknown[];
  } {
    const messages: unknown[] = [];
    const runner = {
      socket: {},
      writer: {
        write: (_s: unknown, frame: Uint8Array) => {
          // FrameDecoder understands the 4-byte length prefix; feed it the frame.
          const dec = new FrameDecoder();
          for (const m of dec.decode(frame)) messages.push(m);
        },
        drain: () => {},
      },
      decoder: new FrameDecoder(),
    } as unknown as ConnectedRunner;
    return { runner, messages };
  }

  test("pair.begin IPC: success path emits begin.ok + pair.completed", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const cli = makeFakeCli();

    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-ipc-ok",
      label: "ipc-host",
    });

    expect(cli.messages[0]).toMatchObject({
      t: "pair.begin.ok",
      daemonId: "d-ipc-ok",
    });
    expect((cli.messages[0] as { qrString: string }).qrString.length).toBeGreaterThan(0);

    // Trigger completion
    (daemon as unknown as { pendingPairing: { __markCompleted: (f: string) => void } }).pendingPairing.__markCompleted("f1");
    // Allow the microtask chain (awaitPendingPairing → promote → send completed) to run.
    await new Promise((r) => setTimeout(r, 10));

    const completed = cli.messages.find(
      (m) => (m as { t: string }).t === "pair.completed",
    );
    expect(completed).toMatchObject({
      t: "pair.completed",
      daemonId: "d-ipc-ok",
      label: "ipc-host",
    });

    daemon.stop();
  });

  test("pair.begin IPC: already-pending emits begin.err", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const cli = makeFakeCli();
    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d1",
    });

    const cli2 = makeFakeCli();
    await daemon.__handlePairBegin(cli2.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d2",
    });

    expect(cli2.messages[0]).toMatchObject({
      t: "pair.begin.err",
      reason: "already-pending",
    });

    daemon.cancelPendingPairing();
    daemon.stop();
  });

  test("pair.cancel IPC: cancels pending and emits pair.cancelled", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const cli = makeFakeCli();
    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-cancel",
    });
    const pairingId = (cli.messages[0] as { pairingId: string }).pairingId;

    daemon.__handlePairCancel(cli.runner, { t: "pair.cancel", pairingId });
    await new Promise((r) => setTimeout(r, 10));

    const cancelled = cli.messages.find(
      (m) => (m as { t: string }).t === "pair.cancelled",
    );
    expect(cancelled).toMatchObject({ t: "pair.cancelled", pairingId });

    daemon.stop();
  });

  test("CLI disconnect cancels pending pairing owned by that CLI", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const cli = makeFakeCli();
    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-disc",
    });

    daemon.__handleCliDisconnect(cli.runner);
    await new Promise((r) => setTimeout(r, 10));

    // pendingPairing should be cleared.
    expect(daemon.awaitPendingPairing()).toBeNull();
    daemon.stop();
  });

  // N1: disconnect after completion is harmless
  test("CLI disconnect after completion is a no-op", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const cli = makeFakeCli();
    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-disc-after",
    });
    (daemon as unknown as { pendingPairing: { __markCompleted: (f: string) => void } }).pendingPairing.__markCompleted("f1");
    await new Promise((r) => setTimeout(r, 10));
    // After completion, pendingPairing is cleared by the promote path.
    expect(
      (daemon as unknown as { pendingPairing: unknown }).pendingPairing,
    ).toBeNull();

    // Disconnect after completion — should be harmless.
    daemon.__handleCliDisconnect(cli.runner);
    // No pending, no error.
    expect(
      (daemon as unknown as { pendingPairing: unknown }).pendingPairing,
    ).toBeNull();
    daemon.stop();
  });

  // N2: pair.cancel with wrong pairingId is a no-op
  test("pair.cancel with mismatched pairingId does not cancel", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const cli = makeFakeCli();
    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-mismatch",
    });

    daemon.__handlePairCancel(cli.runner, { t: "pair.cancel", pairingId: "wrong-id" });
    // Still pending — check via internal field to avoid double-calling awaitCompletion().
    expect(
      (daemon as unknown as { pendingPairing: unknown }).pendingPairing,
    ).not.toBeNull();

    daemon.cancelPendingPairing();
    daemon.stop();
  });

  // I2 coverage: pair.cancel from non-owner runner is rejected
  test("pair.cancel from non-owner runner is ignored", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    const owner = makeFakeCli();
    await daemon.__handlePairBegin(owner.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-non-owner",
    });
    const pairingId = (owner.messages[0] as { pairingId: string }).pairingId;

    const intruder = makeFakeCli();
    daemon.__handlePairCancel(intruder.runner, { t: "pair.cancel", pairingId });
    // Still pending — intruder ignored. Check via internal field to avoid double-calling awaitCompletion().
    expect(
      (daemon as unknown as { pendingPairing: unknown }).pendingPairing,
    ).not.toBeNull();

    daemon.cancelPendingPairing();
    daemon.stop();
  });

  // C1 coverage: promote failure surfaces to CLI and clears pending slot
  test("promote failure emits pair.error and clears pending slot", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-"));
    const daemon = new Daemon(dir);
    daemon.__setRelayFactory(() => fakeRelay());

    // Inject a throwing savePairing.
    const store = (daemon as unknown as { store: { savePairing: (x: unknown) => void } }).store;
    const original = store.savePairing.bind(store);
    store.savePairing = () => { throw new Error("disk full"); };

    const cli = makeFakeCli();
    await daemon.__handlePairBegin(cli.runner, {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d-promote-fail",
    });
    (daemon as unknown as { pendingPairing: { __markCompleted: (f: string) => void } }).pendingPairing.__markCompleted("f1");
    await new Promise((r) => setTimeout(r, 20));

    const errEvt = cli.messages.find((m) => (m as { t: string }).t === "pair.error");
    expect(errEvt).toMatchObject({ t: "pair.error", reason: "internal" });
    expect((errEvt as { message: string }).message).toMatch(/disk full/);
    // Pending slot cleared so next pair.begin works.
    expect(
      (daemon as unknown as { pendingPairing: unknown }).pendingPairing,
    ).toBeNull();

    // Restore and clean up.
    store.savePairing = original;
    daemon.stop();
  });
});
