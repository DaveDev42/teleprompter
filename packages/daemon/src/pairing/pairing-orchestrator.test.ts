import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { LABEL_UNSET, type Label, makeLabel } from "@teleprompter/protocol";
import type { Store } from "../store";
import {
  RelayClient,
  type RelayClientConfig,
  type RelayClientEvents,
} from "../transport/relay-client";
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
  const pairings: Array<{ daemonId: string; label: Label }> = [
    ...initialPairings.map((p) => ({
      daemonId: p.daemonId,
      label: LABEL_UNSET as Label,
    })),
  ];
  return {
    listPairings: mock(() => pairings),
    savePairing: mock((data: { daemonId: string; label?: Label }) => {
      pairings.push({
        daemonId: data.daemonId,
        label: data.label ?? LABEL_UNSET,
      });
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
      label: makeLabel("host"),
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
    if (p === null) throw new Error("expected pending promise");
    const result = await p;
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
      label: makeLabel("my-host"),
    });
    // Simulate completion
    const pending1 = orch.current;
    if (!pending1) throw new Error("expected pending pairing");
    pending1.__markCompleted("frontend-1");
    const awaitResult1 = orch.awaitPending();
    if (awaitResult1 === null) throw new Error("expected pending promise");
    const result = await awaitResult1;
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
      label: makeLabel("x"),
    });
    const pendingRace = orch.current;
    if (!pendingRace) throw new Error("expected pending pairing");
    pendingRace.__markCompleted("f1");
    const awaitResultRace = orch.awaitPending();
    if (awaitResultRace === null) throw new Error("expected pending promise");
    const result = await awaitResultRace;
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

    if (p === null) throw new Error("expected pending promise");
    const result = await p;
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
    const pendingStop = orch.current;
    if (!pendingStop) throw new Error("expected pending pairing");
    pendingStop.__markCompleted("frontend-x");
    // Drain the completion promise so the pairing is fully settled.
    const awaitResultStop = orch.awaitPending();
    if (awaitResultStop === null) throw new Error("expected pending promise");
    const result = await awaitResultStop;
    expect(result.kind).toBe("completed");

    // At this point the pairing is completed but promote() has not run —
    // relay is still owned by PendingPairing.
    expect(relay.dispose).not.toHaveBeenCalled();

    orch.stop();
    expect(relay.dispose).toHaveBeenCalledTimes(1);
    expect(orch.hasPending).toBe(false);
  });

  test("begin() passes resolved daemonId to buildEvents (push-token regression)", async () => {
    // Regression: buildEvents was called without the daemonId argument, so push
    // tokens received during pairing were stored with daemonId="" — unroutable.
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-push-test",
      label: makeLabel("host"),
    });

    expect(manager.buildEvents).toHaveBeenCalledTimes(1);
    const buildEventsArgs = (manager.buildEvents as ReturnType<typeof mock>)
      .mock.calls[0] as [unknown, unknown, string];
    // Third argument must be the resolved daemonId, NOT '' or undefined.
    expect(buildEventsArgs[2]).toBe("daemon-push-test");
  });

  test("begin() passes auto-generated daemonId to buildEvents", async () => {
    // When no explicit daemonId is supplied, begin() generates one — that
    // auto-generated id must also be forwarded to buildEvents.
    const relay = makeFakeRelayClient();
    const manager = makeFakeRelayManager({ factory: () => relay });
    const store = makeFakeStore();
    const orch = makeOrchestrator(manager, store);

    const info = await orch.begin({ relayUrl: "wss://r" });

    expect(manager.buildEvents).toHaveBeenCalledTimes(1);
    const buildEventsArgs = (manager.buildEvents as ReturnType<typeof mock>)
      .mock.calls[0] as [unknown, unknown, string];
    expect(buildEventsArgs[2]).toBe(info.daemonId);
    expect(info.daemonId).toMatch(/^daemon-/);
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
    const firstRelay = relays[0];
    if (firstRelay === undefined)
      throw new Error("expected first relay client");
    const pending = orch.current;
    if (!pending) throw new Error("expected pending pairing");
    pending.__markCompleted("frontend-x");
    const awaitResultC1 = orch.awaitPending();
    if (awaitResultC1 === null) throw new Error("expected pending promise");
    const result = await awaitResultC1;
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
    expect(relays[1]?.dispose).not.toHaveBeenCalled();
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
    const result = await orch.awaitPending();
    if (result?.kind !== "completed") throw new Error("expected completed");
    orch.promote(result);

    // After a successful promote, clearPending should not double-dispose.
    orch.clearPending();
    expect(relay.dispose).not.toHaveBeenCalled();
  });
});

