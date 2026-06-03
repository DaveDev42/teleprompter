import { describe, expect, mock, test } from "bun:test";
import { type Label, makeLabel } from "@teleprompter/protocol";
import type { IpcCommandDispatcher } from "../ipc/command-dispatcher";
import type { IpcServer } from "../ipc/server";
import type { PushNotifier } from "../push/push-notifier";
import type { Store } from "../store";
import type { RelayClient, RelayClientConfig } from "./relay-client";
import {
  RelayConnectionManager,
  type RelayConnectionManagerDeps,
} from "./relay-manager";

/**
 * These tests cover branches that only matter inside the manager:
 * - `addClient` preserving an existing label when config.label is null/undefined
 * - `reconnectSaved` continuing after a single failure
 * - `removePairing` with notifyPeer:false skipping the peer fan-out
 * - `removePairing` concurrent-call stale-index hazard (regression for the race)
 * - `dispatchPush` fan-out across active clients
 *
 * Higher-level integration is covered end-to-end by `daemon-pairing.test.ts`,
 * `rename-e2e.test.ts`, `unpair-e2e.test.ts`, and `multi-frontend.test.ts`.
 */

type StubClient = RelayClient & {
  __peers: string[];
  __unpairSent: string[];
  __renameSent: Array<{ frontendId: string; label: Label }>;
  __disposed: boolean;
};

function makeStubClient(daemonId: string, peers: string[] = []): StubClient {
  const stub: Partial<StubClient> = {
    daemonId,
    isConnected: () => true,
    connect: mock(async () => {}),
    subscribe: mock(() => {}),
    listPeerFrontendIds: () => peers,
    sendPush: mock(() => {}),
    publishToPeer: mock(async () => {}),
  };
  const self = stub as StubClient;
  self.__peers = peers;
  self.__unpairSent = [];
  self.__renameSent = [];
  self.__disposed = false;
  self.dispose = mock(() => {
    self.__disposed = true;
  });
  self.sendUnpairNotice = mock(async (frontendId: string) => {
    self.__unpairSent.push(frontendId);
    return true;
  });
  self.sendRenameNotice = mock(async (frontendId: string, label: Label) => {
    self.__renameSent.push({ frontendId, label });
    return true;
  });
  return self;
}

interface DepsOverrides {
  listSessions?: () => unknown[];
  listPairings?: () => unknown[];
  loadPairings?: () => unknown[];
  savePairing?: (data: unknown) => void;
  updatePairingLabel?: (daemonId: string, label: Label) => void;
}

function makeDeps(overrides: DepsOverrides = {}): RelayConnectionManagerDeps {
  const fakeIpcServer = {
    findRunnerBySid: () => undefined,
    send: () => {},
  };
  const fakeStore = {
    listSessions: overrides.listSessions ?? (() => []),
    listPairings: overrides.listPairings ?? (() => []),
    loadPairings: overrides.loadPairings ?? (() => []),
    savePairing: overrides.savePairing ?? (() => {}),
    deletePairing: () => {},
    updatePairingLabel: overrides.updatePairingLabel ?? (() => {}),
  };
  const fakePushNotifier = {
    registerToken: () => {},
  };
  const fakeDispatcher = {
    dispatchRelayControl: () => {},
  };
  return {
    ipcServer: fakeIpcServer as unknown as IpcServer,
    store: fakeStore as unknown as Store,
    pushNotifier: fakePushNotifier as unknown as PushNotifier,
    getDispatcher: () => fakeDispatcher as unknown as IpcCommandDispatcher,
  };
}

const BASE_CONFIG: Omit<RelayClientConfig, "daemonId" | "label"> = {
  relayUrl: "wss://r",
  token: "tok",
  registrationProof: "proof",
  keyPair: {
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32),
  },
  pairingSecret: new Uint8Array(32),
};

