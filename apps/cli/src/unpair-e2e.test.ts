// TODO: extract a shared mock-relay + paired-client harness with multi-frontend.test.ts
// to reduce duplication. Not load-bearing for this feature.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import {
  CONTROL_UNPAIR,
  createPairingBundle,
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  generateKeyPair,
  RELAY_CHANNEL_CONTROL,
  type RelayServerMessage,
  toBase64,
} from "@teleprompter/protocol";
import { rmRetry } from "@teleprompter/protocol/test-utils";
import { RelayServer } from "@teleprompter/relay";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * E2E test for the unpair notification round-trip.
 * - Test A: daemon-initiated removePairing notifies the frontend with a
 *   control.unpair frame on RELAY_CHANNEL_CONTROL.
 * - Test B: a frontend-sent control.unpair frame causes the daemon to
 *   tear down the relay client and delete the persisted pairing.
 */
describe("Unpair Notification E2E", () => {
  let relay: RelayServer;
  let daemon: Daemon;
  let relayPort: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-unpair-"));
    SessionManager.setRunnerCommand(["true"]);

    relay = new RelayServer();
    relayPort = relay.start(0);

    daemon = new Daemon(tmpDir);
    daemon.start(join(tmpDir, "daemon.sock"));
  });

  afterEach(async () => {
    daemon.stop();
    relay.stop();
    await rmRetry(tmpDir);
  });

  test("daemon.removePairing notifies frontend via control.unpair", async () => {
    const daemonId = "unpair-daemon-A";
    const frontendId = "unpair-frontend-A";

    const bundle = await createPairingBundle(
      `ws://localhost:${relayPort}`,
      daemonId,
    );

    await daemon.connectRelay({
      relayUrl: `ws://localhost:${relayPort}`,
      daemonId,
      token: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      keyPair: bundle.keyPair,
      pairingSecret: bundle.pairingSecret,
    });
    await Bun.sleep(300);

    const frontendKp = await generateKeyPair();
    const kxKey = await deriveKxKey(bundle.pairingSecret);

    const ws = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId,
        token: bundle.relayToken,
        frontendId,
      }),
    );
    await waitMsg(ws, (m) => m.t === "relay.auth.ok");

    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    ws.send(
      JSON.stringify({
        t: "relay.kx",
        ct: await encrypt(new TextEncoder().encode(kxPayload), kxKey),
        role: "frontend",
      }),
    );
    await Bun.sleep(300);

    ws.send(JSON.stringify({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL }));
    await Bun.sleep(100);

    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      bundle.keyPair.publicKey,
      "frontend",
    );

    const framePromise = waitMsg(
      ws,
      (m) =>
        m.t === "relay.frame" &&
        (m as { sid?: string }).sid === RELAY_CHANNEL_CONTROL,
    );

    await daemon.removePairing(daemonId, { notifyPeer: true });

    const frame = (await framePromise) as unknown as { ct: string };
    const pt = await decrypt(frame.ct, frontendKeys.rx);
    const msg = JSON.parse(new TextDecoder().decode(pt));

    expect(msg.t).toBe(CONTROL_UNPAIR);
    expect(msg.daemonId).toBe(daemonId);
    expect(msg.frontendId).toBe(frontendId);
    expect(msg.reason).toBe("user-initiated");
    expect(typeof msg.ts).toBe("number");

    // Daemon-side state: pairing removed from store, relay client disposed.
    const store = (
      daemon as unknown as { store: { loadPairings(): unknown[] } }
    ).store;
    expect(store.loadPairings().length).toBe(0);
    const relayClients = (daemon as unknown as { relayClients: unknown[] })
      .relayClients;
    expect(relayClients.length).toBe(0);

    ws.close();
  });

  test("frontend-initiated control.unpair makes daemon remove pairing", async () => {
    const daemonId = "unpair-daemon-B";
    const frontendId = "unpair-frontend-B";

    const bundle = await createPairingBundle(
      `ws://localhost:${relayPort}`,
      daemonId,
    );

    await daemon.connectRelay({
      relayUrl: `ws://localhost:${relayPort}`,
      daemonId,
      token: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      keyPair: bundle.keyPair,
      pairingSecret: bundle.pairingSecret,
    });
    await Bun.sleep(300);

    const frontendKp = await generateKeyPair();
    const kxKey = await deriveKxKey(bundle.pairingSecret);

    const ws = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId,
        token: bundle.relayToken,
        frontendId,
      }),
    );
    await waitMsg(ws, (m) => m.t === "relay.auth.ok");

    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    ws.send(
      JSON.stringify({
        t: "relay.kx",
        ct: await encrypt(new TextEncoder().encode(kxPayload), kxKey),
        role: "frontend",
      }),
    );
    await Bun.sleep(300);

    ws.send(JSON.stringify({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL }));
    await Bun.sleep(100);

    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      bundle.keyPair.publicKey,
      "frontend",
    );

    const unpairMsg = {
      t: CONTROL_UNPAIR,
      daemonId,
      frontendId,
      reason: "user-initiated" as const,
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(unpairMsg)),
      frontendKeys.tx,
    );
    ws.send(
      JSON.stringify({
        t: "relay.pub",
        sid: RELAY_CHANNEL_CONTROL,
        ct,
        seq: 1,
      }),
    );

    // Poll for daemon state until removed (or timeout).
    const store = (
      daemon as unknown as { store: { loadPairings(): unknown[] } }
    ).store;
    const relayClients = (daemon as unknown as { relayClients: unknown[] })
      .relayClients;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (store.loadPairings().length === 0 && relayClients.length === 0) break;
      await Bun.sleep(50);
    }

    expect(store.loadPairings().length).toBe(0);
    expect(relayClients.length).toBe(0);

    ws.close();
  });
});

function waitMsg(
  ws: WebSocket,
  pred: (m: RelayServerMessage) => boolean,
): Promise<RelayServerMessage> {
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (pred(msg)) {
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("waitMsg timeout"));
    }, 5000);
  });
}
