/**
 * Unit tests for pairing-store.
 *
 * Covers:
 *  - serialize / deserialize roundtrip (v3 format)
 *  - v2 -> v3 migration (adds nullable `label` field)
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
  toBase64,
} from "@teleprompter/protocol/client";

// Dynamic import — evaluated AFTER mocks are registered.
const { registerRenameSender, registerUnpairSender, usePairingStore } =
  await import("./pairing-store");

// Storage keys (mirrored from the store — not exported).
const STORAGE_KEY = "pairings_v3";
const PREVIOUS_STORAGE_KEY = "pairings_v2";
const WEB_PREFIX = "tp_";

function storageGet(key: string): string | null {
  return fakeStorage.get(WEB_PREFIX + key) ?? null;
}

function storageSet(key: string, value: string) {
  fakeStorage.set(WEB_PREFIX + key, value);
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
    const qr = await buildFakePairing("daemon-a", { label: "Alpha" });
    await usePairingStore.getState().processScan(qr);

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
    const qr1 = await buildFakePairing("daemon-1", { label: "One" });
    const qr2 = await buildFakePairing("daemon-2", { label: "Two" });

    await usePairingStore.getState().processScan(qr1);
    await usePairingStore.getState().processScan(qr2);

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

describe("pairing-store: v2 → v3 migration", () => {
  beforeEach(resetStore);

  test("migrates v2 entries without label field to v3 with label=null", async () => {
    // Build a realistic v2 entry: same shape as v3 SerializedPairingInfo
    // minus the `label` field. We generate real crypto material so
    // deserialize() won't trip on base64 parsing.
    const bundle = await createPairingBundle(
      "wss://relay.example.com",
      "legacy-daemon",
    );
    const frontendKp = {
      publicKey: new Uint8Array(32).fill(7),
      secretKey: new Uint8Array(32).fill(9),
    };
    const v2Entry = {
      daemonId: "legacy-daemon",
      relayUrl: "wss://relay.example.com",
      relayToken: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      daemonPublicKey: await toBase64(bundle.keyPair.publicKey),
      frontendPublicKey: await toBase64(frontendKp.publicKey),
      frontendSecretKey: await toBase64(frontendKp.secretKey),
      frontendId: "legacy-frontend-id",
      pairingSecret: await toBase64(bundle.pairingSecret),
      pairedAt: 1234567890,
      // no `label` field at all
    };
    storageSet(PREVIOUS_STORAGE_KEY, JSON.stringify([v2Entry]));

    // v3 slot is empty, so migration branch runs.
    expect(storageGet(STORAGE_KEY)).toBeNull();

    await usePairingStore.getState().load();

    const state = usePairingStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.state).toBe("paired");
    expect(state.pairings.size).toBe(1);

    const migrated = state.pairings.get("legacy-daemon");
    if (!migrated) throw new Error("migrated pairing not found");
    expect(migrated.label).toBeNull();
    expect(migrated.frontendId).toBe("legacy-frontend-id");
    expect(migrated.pairedAt).toBe(1234567890);
    // Uint8Array fields re-hydrated
    expect(migrated.daemonPublicKey).toBeInstanceOf(Uint8Array);
    expect(migrated.daemonPublicKey.length).toBe(32);
    expect(Array.from(migrated.frontendKeyPair.publicKey)).toEqual(
      Array.from(frontendKp.publicKey),
    );

    // v3 slot is now populated, v2 slot cleared.
    expect(storageGet(STORAGE_KEY)).not.toBeNull();
    expect(storageGet(STORAGE_KEY)).not.toBe("");
    expect(storageGet(PREVIOUS_STORAGE_KEY)).toBe("");
  });

  test("v2 migration preserves existing label if present", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.example.com",
      "labeled-daemon",
    );
    const frontendKp = {
      publicKey: new Uint8Array(32).fill(1),
      secretKey: new Uint8Array(32).fill(2),
    };
    const v2Entry = {
      daemonId: "labeled-daemon",
      relayUrl: "wss://relay.example.com",
      relayToken: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      daemonPublicKey: await toBase64(bundle.keyPair.publicKey),
      frontendPublicKey: await toBase64(frontendKp.publicKey),
      frontendSecretKey: await toBase64(frontendKp.secretKey),
      frontendId: "fid",
      pairingSecret: await toBase64(bundle.pairingSecret),
      pairedAt: 1,
      label: "KeepMe",
    };
    storageSet(PREVIOUS_STORAGE_KEY, JSON.stringify([v2Entry]));

    await usePairingStore.getState().load();
    expect(
      usePairingStore.getState().pairings.get("labeled-daemon")?.label,
    ).toBe("KeepMe");
  });

  test("malformed v2 data is discarded silently and store still loads", async () => {
    storageSet(PREVIOUS_STORAGE_KEY, "{{not json");
    await usePairingStore.getState().load();
    const s = usePairingStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.pairings.size).toBe(0);
    expect(s.state).toBe("unpaired");
  });

  test("no migration runs if v3 already has data", async () => {
    const qr = await buildFakePairing("d1");
    await usePairingStore.getState().processScan(qr);
    const v3Snapshot = storageGet(STORAGE_KEY);
    expect(v3Snapshot).not.toBeNull();

    storageSet(PREVIOUS_STORAGE_KEY, '[{"bogus":true}]');

    usePairingStore.setState({
      pairings: new Map(),
      activeDaemonId: null,
      state: "unpaired",
      loaded: false,
    });
    await usePairingStore.getState().load();

    // Migration should not have run — v2 slot untouched.
    expect(storageGet(PREVIOUS_STORAGE_KEY)).toBe('[{"bogus":true}]');
    expect(usePairingStore.getState().pairings.size).toBe(1);
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

  test("processScan uses QR label when provided", async () => {
    const qr = await buildFakePairing("d1", { label: "Custom" });
    await usePairingStore.getState().processScan(qr);
    expect(usePairingStore.getState().pairings.get("d1")?.label).toBe("Custom");
  });

  test("processScan falls back to Device.deviceName when QR has no label", async () => {
    const qr = await buildFakePairing("d2");
    await usePairingStore.getState().processScan(qr);
    // mocked expo-device.deviceName is "TestDevice"
    expect(usePairingStore.getState().pairings.get("d2")?.label).toBe(
      "TestDevice",
    );
  });

  test("processScan with bogus QR data sets error and stays unpaired", async () => {
    await usePairingStore.getState().processScan("{{not json");
    const s = usePairingStore.getState();
    expect(s.state).toBe("unpaired");
    expect(s.error).toBeTruthy();
  });

  test("removePairing deletes entry and re-routes activeDaemonId", async () => {
    const qr1 = await buildFakePairing("d1");
    const qr2 = await buildFakePairing("d2");
    await usePairingStore.getState().processScan(qr1);
    await usePairingStore.getState().processScan(qr2);

    usePairingStore.getState().setActiveDaemon("d2");
    await usePairingStore.getState().removePairing("d2");

    const s = usePairingStore.getState();
    expect(s.pairings.size).toBe(1);
    expect(s.pairings.has("d1")).toBe(true);
    expect(s.activeDaemonId).toBe("d1");
    expect(s.state).toBe("paired");
  });

  test("removePairing of last pairing transitions to 'unpaired'", async () => {
    const qr = await buildFakePairing("solo");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().removePairing("solo");

    const s = usePairingStore.getState();
    expect(s.pairings.size).toBe(0);
    expect(s.state).toBe("unpaired");
    expect(s.activeDaemonId).toBeNull();
  });

  test("reset clears storage and state", async () => {
    const qr = await buildFakePairing("d1");
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
    const qr = await buildFakePairing("d1");
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async (_daemonId: string) => {});
    registerUnpairSender(sender);

    await usePairingStore.getState().removePairing("d1");

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toBe("d1");
  });

  test("removePairing swallows sender errors (best-effort notify)", async () => {
    const qr = await buildFakePairing("d1");
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async () => {
      throw new Error("network down");
    });
    registerUnpairSender(sender);

    // Must not throw — best-effort notify.
    await usePairingStore.getState().removePairing("d1");
    expect(usePairingStore.getState().pairings.has("d1")).toBe(false);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("renamePairing updates label and notifies peer", async () => {
    const qr = await buildFakePairing("d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async (_id: string, _label: string) => {});
    registerRenameSender(sender);

    await usePairingStore.getState().renamePairing("d1", "  New Label  ");

    expect(usePairingStore.getState().pairings.get("d1")?.label).toBe(
      "New Label",
    );
    expect(sender).toHaveBeenCalledTimes(1);
    // Trimmed value is sent over the wire.
    expect(sender.mock.calls[0][1]).toBe("New Label");
  });

  test("renamePairing with empty string clears label locally and sends empty string", async () => {
    const qr = await buildFakePairing("d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async () => {});
    registerRenameSender(sender);

    await usePairingStore.getState().renamePairing("d1", "   ");

    expect(usePairingStore.getState().pairings.get("d1")?.label).toBeNull();
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
    const qr = await buildFakePairing("d1");
    await usePairingStore.getState().processScan(qr);

    await usePairingStore.getState().handlePeerUnpair("d1", "user-initiated");

    const s = usePairingStore.getState();
    expect(s.pairings.has("d1")).toBe(false);
    expect(s.state).toBe("unpaired");
    expect(s.lastPeerUnpair?.daemonId).toBe("d1");
    expect(s.lastPeerUnpair?.reason).toBe("user-initiated");
    expect(typeof s.lastPeerUnpair?.ts).toBe("number");
  });

  test("clearLastPeerUnpair resets the notice", async () => {
    const qr = await buildFakePairing("d1");
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().handlePeerUnpair("d1", "rotated");

    usePairingStore.getState().clearLastPeerUnpair();
    expect(usePairingStore.getState().lastPeerUnpair).toBeNull();
  });

  test("handlePeerRename updates label without triggering sender", async () => {
    const qr = await buildFakePairing("d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);

    const sender = mock(async () => {});
    registerRenameSender(sender);

    await usePairingStore.getState().handlePeerRename("d1", "  Peer Name  ");

    expect(usePairingStore.getState().pairings.get("d1")?.label).toBe(
      "Peer Name",
    );
    // Receive-only: no echo to wire.
    expect(sender).not.toHaveBeenCalled();
  });

  test("handlePeerRename with empty label clears to null", async () => {
    const qr = await buildFakePairing("d1", { label: "Old" });
    await usePairingStore.getState().processScan(qr);
    await usePairingStore.getState().handlePeerRename("d1", "");
    expect(usePairingStore.getState().pairings.get("d1")?.label).toBeNull();
  });

  test("handlePeerRename ignores unknown daemonId", async () => {
    await usePairingStore.getState().handlePeerRename("ghost", "X");
    expect(usePairingStore.getState().pairings.size).toBe(0);
  });
});
