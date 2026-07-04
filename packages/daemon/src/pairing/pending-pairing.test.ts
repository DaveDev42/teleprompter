import { describe, expect, mock, test } from "bun:test";
import { type Label, makeLabel } from "@teleprompter/protocol";
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
      hostname: "test-host",
      label: makeLabel("test-host"),
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
    let capturedLabel: Label | undefined;
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-label-test",
      hostname: "test-host",
      label: makeLabel("web-qa-r3"),
      createRelayClient: (args) => {
        capturedLabel = args.label;
        return relay as unknown as RelayClient;
      },
    });

    await pp.begin();

    expect(capturedLabel).toEqual({ set: true, value: "web-qa-r3" });
  });

  test("awaitCompletion resolves on kx frame", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      hostname: "test-host",
      label: { set: false },
      createRelayClient: () => relay as unknown as RelayClient,
    });

    await pp.begin();
    const p = pp.awaitCompletion();
    pp.__markCompleted("frontend-abc");
    const result = await p;
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("unreachable");
    // The completed result carries the QR-minted identity for promote().
    expect(result.pairingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.hostname).toBe("test-host");
    expect(result.frontendId).toBe("frontend-abc");
  });

  test("begin() threads hostname + minted pairingId into the createRelayClient config", async () => {
    let capturedPairingId: string | undefined;
    let capturedHostname: string | undefined;
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-thread",
      hostname: "Dave-MBP16",
      label: { set: false },
      createRelayClient: (args) => {
        capturedPairingId = args.pairingId;
        capturedHostname = args.hostname;
        return relay as unknown as RelayClient;
      },
    });

    const { pairingId } = await pp.begin();
    // The client's pairingId is the WIRE UUID (from the QR), not the local
    // pending-slot id — the first kx derives the PCT against it.
    expect(capturedPairingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(capturedPairingId).not.toBe(pairingId); // pairingId = pp-… slot id
    expect(capturedHostname).toBe("Dave-MBP16");
  });

  test("cancel() resolves awaitCompletion with cancelled and disposes relay", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      hostname: "test-host",
      label: { set: false },
      createRelayClient: () => relay as unknown as RelayClient,
    });

    await pp.begin();
    const p = pp.awaitCompletion();
    pp.cancel();
    const result = await p;
    expect(result.kind).toBe("cancelled");
    expect(relay.dispose).toHaveBeenCalled();
  });

  test("cancel() zeroizes the pairing secret + key material (defense-in-depth)", async () => {
    // The factory receives the live secret material; capture it so we can assert
    // cancel() wipes it. A cancelled pairing never hands these off, so leaving
    // live references on the heap is pure risk.
    let capturedSecret: Uint8Array | undefined;
    let capturedSecretKey: Uint8Array | undefined;
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-zeroize",
      hostname: "test-host",
      label: { set: false },
      createRelayClient: (args) => {
        capturedSecret = args.pairingSecret;
        capturedSecretKey = args.keyPair.secretKey;
        return relay as unknown as RelayClient;
      },
    });

    await pp.begin();
    // Sanity: real key material is non-zero before cancel.
    expect(capturedSecret?.some((b) => b !== 0)).toBe(true);
    expect(capturedSecretKey?.some((b) => b !== 0)).toBe(true);

    pp.cancel();

    // After cancel the buffers are wiped.
    expect(capturedSecret?.every((b) => b === 0)).toBe(true);
    expect(capturedSecretKey?.every((b) => b === 0)).toBe(true);
  });

  test("begin() bails (and creates no relay) if cancelled during its async setup", async () => {
    // REGRESSION: begin() awaits before creating the relay. If cancel() fires in
    // that window (CLI disconnect) it disposes a still-null relay (no-op), then
    // the old begin() would unconditionally create+connect a relay nobody owns —
    // an authenticated WS leaked until daemon restart. begin() must bail when
    // already settled, so the orchestrator's catch cleans up.
    let factoryCalls = 0;
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-cancel-race",
      hostname: "test-host",
      label: { set: false },
      createRelayClient: () => {
        factoryCalls++;
        return relay as unknown as RelayClient;
      },
    });

    // Simulate cancel() landing during begin()'s awaits by cancelling first.
    pp.cancel();
    await expect(pp.begin()).rejects.toThrow("cancelled before relay creation");
    expect(factoryCalls).toBe(0);
    expect(relay.connect).not.toHaveBeenCalled();
  });

  test("begin() throws a clean cancellation error (not a null-deref) when cancelled during connect()", async () => {
    // REGRESSION (rank 10): cancel() during the `await relay.connect()` window
    // nulls this.relay, so the subscribe() calls right after the await would
    // null-deref and surface to the operator as "relay unreachable: Cannot read
    // properties of null (reading 'subscribe')". begin() must re-check settled
    // after connect() and throw the descriptive cancellation error instead.
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-connect-cancel",
      hostname: "test-host",
      label: { set: false },
      createRelayClient: () => relay as unknown as RelayClient,
    });
    // cancel() fires synchronously DURING connect(), so when begin() resumes
    // after the await, this.settled is true and this.relay is null.
    relay.connect = mock(async () => {
      pp.cancel();
    });

    let caught: unknown;
    await pp.begin().catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "pairing cancelled during relay connect",
    );
    // Crucially NOT the null-deref message.
    expect((caught as Error).message).not.toContain("null");
    // No subscribe was attempted on the nulled relay.
    expect(relay.subscribe).not.toHaveBeenCalled();
  });

  test("releaseRelay() returns the client once, then null (idempotent)", async () => {
    const relay = makeFakeRelayClient();
    const pp = new PendingPairing({
      relayUrl: "wss://relay.test",
      daemonId: "daemon-test",
      hostname: "test-host",
      label: { set: false },
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
      hostname: "test-host",
      label: { set: false },
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
      hostname: "test-host",
      label: { set: false },
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
      hostname: "test-host",
      label: { set: false },
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
      hostname: "test-host",
      label: { set: false },
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
      hostname: "test-host",
      label: { set: false },
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
