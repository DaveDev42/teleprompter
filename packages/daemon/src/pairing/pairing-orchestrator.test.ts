import { describe, expect, mock, test } from "bun:test";
import type { Store } from "../store";
import type { RelayClient, RelayClientConfig } from "../transport/relay-client";
import type { RelayConnectionManager } from "../transport/relay-manager";
import { BeginPairingError } from "./begin-pairing-error";
import { PairingOrchestrator } from "./pairing-orchestrator";

/**
 * Build a minimal fake {@link RelayClient} suitable for the orchestrator.
 * The orchestrator only exercises `connect` / `subscribe` / `dispose` via
 * the PendingPairing state machine.
 */
function makeFakeRelayClient(): RelayClient {
  return {
    connect: mock(async () => {}),
    subscribe: mock(() => {}),
    dispose: mock(() => {}),
    isConnected: () => true,
  } as unknown as RelayClient;
}

/**
 * Build a fake {@link RelayConnectionManager} scoped to the methods the
 * orchestrator actually calls. The factory slot lets tests inject a
 * `fakeRelay` just like `Daemon.__setRelayFactory` does in production.
 */
function makeFakeRelayManager(
  opts: { factory?: (cfg: RelayClientConfig) => RelayClient } = {},
) {
  const registered: RelayClient[] = [];
  let factory = opts.factory ?? null;
  const manager = {
    buildEvents: mock(() => ({})),
    attachHandlers: mock(() => {}),
    __getFactory: () => factory,
    registerClient: (c: RelayClient) => {
      registered.push(c);
    },
    // Helpers for tests
    __registered: registered,
    __setFactory: (f: (cfg: RelayClientConfig) => RelayClient) => {
      factory = f;
    },
  };
  return manager;
}

function makeFakeStore(initialPairings: Array<{ daemonId: string }> = []) {
  const pairings: Array<{ daemonId: string; label: string | null }> = [
    ...initialPairings.map((p) => ({ daemonId: p.daemonId, label: null })),
  ];
  return {
    listPairings: mock(() => pairings),
    savePairing: mock((data: { daemonId: string; label?: string | null }) => {
      pairings.push({ daemonId: data.daemonId, label: data.label ?? null });
    }),
    __pairings: pairings,
  };
}

type FakeRelayManager = ReturnType<typeof makeFakeRelayManager>;
type FakeStore = ReturnType<typeof makeFakeStore>;

function makeOrchestrator(
  relayManager: FakeRelayManager,
  store: FakeStore,
): PairingOrchestrator {
  return new PairingOrchestrator({
    relayManager: relayManager as unknown as Pick<
      RelayConnectionManager,
      "buildEvents" | "attachHandlers" | "__getFactory" | "registerClient"
    >,
    store: store as unknown as Pick<Store, "listPairings" | "savePairing">,
  });
}