/**
 * Rank-1 regression (daemon-audit): the production `onFrontendJoined` wrapper
 * must call `pp.__markCompleted` even when the inner buildEvents delegate
 * throws.
 *
 * This exercises the NON-factory code path (the `wrappedEvents` block in
 * begin()), which the rest of this file deliberately bypasses by injecting a
 * fake factory. The real `RelayClient` constructor is inert — it only stores
 * `config`/`events` and opens no socket until `connect()` (relay-client.ts) —
 * so we let the production path build a REAL client and only stub its
 * `connect`/`subscribe`/`dispose` via prototype `spyOn` (which `mockRestore`
 * cleanly undoes — unlike `mock.module`, which would leak the stub into every
 * other suite that imports the real RelayClient and was observed to break
 * relay-client.test.ts when co-run). We capture the constructed client via the
 * `attachHandlers` mock and read its `wrappedEvents` to drive onFrontendJoined.
 */
describe("PairingOrchestrator — rank-1 onFrontendJoined guard", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies.length = 0;
  });

  test("a throwing onFrontendJoined delegate still resolves the pairing (slot freed)", async () => {
    // Per-instance inert stubs on the real prototype — restored in afterEach.
    spies.push(
      spyOn(RelayClient.prototype, "connect").mockImplementation(
        async () => {},
      ),
    );
    spies.push(
      spyOn(RelayClient.prototype, "subscribe").mockImplementation(() => {}),
    );
    spies.push(
      spyOn(RelayClient.prototype, "dispose").mockImplementation(() => {}),
    );

    // buildEvents returns a delegate whose onFrontendJoined ALWAYS throws,
    // simulating a transient store.listSessions() / SQLite failure during the
    // frontend hello. NO factory → the production wrapper path runs.
    const delegateCalls: string[] = [];
    let captured: RelayClient | null = null;
    const manager = {
      buildEvents: mock(() => ({
        onFrontendJoined: (frontendId: string) => {
          delegateCalls.push(frontendId);
          throw new Error("transient SQLite error during hello");
        },
      })),
      // attachHandlers receives the REAL client the production path built.
      attachHandlers: mock((client: RelayClient) => {
        captured = client;
      }),
      __getFactory: () => null, // force the non-factory production path
      registerClient: mock(() => {}),
    };
    const store = makeFakeStore();
    const orch = new PairingOrchestrator({
      relayManager: manager as unknown as Pick<
        RelayConnectionManager,
        "buildEvents" | "attachHandlers" | "__getFactory" | "registerClient"
      >,
      store: store as unknown as Pick<Store, "listPairings" | "savePairing">,
    });

    await orch.begin({
      relayUrl: "wss://r",
      daemonId: "daemon-rank1",
      label: makeLabel("host"),
    });

    if (captured === null) {
      throw new Error("expected production path to build a RelayClient");
    }
    // The orchestrator handed the constructor `wrappedEvents` (private field).
    const wrappedEvents = (captured as unknown as { events: RelayClientEvents })
      .events;
    if (wrappedEvents?.onFrontendJoined == null) {
      throw new Error("expected wrappedEvents.onFrontendJoined to be present");
    }

    // Drive the wrapped delegate: the inner throw MUST be swallowed and
    // __markCompleted MUST still run (pre-fix, the throw escaped and the slot
    // never resolved).
    expect(() => wrappedEvents.onFrontendJoined?.("frontend-1")).not.toThrow();
    expect(delegateCalls).toEqual(["frontend-1"]);

    const result = await orch.awaitPending();
    expect(result?.kind).toBe("completed");
    if (result?.kind === "completed") {
      expect(result.frontendId).toBe("frontend-1");
    }
    // Slot is freed for promote/the next begin.
    expect(orch.current?.completed).toBe(true);
  });
});