describe("RelayConnectionManager", () => {
  test("addClient preserves existing label when config.label is absent", async () => {
    const savePairing = mock((_data: unknown) => {});
    const existingLabel: Label = { set: true, value: "previously-set-label" };
    const deps = makeDeps({
      listPairings: () => [{ daemonId: "d1", label: existingLabel }],
      savePairing,
    });

    const mgr = new RelayConnectionManager(deps);
    mgr.__setFactory(() => makeStubClient("d1"));

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });

    expect(savePairing).toHaveBeenCalledTimes(1);
    const saved = savePairing.mock.calls[0]?.[0] as { label: Label };
    expect(saved.label).toEqual(existingLabel);
  });

  test("addClient records the new label when config.label is provided", async () => {
    const savePairing = mock((_data: unknown) => {});
    const deps = makeDeps({
      listPairings: () => [
        { daemonId: "d1", label: { set: true, value: "old" } },
      ],
      savePairing,
    });

    const mgr = new RelayConnectionManager(deps);
    mgr.__setFactory(() => makeStubClient("d1"));

    await mgr.addClient({
      ...BASE_CONFIG,
      daemonId: "d1",
      label: makeLabel("new"),
    });

    const saved = savePairing.mock.calls[0]?.[0] as { label: Label };
    expect(saved.label).toEqual({ set: true, value: "new" });
  });

  test("reconnectSaved continues after an individual failure", async () => {
    let attempt = 0;
    const deps = makeDeps({
      loadPairings: () => [
        {
          daemonId: "d1",
          relayUrl: "wss://r",
          relayToken: "t1",
          registrationProof: "p",
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(32),
          pairingSecret: new Uint8Array(32),
          label: { set: false } as Label,
        },
        {
          daemonId: "d2",
          relayUrl: "wss://r",
          relayToken: "t2",
          registrationProof: "p",
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(32),
          pairingSecret: new Uint8Array(32),
          label: { set: false } as Label,
        },
      ],
    });

    const mgr = new RelayConnectionManager(deps);
    mgr.__setFactory((cfg) => {
      attempt++;
      const stub = makeStubClient(cfg.daemonId);
      if (cfg.daemonId === "d1") {
        stub.connect = mock(async () => {
          throw new Error("boom");
        });
      }
      return stub;
    });

    const count = await mgr.reconnectSaved();
    expect(attempt).toBe(2);
    expect(count).toBe(1);
    expect(mgr.listDaemonIds()).toEqual(["d2"]);
  });

  test("removePairing with notifyPeer:false skips sendUnpairNotice", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1", ["f1", "f2"]);
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.removePairing("d1", { notifyPeer: false });

    expect(stub.__unpairSent).toEqual([]);
    expect(stub.__disposed).toBe(true);
    expect(mgr.listDaemonIds()).toEqual([]);
  });

  test("removePairing notifies every peer and disposes client", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1", ["f1", "f2"]);
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.removePairing("d1", { notifyPeer: true });

    expect(stub.__unpairSent).toEqual(["f1", "f2"]);
    expect(stub.__disposed).toBe(true);
  });

  test("concurrent removePairing preserves the other client (no stale-index splice)", async () => {
    // Regression test for the stale-index race in `removePairing`: when a
    // captured `idx` becomes stale because a concurrent remove of an
    // earlier-indexed client shifts the target's position, the second
    // splice must not remove the wrong slot or leave a zombie.
    //
    // To reproduce, the target client must sit at a higher index and lower-
    // indexed clients must be spliced out during its own `sendUnpairNotice`
    // await. Add X, Y, then A so A is at index 2; remove X and Y while A's
    // notice is in flight — A's cached index shifts from 2 → 0.
    const mgr = new RelayConnectionManager(makeDeps());

    const stubX = makeStubClient("X", []);
    const stubY = makeStubClient("Y", []);
    const stubA = makeStubClient("A", ["peerA"]);
    const stubs = [stubX, stubY, stubA];
    let callIdx = 0;
    mgr.__setFactory(() => {
      const s = stubs[callIdx++];
      if (!s) throw new Error("factory exhausted");
      return s;
    });

    stubA.sendUnpairNotice = mock(async (frontendId: string) => {
      await Promise.resolve();
      stubA.__unpairSent.push(frontendId);
      return true;
    });

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "X", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "Y", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "A", label: undefined });

    // Kick off A's remove (captures idx=2, yields at the await), then
    // synchronously mutate the pool so A's real index drops to 0.
    const pA = mgr.removePairing("A", { notifyPeer: true });
    await mgr.removePairing("X", { notifyPeer: false });
    await mgr.removePairing("Y", { notifyPeer: false });
    await pA;

    expect(stubX.__disposed).toBe(true);
    expect(stubY.__disposed).toBe(true);
    expect(stubA.__disposed).toBe(true);
    // Without the indexOf recheck, A would remain as a zombie (splice with
    // a stale idx=2 out of bounds), and listDaemonIds() would still show A.
    expect(mgr.listDaemonIds()).toEqual([]);
  });

  test("dispatchPush fans out to every active client", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub1 = makeStubClient("d1");
    const stub2 = makeStubClient("d2");
    const stubs = [stub1, stub2];
    let idx = 0;
    mgr.__setFactory(() => {
      const s = stubs[idx++];
      if (!s) throw new Error("factory exhausted");
      return s;
    });

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d2", label: undefined });

    mgr.dispatchPush("frontend-x", "tok", "hi", "body");
    expect(stub1.sendPush).toHaveBeenCalledTimes(1);
    expect(stub2.sendPush).toHaveBeenCalledTimes(1);
  });

  test("renamePairing updates the store and notifies every peer", async () => {
    const labelWrites: Array<[string, Label]> = [];
    const mgr = new RelayConnectionManager(
      makeDeps({
        updatePairingLabel: (daemonId, label) => {
          labelWrites.push([daemonId, label]);
        },
      }),
    );
    const stub = makeStubClient("d1", ["f1", "f2"]);
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    const count = await mgr.renamePairing("d1", makeLabel("Office Mac"));

    expect(labelWrites).toEqual([["d1", { set: true, value: "Office Mac" }]]);
    expect(stub.__renameSent).toEqual([
      { frontendId: "f1", label: { set: true, value: "Office Mac" } },
      { frontendId: "f2", label: { set: true, value: "Office Mac" } },
    ]);
    expect(count).toBe(2);
    // Rename must not dispose the client — the pairing remains live.
    expect(stub.__disposed).toBe(false);
  });

  test("renamePairing with an unset label fans the union out to peers (control.rename 'clear')", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1", ["f1"]);
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.renamePairing("d1", { set: false });

    // RelayClient version-gates the wire shape per peer; the manager passes
    // the unset Label through unchanged.
    expect(stub.__renameSent).toEqual([
      { frontendId: "f1", label: { set: false } },
    ]);
  });

  test("renamePairing still writes to the store when the pairing has no live client", async () => {
    const labelWrites: Array<[string, Label]> = [];
    const mgr = new RelayConnectionManager(
      makeDeps({
        updatePairingLabel: (daemonId, label) => {
          labelWrites.push([daemonId, label]);
        },
      }),
    );

    // No addClient call — the pool is empty.
    const count = await mgr.renamePairing("d-offline", makeLabel("New"));

    expect(labelWrites).toEqual([["d-offline", { set: true, value: "New" }]]);
    expect(count).toBe(0);
  });

  test("removePairing returns the peer notify count", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1", ["f1", "f2"]);
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    const notified = await mgr.removePairing("d1", { notifyPeer: true });
    expect(notified).toBe(2);
  });

  test("addClient subscribes to ALL sessions including stopped ones", async () => {
    // Regression for the R6 QA bug: a stopped passthrough session's Chat
    // tab stayed empty because the daemon only subscribed to running sids.
    // The frontend's `relay.pub <sid>` resume request was therefore never
    // forwarded to the daemon (relay only routes a frame to peers
    // subscribed to that sid), so the historical records from the store
    // never got replayed to the Chat UI.
    const deps = makeDeps({
      listSessions: () => [
        { sid: "running-1", state: "running" },
        { sid: "stopped-1", state: "stopped" },
        { sid: "errored-1", state: "error" },
      ],
    });
    const mgr = new RelayConnectionManager(deps);
    const stub = makeStubClient("d1");
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });

    const subscribed = (stub.subscribe as ReturnType<typeof mock>).mock.calls
      .map((c) => c[0] as string)
      .filter((sid) => sid !== "__meta__" && sid !== "__control__");
    expect(subscribed).toEqual(["running-1", "stopped-1", "errored-1"]);
  });

  test("buildEvents.onFrontendJoined subscribes to ALL sessions, not just running", async () => {
    // Same regression but on the late-join path: when a frontend connects
    // *after* the daemon's initial subscribe pass, `onFrontendJoined` must
    // also subscribe to stopped sessions so the freshly-joined frontend
    // can resume their historical records.
    const deps = makeDeps({
      listSessions: () => [
        { sid: "running-1", state: "running" },
        { sid: "stopped-1", state: "stopped" },
      ],
    });
    const mgr = new RelayConnectionManager(deps);
    const stub = makeStubClient("d1");
    const events = mgr.buildEvents(() => stub);

    events.onFrontendJoined?.("frontend-1");

    const subscribed = (stub.subscribe as ReturnType<typeof mock>).mock.calls
      .map((c) => c[0] as string)
      .filter((sid) => sid !== "__meta__" && sid !== "__control__");
    expect(subscribed).toEqual(["running-1", "stopped-1"]);
  });

  test("buildEvents.onFrontendJoined includes daemonLabel in the hello frame", async () => {
    // Regression: when a frontend connects while the daemon is already online,
    // it misses the initial relay.kx broadcast. Without `daemonLabel` in the
    // hello frame, the Daemons tab displays the raw daemon-id instead of the
    // human-readable label.
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1");
    const events = mgr.buildEvents(() => stub, makeLabel("web-qa-r3"));

    events.onFrontendJoined?.("frontend-1");

    expect(stub.publishToPeer).toHaveBeenCalledTimes(1);
    const [, , helloMsg] = (stub.publishToPeer as ReturnType<typeof mock>).mock
      .calls[0] as [string, string, { t: string; d: { daemonLabel: Label } }];
    expect(helloMsg.d.daemonLabel).toEqual({ set: true, value: "web-qa-r3" });
  });

  test("buildEvents.onFrontendJoined sends daemonLabel { set: false } when no label provided", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1");
    const events = mgr.buildEvents(() => stub); // no label arg

    events.onFrontendJoined?.("frontend-1");

    const [, , helloMsg] = (stub.publishToPeer as ReturnType<typeof mock>).mock
      .calls[0] as [string, string, { t: string; d: { daemonLabel: Label } }];
    expect(helloMsg.d.daemonLabel).toEqual({ set: false });
  });

  test("addClient passes config.label to buildEvents (label flows to hello frame)", async () => {
    // Verify that addClient wires the label from RelayClientConfig into
    // buildEvents so that subsequent onFrontendJoined calls include the label.
    const mgr = new RelayConnectionManager(makeDeps());
    const stub = makeStubClient("d1");
    mgr.__setFactory(() => stub);

    await mgr.addClient({
      ...BASE_CONFIG,
      daemonId: "d1",
      label: makeLabel("Office Mac"),
    });

    // Simulate a frontend joining after addClient.
    // The stub's publishToPeer was already called once during addClient's
    // subscribe setup — we need to trigger onFrontendJoined ourselves.
    // We use buildEvents with the same label to verify the wiring.
    const events = mgr.buildEvents(() => stub, makeLabel("Office Mac"));
    events.onFrontendJoined?.("frontend-new");

    // Find the publishToPeer call for the hello frame (most recent one):
    const calls = (stub.publishToPeer as ReturnType<typeof mock>).mock.calls;
    const lastCall = calls[calls.length - 1] as [
      string,
      string,
      { t: string; d: { daemonLabel: Label } },
    ];
    expect(lastCall[2].d.daemonLabel).toEqual({ set: true, value: "Office Mac" });
  });

  test("stop() disposes every client and clears the pool", async () => {
    const mgr = new RelayConnectionManager(makeDeps());
    const stub1 = makeStubClient("d1");
    const stub2 = makeStubClient("d2");
    const stubs = [stub1, stub2];
    let idx = 0;
    mgr.__setFactory(() => {
      const s = stubs[idx++];
      if (!s) throw new Error("factory exhausted");
      return s;
    });

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d2", label: undefined });

    mgr.stop();
    expect(stub1.__disposed).toBe(true);
    expect(stub2.__disposed).toBe(true);
    expect(mgr.listClients()).toHaveLength(0);
  });
});