describe("PairingOrchestrator", () => {
  test("begin() returns pairingId, qrString, daemonId", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    const info = await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-d1",
      label: "host",
    });

    expect(info.pairingId.length).toBeGreaterThan(0);
    expect(info.qrString.length).toBeGreaterThan(0);
    expect(info.daemonId).toBe("daemon-d1");
    expect(orch.hasPending).toBe(true);
    expect(orch.current).not.toBeNull();
  });

  test("begin() auto-generates daemonId when none provided", async () => {
    const manager = makeFakeRelayManager({
      factory: () => makeFakeRelayClient(),
    });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    const info = await orch.begin({ relayUrl: "wss://r" });
    expect(info.daemonId).toMatch(/^daemon-/);
  });

  test("begin() rejects with already-pending when another pending exists", async () => {
    const manager = makeFakeRelayManager({
      factory: () => makeFakeRelayClient(),
    });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    await expect(
      orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d2" }),
    ).rejects.toBeInstanceOf(BeginPairingError);
    await expect(
      orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d2" }),
    ).rejects.toMatchObject({ reason: "already-pending" });
  });

  test("begin() rejects with daemon-id-taken when store has the id", async () => {
    const manager = makeFakeRelayManager({
      factory: () => makeFakeRelayClient(),
    });
    const store = makeFakeStore([{ daemonId: "daemon-taken" }]);
    const orch = makeOrchestrator(manager, store);

    await expect(
      orch.begin({ relayUrl: "wss://r", daemonId: "daemon-taken" }),
    ).rejects.toMatchObject({ reason: "daemon-id-taken" });
    expect(orch.hasPending).toBe(false);
  });

  test("begin() rejects with relay-unreachable when relay.connect throws", async () => {
    const failingRelay = {
      connect: mock(async () => {
        throw new Error("ECONNREFUSED");
      }),
      subscribe: mock(() => {}),
      dispose: mock(() => {}),
      isConnected: () => false,
    } as unknown as RelayClient;
    const manager = makeFakeRelayManager({ factory: () => failingRelay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await expect(
      orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" }),
    ).rejects.toMatchObject({ reason: "relay-unreachable" });
    expect(orch.hasPending).toBe(false);
  });

  test("cancel() clears pending and resolves awaitPending with cancelled", async () => {
    const manager = makeFakeRelayManager({
      factory: () => makeFakeRelayClient(),
    });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    const p = orch.awaitPending();
    expect(p).not.toBeNull();
    orch.cancel();
    const result = await p!;
    expect(result.kind).toBe("cancelled");
    expect(orch.hasPending).toBe(false);
  });

  test("cancel() with mismatched pairingId is a no-op", async () => {
    const manager = makeFakeRelayManager({
      factory: () => makeFakeRelayClient(),
    });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    orch.cancel("wrong-id");
    expect(orch.hasPending).toBe(true);
  });

  test("promote() persists pairing and registers relay client with manager", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-d1",
      label: "my-host",
    });
    // Simulate completion
    orch.current!.__markCompleted("frontend-1");
    const result = await orch.awaitPending()!;
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("unreachable");

    orch.promote(result);

    expect(store.savePairing).toHaveBeenCalledTimes(1);
    expect(store.__pairings.some((p) => p.daemonId === "daemon-d1")).toBe(true);
    expect(manager.__registered).toContain(relay);
    expect(orch.hasPending).toBe(false);
  });

  test("cancel() after completion is a no-op (promote still works)", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-d-race",
      label: "x",
    });
    orch.current!.__markCompleted("f1");
    const result = await orch.awaitPending()!;
    expect(result.kind).toBe("completed");

    // Race: cancel after completion
    orch.cancel();

    // Pending slot still holds the completed PendingPairing so promote
    // can still run.
    expect(orch.hasPending).toBe(true);

    if (result.kind !== "completed") throw new Error("unreachable");
    orch.promote(result);

    expect(store.__pairings.some((p) => p.daemonId === "daemon-d-race")).toBe(
      true,
    );
    expect(manager.__registered).toContain(relay);
    expect(orch.hasPending).toBe(false);
  });

  test("awaitPending() returns null when no pending pairing", () => {
    const manager = makeFakeRelayManager();
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    expect(orch.awaitPending()).toBeNull();
    expect(orch.hasPending).toBe(false);
  });

  test("clearPending() drops pending without running cancel/promote", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    expect(orch.hasPending).toBe(true);

    orch.clearPending();
    expect(orch.hasPending).toBe(false);
    // Slot is free for a subsequent begin().
    const info = await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-d2",
    });
    expect(info.daemonId).toBe("daemon-d2");
  });

  test("stop() cancels pending pairing", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    const p = orch.awaitPending();

    orch.stop();

    const result = await p!;
    expect(result.kind).toBe("cancelled");
    expect(orch.hasPending).toBe(false);
  });

  test("stop() is a no-op when no pending pairing", () => {
    const manager = makeFakeRelayManager();
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);
    // Should not throw
    orch.stop();
    expect(orch.hasPending).toBe(false);
  });

  test("stop() disposes the relay even for a completed-but-not-promoted pending", async () => {
    // Regression: if a frontend joins just before daemon.stop() runs,
    // PendingPairing transitions to `completed` and cancel() becomes a
    // no-op. stop() must still dispose the orphan RelayClient.
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    orch.current!.__markCompleted("frontend-x");
    // Drain the completion promise so the pairing is fully settled.
    const result = await orch.awaitPending()!;
    expect(result.kind).toBe("completed");

    // At this point the pairing is completed but promote() has not run —
    // relay is still owned by PendingPairing.
    expect(relay.dispose).not.toHaveBeenCalled();

    orch.stop();
    expect(relay.dispose).toHaveBeenCalledTimes(1);
    expect(orch.hasPending).toBe(false);
  });

  test("attachHandlers is called on the factory-produced client", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    expect(manager.attachHandlers).toHaveBeenCalledTimes(1);
    expect(manager.attachHandlers).toHaveBeenCalledWith(relay, "daemon-d1");
  });

  test("clearPending() disposes the orphan relay client", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });

    // Simulate the failed-promote path: caller clears the slot without
    // running cancel (which would fire the completion promise) or promote
    // (which would hand the client off to the manager).
    orch.clearPending();

    expect(relay.dispose).toHaveBeenCalledTimes(1);
    expect(orch.hasPending).toBe(false);
  });

  test("clearPending() disposes the relay when promote() threw partway", async () => {
    // Specific C1 regression: Daemon's promote-failure handler calls
    // clearPending() after savePairing throws, before releaseRelay runs.
    // The orphan relay must be disposed.
    //
    // The factory produces a fresh fake per call so the round-trip
    // assertion below (second begin() after clearPending) exercises a
    // distinct mock, decoupling "slot is freed" from any disposed-mock
    // state the first pending left behind.
    const relays: RelayClient[] = [];
    const manager = makeFakeRelayManager({
      factory: () => {
        const r = makeFakeRelayClient();
        relays.push(r);
        return r;
      },
    });
    const throwingStore = {
      listPairings: mock(() => [] as Array<{ daemonId: string }>),
      // Declare the return type explicitly as `void` so we can swap in a
      // no-op later with `mockImplementation` without an `as never` cast.
      savePairing: mock<() => void>(() => {
        throw new Error("disk full");
      }),
    };
    const orch = new PairingOrchestrator({
      relayManager: manager as unknown as Pick<
        RelayConnectionManager,
        "buildEvents" | "attachHandlers" | "__getFactory" | "registerClient"
      >,
      store: throwingStore as unknown as Pick<
        Store,
        "listPairings" | "savePairing"
      >,
    });

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    const firstRelay = relays[0]!;
    const pending = orch.current;
    if (!pending) throw new Error("expected pending pairing");
    pending.__markCompleted("frontend-x");
    const result = await orch.awaitPending()!;
    if (result.kind !== "completed") throw new Error("expected completed");

    expect(() => orch.promote(result)).toThrow("disk full");
    // promote threw before releaseRelay — relay is still on pending
    expect(firstRelay.dispose).not.toHaveBeenCalled();

    orch.clearPending();
    expect(firstRelay.dispose).toHaveBeenCalledTimes(1);
    expect(orch.hasPending).toBe(false);

    // Slot is truly freed — a subsequent begin() must succeed on a fresh
    // relay. Swap savePairing to a no-op.
    throwingStore.savePairing.mockImplementation(() => {
      /* noop */
    });
    const info = await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-d2",
    });
    expect(info.daemonId).toBe("daemon-d2");
    expect(orch.hasPending).toBe(true);
    expect(relays).toHaveLength(2);
    expect(relays[1]!.dispose).not.toHaveBeenCalled();
  });

  test("clearPending() after promote() is a no-op (relay already released)", async () => {
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({ relayUrl: "wss://r", daemonId: "daemon-d1" });
    // Force PendingPairing into the completed state so promote() is valid.
    const pending = orch.current;
    if (!pending) throw new Error("expected pending pairing");
    pending.__markCompleted("frontend-x");
    const result = await orch.awaitPending()!;
    if (result.kind !== "completed") throw new Error("expected completed");
    orch.promote(result);

    // After a successful promote, clearPending should not double-dispose.
    orch.clearPending();
    expect(relay.dispose).not.toHaveBeenCalled();
  });
});
