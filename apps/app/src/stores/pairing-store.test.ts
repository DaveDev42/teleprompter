/**
 * Unit tests for pairing-store.
 *
 * Covers:
 *  - serialize / deserialize roundtrip (v3 format)
 *  - processScan / removePairing / reset state transitions
 *  - unpair & rename sender callback registration and invocation
 *  - handlePeerUnpair / handlePeerRename inbound control messages
 *
 * NOTE: We use dynamic imports for the store and secure-storage because
 * `pairing-store.ts` depends on `react-native` (Platform) transitively via
 * `secure-storage.ts`. Static imports are hoisted above `mock.module()`
 * calls, which would cause Bun to parse react-native's Flow-typed entry
 * point before the mock is in place.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must run before the store is dynamically imported) ──

mock.module("react-native", () => ({
  Platform: { OS: "web" },
}));

mock.module("expo-device", () => ({
  deviceName: "TestDevice",
}));

// In-memory localStorage shim for secure-storage.ts (web code path).
const fakeStorage = new Map<string, string>();
// biome-ignore lint/suspicious/noExplicitAny: test shim
(globalThis as any).localStorage = {
  getItem: (k: string) => fakeStorage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    fakeStorage.set(k, v);
  },
  removeItem: (k: string) => {
    fakeStorage.delete(k);
  },
  clear: () => {
    fakeStorage.clear();
  },
};

// Protocol helpers are safe to import statically (no RN/expo deps).
import {
  createPairingBundle,
  encodePairingData,
} from "@teleprompter/protocol/client";

// Dynamic import — evaluated AFTER mocks are registered.
const { registerRenameSender, registerUnpairSender, usePairingStore } =
  await import("./pairing-store");

// Storage keys (mirrored from the store — not exported).
const STORAGE_KEY = "pairings_v3";
const WEB_PREFIX = "tp_";

function storageGet(key: string): string | null {
  return fakeStorage.get(WEB_PREFIX + key) ?? null;
}

function resetStore() {
  fakeStorage.clear();
  usePairingStore.setState({
    state: "unpaired",
    pairings: new Map(),
    activeDaemonId: null,
    error: null,
    loaded: false,
    lastPeerUnpair: null,
  });
  registerUnpairSender(null);
  registerRenameSender(null);
}

async function buildFakePairing(
  daemonId: string,
  opts?: { label?: string },
): Promise<string> {
  const bundle = await createPairingBundle(
    "wss://relay.example.com",
    daemonId,
    { label: opts?.label },
  );
  return encodePairingData(bundle.qrData);
}

describe("pairing-store: serialize/deserialize", () => {
  beforeEach(resetStore);

  test("v3 roundtrip preserves all fields including label", async () => {
    // Label no longer travels in the QR — it's seeded from the device name
    // at scan time and upgraded later via handleDaemonHello. We exercise
    // both paths here: scan seeds the device name; a hello upgrades it; the
    // resulting label survives serialize/deserialize.
    const qr = await buildFakePairing("daemon-a");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().handleDaemonHello("daemon-a", "Alpha");

    const before = usePairingStore.getState().pairings.get("daemon-a");
    expect(before).toBeDefined();
    expect(before?.label).toBe("Alpha");

    // Reset in-memory state and reload from storage.
    usePairingStore.setState({
      pairings: new Map(),
      activeDaemonId: null,
      state: "unpaired",
      loaded: false,
    });
    await usePairingStore.getState().load();

    const after = usePairingStore.getState().pairings.get("daemon-a");
    if (!after || !before) throw new Error("pairing not found");
    expect(after.daemonId).toBe(before.daemonId);
    expect(after.relayUrl).toBe(before.relayUrl);
    expect(after.relayToken).toBe(before.relayToken);
    expect(after.registrationProof).toBe(before.registrationProof);
    expect(after.frontendId).toBe(before.frontendId);
    expect(after.label).toBe("Alpha");
    expect(after.labelSource).toBe("daemon");
    expect(after.pairedAt).toBe(before.pairedAt);
    // Uint8Array round-trip
    expect(Array.from(after.daemonPublicKey)).toEqual(
      Array.from(before.daemonPublicKey),
    );
    expect(Array.from(after.pairingSecret)).toEqual(
      Array.from(before.pairingSecret),
    );
    expect(Array.from(after.frontendKeyPair.publicKey)).toEqual(
      Array.from(before.frontendKeyPair.publicKey),
    );
    expect(Array.from(after.frontendKeyPair.secretKey)).toEqual(
      Array.from(before.frontendKeyPair.secretKey),
    );
  });

  test("handles multiple pairings and restores them all", async () => {
    const qr1 = await buildFakePairing("daemon-1");
    const qr2 = await buildFakePairing("daemon-2");

    await usePairingStore.getState().processScan(qr1);
    await usePairingStore.getState().processScan(qr2);
    // Simulate the daemon's relay.kx hello upgrading the seeded label.
    await usePairingStore.getState().handleDaemonHello("daemon-1", "One");
    await usePairingStore.getState().handleDaemonHello("daemon-2", "Two");

    expect(usePairingStore.getState().pairings.size).toBe(2);

    usePairingStore.setState({
      pairings: new Map(),
      activeDaemonId: null,
      state: "unpaired",
      loaded: false,
    });
    await usePairingStore.getState().load();

    const p = usePairingStore.getState().pairings;
    expect(p.size).toBe(2);
    expect(p.get("daemon-1")?.label).toBe("One");
    expect(p.get("daemon-2")?.label).toBe("Two");
  });
});

describe("pairing-store: state transitions", () => {
  beforeEach(resetStore);

  test("processScan adds pairing and switches state to 'paired'", async () => {
    expect(usePairingStore.getState().state).toBe("unpaired");

    const qr = await buildFakePairing("daemon-x", { label: "Box" });
    await usePairingStore.getState().processScan(qr);

    const s = usePairingStore.getState();
    expect(s.state).toBe("paired");
    expect(s.activeDaemonId).toBe("daemon-x");
    expect(s.pairings.size).toBe(1);
    expect(s.error).toBeNull();
  });

  test("processScan seeds label from Device.deviceName (QR carries no label)", async () => {
    const qr = await buildFakePairing("daemon-d2");
    await usePairingStore.getState().processScan(qr);
    // mocked expo-device.deviceName is "TestDevice"
    const info = usePairingStore.getState().pairings.get("daemon-d2");
    expect(info?.label).toBe("TestDevice");
    // Seed origin is `qr` so handleDaemonHello can later upgrade it.
    expect(info?.labelSource).toBe("qr");
  });

  test("processScan with bogus QR data sets error and stays unpaired", async () => {
    await usePairingStore.getState().processScan("{{not json");
    const s = usePairingStore.getState();
    expect(s.state).toBe("unpaired");
    expect(s.error).toBeTruthy();
  });

  test("removePairing deletes entry and re-routes activeDaemonId", async () => {
    const qr1 = await buildFakePairing("daemon-d1");
    const qr2 = await buildFakePairing("daemon-d2");
    await usePairingStore.getState().processScan(qr1);
    await usePairingStore.getState().processScan(qr2);

    usePairingStore.getState().setActiveDaemon("daemon-d2");
    await usePairingStore.getState().removePairing("daemon-d2");

    const s = usePairingStore.getState();
    expect(s.pairings.size).toBe(1);
    expect(s.pairings.has("daemon-d1")).toBe(true);
    expect(s.activeDaemonId).toBe("daemon-d1");
    expect(s.state).toBe("paired");
  });

  test("removePairing of last pairing transitions to 'unpaired'", async () => {
    const qr = await buildFakePairing("daemon-solo");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().removePairing("daemon-solo");

    const s = usePairingStore.getState();
    expect(s.pairings.size).toBe(0);
    expect(s.state).toBe("unpaired");
    expect(s.activeDaemonId).toBeNull();
  });

  test("reset clears storage and state", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().reset();

    const s = usePairingStore.getState();
    expect(s.pairings.size).toBe(0);
    expect(s.state).toBe("unpaired");
    expect(s.activeDaemonId).toBeNull();
    expect(s.lastPeerUnpair).toBeNull();
    // Storage slot cleared (set to empty string)
    expect(storageGet(STORAGE_KEY)).toBe("");
  });
});

describe("pairing-store: unpair/rename sender callbacks", () => {
  beforeEach(resetStore);

  test("removePairing invokes registered unpair sender", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async (_daemonId: string) => {});
    registerUnpairSender(sender);

    await usePairingStore.getState().removePairing("daemon-d1");

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toBe("daemon-d1");
  });

  test("removePairing swallows sender errors (best-effort notify)", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async () => {
      throw new Error("network down");
    });
    registerUnpairSender(sender);

    // Must not throw — best-effort notify.
    await usePairingStore.getState().removePairing("daemon-d1");
    expect(usePairingStore.getState().pairings.has("daemon-d1")).toBe(false);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("renamePairing updates label and notifies peer", async () => {
    const qr = await buildFakePairing("daemon-d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async (_id: string, _label: string) => {});
    registerRenameSender(sender);

    await usePairingStore.getState().renamePairing("daemon-d1", "  New Label  ");

    expect(usePairingStore.getState().pairings.get("daemon-d1")?.label).toBe(
      "New Label",
    );
    expect(sender).toHaveBeenCalledTimes(1);
    // Trimmed value is sent over the wire.
    expect(sender.mock.calls[0][1]).toBe("New Label");
  });

  test("renamePairing with empty string clears label locally and sends empty string", async () => {
    const qr = await buildFakePairing("daemon-d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async () => {});
    registerRenameSender(sender);

    await usePairingStore.getState().renamePairing("daemon-d1", "   ");

    expect(usePairingStore.getState().pairings.get("daemon-d1")?.label).toBeNull();
    expect(sender.mock.calls[0][1]).toBe("");
  });

  test("renamePairing is a no-op for unknown daemonId", async () => {
    const sender = mock(async () => {});
    registerRenameSender(sender);

    await usePairingStore.getState().renamePairing("ghost", "X");
    expect(sender).not.toHaveBeenCalled();
  });
});

describe("pairing-store: inbound control messages", () => {
  beforeEach(resetStore);

  test("handlePeerUnpair removes pairing and records lastPeerUnpair", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);

    await usePairingStore.getState().handlePeerUnpair("daemon-d1", "user-initiated");

    const s = usePairingStore.getState();
    expect(s.pairings.has("daemon-d1")).toBe(false);
    expect(s.state).toBe("unpaired");
    expect(s.lastPeerUnpair?.daemonId).toBe("daemon-d1");
    expect(s.lastPeerUnpair?.reason).toBe("user-initiated");
    expect(typeof s.lastPeerUnpair?.ts).toBe("number");
  });

  test("clearLastPeerUnpair resets the notice", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().handlePeerUnpair("daemon-d1", "rotated");

    usePairingStore.getState().clearLastPeerUnpair();
    expect(usePairingStore.getState().lastPeerUnpair).toBeNull();
  });

  test("handlePeerRename updates label without triggering sender", async () => {
    const qr = await buildFakePairing("daemon-d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async () => {});
    registerRenameSender(sender);

    await usePairingStore.getState().handlePeerRename("daemon-d1", "  Peer Name  ");

    expect(usePairingStore.getState().pairings.get("daemon-d1")?.label).toBe(
      "Peer Name",
    );
    // Receive-only: no echo to wire.
    expect(sender).not.toHaveBeenCalled();
  });

  test("handlePeerRename with empty label clears to null", async () => {
    const qr = await buildFakePairing("daemon-d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().handlePeerRename("daemon-d1", "");
    expect(usePairingStore.getState().pairings.get("daemon-d1")?.label).toBeNull();
  });

  test("handlePeerRename ignores unknown daemonId", async () => {
    await usePairingStore.getState().handlePeerRename("ghost", "X");
    expect(usePairingStore.getState().pairings.size).toBe(0);
  });

  test("handleDaemonHello adopts label and tags source as 'daemon'", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore
      .getState()
      .handleDaemonHello("daemon-d1", "MacBook Pro");
    const info = usePairingStore.getState().pairings.get("daemon-d1");
    expect(info?.label).toBe("MacBook Pro");
    expect(info?.labelSource).toBe("daemon");
  });

  test("handleDaemonHello with null label is a no-op", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);
    const before = usePairingStore.getState().pairings.get("daemon-d1")?.label;
    await usePairingStore.getState().handleDaemonHello("daemon-d1", null);
    expect(usePairingStore.getState().pairings.get("daemon-d1")?.label).toBe(
      before,
    );
  });

  test("handleDaemonHello with empty/whitespace label is a no-op", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);
    const before = usePairingStore.getState().pairings.get("daemon-d1")?.label;
    await usePairingStore.getState().handleDaemonHello("daemon-d1", "   ");
    expect(usePairingStore.getState().pairings.get("daemon-d1")?.label).toBe(
      before,
    );
  });

  test("handleDaemonHello for unknown daemonId is a no-op", async () => {
    await usePairingStore.getState().handleDaemonHello("ghost", "X");
    expect(usePairingStore.getState().pairings.size).toBe(0);
  });

  test("handleDaemonHello does not overwrite a user-renamed label", async () => {
    const qr = await buildFakePairing("daemon-d1");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().renamePairing("daemon-d1", "My Mac");
    expect(
      usePairingStore.getState().pairings.get("daemon-d1")?.labelSource,
    ).toBe("user");

    // Daemon broadcast arrives with a different label — must not clobber.
    await usePairingStore
      .getState()
      .handleDaemonHello("daemon-d1", "Old Daemon Label");
    const info = usePairingStore.getState().pairings.get("daemon-d1");
    expect(info?.label).toBe("My Mac");
    expect(info?.labelSource).toBe("user");
  });
});
