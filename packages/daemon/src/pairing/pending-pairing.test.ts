import { describe, expect, mock, test } from "bun:test";
import type { RelayClient } from "../transport/relay-client";
import { PendingPairing } from "./pending-pairing";

function makeFakeRelayClient() {
  return {
    connect: mock(async () => {}),
    subscribe: mock(() => {}),
    dispose: mock(() => {}),
    isConnected: () => true,
  };
}

describe("PendingPairing", () => {
  test("begin() generates keys + QR and opens relay", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: "test-host",
      createRelayClient: () => relay as unknown as RelayClient,
    });

    const { qrString, daemonId, pairingId } = await pp.begin();

    expect(qrString.length).toBeGreaterThan(0);
    expect(daemonId).toBe("daemon-test");
    expect(pairingId.length).toBeGreaterThan(0);
    expect(relay.connect).toHaveBeenCalledTimes(1);
  });

  test("begin() passes the label to the createRelayClient factory", async () => {
    // Regression: before the fix, `createRelayClient` was called without
    // `label`, so RelayClient.config.label was undefined and
    // `broadcastDaemonPublicKey` sent `label: null` — the frontend kept its
    // device-name fallback rather than adopting the daemon's label.
    let capturedLabel: string | null | undefined;
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-label-test",
      label: "web-qa-r3",
      createRelayClient: (args) => {
        capturedLabel = args.label;
        return relay as unknown as RelayClient;
      },
    });

    await pp.begin();

    expect(capturedLabel).toBe("web-qa-r3");
  });

  test("awaitCompletion resolves on kx frame", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });

    await pp.begin();
    const p = pp.awaitCompletion();
    pp.__markCompleted("frontend-abc");
    const result = await p;
    expect(result.kind).toBe("completed");
  });

  test("cancel() resolves awaitCompletion with cancelled and disposes relay", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });

    await pp.begin();
    const p = pp.awaitCompletion();
    pp.cancel();
    const result = await p;
    expect(result.kind).toBe("cancelled");
    expect(relay.dispose).toHaveBeenCalled();
  });

  test("releaseRelay() returns the client once, then null (idempotent)", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });
    await pp.begin();
    const released = pp.releaseRelay();
    expect(released).toBe(relay as unknown as RelayClient);
    expect(pp.releaseRelay()).toBeNull();
  });

  test("begin() subscribes to __meta__ and __control__ channels", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });
    await pp.begin();
    expect(relay.subscribe).toHaveBeenCalledWith("__meta__");
    expect(relay.subscribe).toHaveBeenCalledWith("__control__");
  });

  test("completion + releaseRelay does NOT dispose the relay", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });
    await pp.begin();
    const p = pp.awaitCompletion();
    pp.__markCompleted("frontend-abc");
    await p;
    const released = pp.releaseRelay();
    expect(released).toBeDefined();
    expect(relay.dispose).not.toHaveBeenCalled();
  });

  test("awaitCompletion called after __markCompleted still resolves", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });
    await pp.begin();
    pp.__markCompleted("frontend-late");
    const result = await pp.awaitCompletion();
    expect(result.kind).toBe("completed");
  });

  test("awaitCompletion called twice before resolution throws", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });
    await pp.begin();
    pp.awaitCompletion();
    expect(() => pp.awaitCompletion()).toThrow();
  });

  test("__markCompleted is idempotent", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      label: null,
      createRelayClient: () => relay as unknown as RelayClient,
    });
    await pp.begin();
    const p = pp.awaitCompletion();
    pp.__markCompleted("frontend-first");
    pp.__markCompleted("frontend-second");
    const result = await p;
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.frontendId).toBe("frontend-first");
    }
  });
});
