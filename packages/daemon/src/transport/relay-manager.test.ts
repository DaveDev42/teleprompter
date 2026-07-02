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
    sendPush: mock(() => true),
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
  deletePairing?: (daemonId: string) => void;
  updatePairingLabel?: (daemonId: string, label: Label) => void;
  findRunnerBySid?: (sid: string) => unknown;
  send?: (runner: unknown, msg: unknown) => void;
  handleTokenDead?: (frontendId: string) => void;
  handleUnsealFailed?: (frontendId: string) => void;
}

function makeDeps(overrides: DepsOverrides = {}): RelayConnectionManagerDeps {
  const fakeIpcServer = {
    findRunnerBySid: overrides.findRunnerBySid ?? (() => undefined),
    send: overrides.send ?? (() => {}),
  };
  const fakeStore = {
    listSessions: overrides.listSessions ?? (() => []),
    listPairings: overrides.listPairings ?? (() => []),
    loadPairings: overrides.loadPairings ?? (() => []),
    savePairing: overrides.savePairing ?? (() => {}),
    deletePairing: overrides.deletePairing ?? (() => {}),
    updatePairingLabel: overrides.updatePairingLabel ?? (() => {}),
    savePushToken: () => {},
    loadPushTokens: () => [],
    deletePushToken: () => {},
    deletePushTokensForDaemon: () => {},
  };
  const fakePushNotifier = {
    registerSealedToken: () => {},
    handleUnsealFailed: overrides.handleUnsealFailed ?? (() => {}),
    handleTokenDead: overrides.handleTokenDead ?? (() => {}),
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

  test("removePairing deletes the store row BEFORE disposing the client", async () => {
    // Regression for the resurrection bug: if deletePairing ran AFTER
    // dispose()+splice and threw, the client was gone but the pairings row
    // survived → reconnectSaved() resurrects it on the next daemon restart.
    // Assert ordering by recording the sequence of side effects.
    const order: string[] = [];
    const deps = makeDeps({
      deletePairing: () => order.push("deletePairing"),
    });
    const mgr = new RelayConnectionManager(deps);
    const stub = makeStubClient("d1", []);
    stub.dispose = mock(() => {
      stub.__disposed = true;
      order.push("dispose");
    });
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.removePairing("d1", { notifyPeer: false });

    expect(order).toEqual(["deletePairing", "dispose"]);
  });

  test("removePairing leaves the client in the pool when the store delete throws", async () => {
    // The store-first ordering means a transient deletePairing throw propagates
    // cleanly WITHOUT disposing the client — so in-memory state still matches
    // the (un-deleted) store row, rather than a disposed client + live row.
    const deps = makeDeps({
      deletePairing: () => {
        throw new Error("SQLITE_BUSY");
      },
    });
    const mgr = new RelayConnectionManager(deps);
    const stub = makeStubClient("d1", []);
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });

    await expect(
      mgr.removePairing("d1", { notifyPeer: false }),
    ).rejects.toThrow("SQLITE_BUSY");
    // Client NOT disposed and still in the pool — recoverable on retry.
    expect(stub.__disposed).toBe(false);
    expect(mgr.listDaemonIds()).toEqual(["d1"]);
  });

  test("concurrent removePairing for the SAME daemonId disposes the client once and preserves the notify count", async () => {
    // Regression for rank 11: an inbound control.unpair (notifyPeer:false)
    // racing a `tp pair delete` (notifyPeer:true) must not let the second call
    // re-dispose the client the first owns — which would make the notifyPeer
    // call's sendUnpairNotice run on a closed socket and report notified:0.
    const deps = makeDeps();
    const mgr = new RelayConnectionManager(deps);
    const stub = makeStubClient("d1", ["f1", "f2"]);
    let disposeCount = 0;
    stub.dispose = mock(() => {
      stub.__disposed = true;
      disposeCount++;
    });
    // Make the notify path yield so the second concurrent call interleaves
    // while the first is mid-notify.
    stub.sendUnpairNotice = mock(async (frontendId: string) => {
      await Promise.resolve();
      stub.__unpairSent.push(frontendId);
      return true;
    });
    mgr.__setFactory(() => stub);

    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });

    // Start the notifying remove first (it yields at sendUnpairNotice), then
    // fire the inbound-unpair remove for the SAME daemonId concurrently.
    const pNotify = mgr.removePairing("d1", { notifyPeer: true });
    const pInbound = mgr.removePairing("d1", { notifyPeer: false });
    const [notified] = await Promise.all([pNotify, pInbound]);

    // The notifying call still reports both peers (its client was not disposed
    // out from under it), and the client is disposed exactly once.
    expect(notified).toBe(2);
    expect(disposeCount).toBe(1);
    expect(mgr.listDaemonIds()).toEqual([]);
  });

  function makeTwoClientMgr(): {
    mgr: RelayConnectionManager;
    stub1: StubClient;
    stub2: StubClient;
  } {
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
    return { mgr, stub1, stub2 };
  }

  test("dispatchPush routes to ONLY the client whose daemonId sealed the token", async () => {
    // REGRESSION: dispatchPush used to fan out to EVERY client. A token is
    // sealed by one relay's PushSealer, so the non-owning relay replies
    // PUSH_UNSEAL_FAILED, and when two pairings share a relay URL the user gets
    // a DUPLICATE APNs push. Route by data.daemonId so only the owner is hit.
    const { mgr, stub1, stub2 } = makeTwoClientMgr();
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d2", label: undefined });

    mgr.dispatchPush("frontend-x", "tok", "hi", "body", undefined, {
      sid: "s1",
      event: "Notification",
      daemonId: "d2",
    });
    expect(stub1.sendPush).toHaveBeenCalledTimes(0);
    expect(stub2.sendPush).toHaveBeenCalledTimes(1);
  });

  test("dispatchPush falls back to fan-out when daemonId is absent (legacy token)", async () => {
    // Legacy token rows predate the daemonId column; with no owner to target we
    // fan out best-effort rather than silently drop the push.
    const { mgr, stub1, stub2 } = makeTwoClientMgr();
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d2", label: undefined });

    mgr.dispatchPush("frontend-x", "tok", "hi", "body");
    expect(stub1.sendPush).toHaveBeenCalledTimes(1);
    expect(stub2.sendPush).toHaveBeenCalledTimes(1);
  });

  test("dispatchPush falls back to fan-out when daemonId matches no connected client", async () => {
    // The owning relay isn't currently connected (e.g. mid-reconnect); fan out
    // so a still-connected relay that happens to hold the same pairing can try.
    const { mgr, stub1, stub2 } = makeTwoClientMgr();
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d1", label: undefined });
    await mgr.addClient({ ...BASE_CONFIG, daemonId: "d2", label: undefined });

    mgr.dispatchPush("frontend-x", "tok", "hi", "body", undefined, {
      sid: "s1",
      event: "Notification",
      daemonId: "d-not-connected",
    });
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

  test("buildEvents.onPushTokenDead evicts THAT frontend's token via handleTokenDead", () => {
    // Regression (finding #1): the relay.err PUSH_TOKEN_DEAD frame now carries
    // the owning frontendId, so the manager's onPushTokenDead handler must
    // surgically evict exactly that frontend's dead APNs token. Before the fix
    // it only logged — the dead token stayed in PushNotifier forever and every
    // future hook event re-sent to it, spamming PUSH_TOKEN_DEAD until restart.
    const dead: string[] = [];
    const deps = makeDeps({ handleTokenDead: (fid) => dead.push(fid) });
    const mgr = new RelayConnectionManager(deps);
    const events = mgr.buildEvents(() => makeStubClient("d1"));

    events.onPushTokenDead?.("frontend-dead-1");

    expect(dead).toEqual(["frontend-dead-1"]);
  });

  test("buildEvents.onPushUnsealFailed evicts THAT frontend's token via handleUnsealFailed", () => {
    // Sibling of the PUSH_TOKEN_DEAD path: a PUSH_UNSEAL_FAILED relay.err (seal
    // key rotated out / tampered) now carries the frontendId, so the manager
    // surgically drops that frontend's now-unusable sealed token.
    const unseal: string[] = [];
    const deps = makeDeps({ handleUnsealFailed: (fid) => unseal.push(fid) });
    const mgr = new RelayConnectionManager(deps);
    const events = mgr.buildEvents(() => makeStubClient("d1"));

    events.onPushUnsealFailed?.("frontend-unseal-1");

    expect(unseal).toEqual(["frontend-unseal-1"]);
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
    expect(lastCall[2].d.daemonLabel).toEqual({
      set: true,
      value: "Office Mac",
    });
  });

  test("buildEvents.onPushTokenSealed registers sealed token with the supplied daemonId", () => {
    // The legacy onPushToken E2EE path has been removed. Only the Path X
    // onPushTokenSealed handler (relay → daemon relay.push.token) is active.
    const registrations: Array<{
      frontendId: string;
      daemonId: string;
      token: string;
      platform: string;
    }> = [];
    const fakePushNotifier = {
      registerSealedToken: (
        frontendId: string,
        daemonId: string,
        token: string,
        platform: string,
      ) => {
        registrations.push({ frontendId, daemonId, token, platform });
      },
      handleUnsealFailed: () => {},
      handleTokenDead: () => {},
    };
    const deps = makeDeps();
    (
      deps as unknown as {
        pushNotifier: typeof fakePushNotifier;
      }
    ).pushNotifier = fakePushNotifier;

    const mgr = new RelayConnectionManager(deps);
    const stub = makeStubClient("d1");

    const events = mgr.buildEvents(() => stub, undefined, "daemon-abc");
    events.onPushTokenSealed?.("frontend-2", "tpps1.v1.sealed-blob", "android");

    expect(registrations).toEqual([
      {
        frontendId: "frontend-2",
        daemonId: "daemon-abc",
        token: "tpps1.v1.sealed-blob",
        platform: "android",
      },
    ]);
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

  describe("buildEvents.onInput → runner", () => {
    // Captures the IPC `input` frame's raw `data` field forwarded to the runner.
    function captureRawInput(kind: "chat" | "term", data: string) {
      const sends: Array<{ runner: unknown; msg: { data: string } }> = [];
      const deps = makeDeps({
        findRunnerBySid: () => ({ __runner: true }),
        send: (runner, msg) =>
          sends.push({ runner, msg: msg as { data: string } }),
      });
      const mgr = new RelayConnectionManager(deps);
      const events = mgr.buildEvents(() => makeStubClient("d1"));
      events.onInput?.(kind, "sess-1", data);
      return sends[0]?.msg.data ?? "";
    }

    test("chat input is base64-encoded with a trailing carriage return (\\r), not a newline", () => {
      // The interactive claude TUI submits a prompt only on `\r` (Enter); a
      // trailing `\n` leaves the text un-submitted in the input box. The chat
      // branch base64-encodes `${data}\r`. Regression guard for the real-claude
      // M5 round-trip (TP_INPUT_OK).
      const frame = captureRawInput("chat", "hello world");
      const decoded = Buffer.from(frame, "base64").toString("utf8");
      expect(decoded).toBe("hello world\r");
      expect(decoded.endsWith("\n")).toBe(false);
    });

    test("terminal input passes the (already-base64) data through verbatim", () => {
      // Terminal keystrokes arrive already base64-encoded on the wire; the
      // `term` branch forwards the string unchanged (no re-encode, no
      // appended terminator).
      const wireData = Buffer.from("ls -la\r").toString("base64");
      const frame = captureRawInput("term", wireData);
      expect(frame).toBe(wireData);
    });

    test("onInput NACKs the originating frontend with NO_RUNNER when no runner owns the sid", () => {
      // A dead-runner input must not be silently dropped — the frontend would
      // otherwise believe the keystroke/prompt landed. Mirrors session.stop's
      // NO_RUNNER reply on the identical no-runner condition.
      const sends: unknown[] = [];
      const deps = makeDeps({
        findRunnerBySid: () => undefined,
        send: (...args) => sends.push(args),
      });
      const mgr = new RelayConnectionManager(deps);
      const stub = makeStubClient("d1");
      const events = mgr.buildEvents(() => stub);
      events.onInput?.("chat", "ghost-sid", "hi", "front-1");
      expect(sends).toHaveLength(0);
      expect(stub.publishToPeer).toHaveBeenCalledWith("front-1", "ghost-sid", {
        t: "err",
        e: "NO_RUNNER",
        m: "No runner for session ghost-sid",
      });
    });

    test("onInput stays a no-op when no runner owns the sid AND frontendId is absent (defensive — real relay path always supplies it)", () => {
      const sends: unknown[] = [];
      const deps = makeDeps({
        findRunnerBySid: () => undefined,
        send: (...args) => sends.push(args),
      });
      const mgr = new RelayConnectionManager(deps);
      const stub = makeStubClient("d1");
      const events = mgr.buildEvents(() => stub);
      events.onInput?.("chat", "ghost-sid", "hi");
      expect(sends).toHaveLength(0);
      expect(stub.publishToPeer).not.toHaveBeenCalled();
    });
  });
});
