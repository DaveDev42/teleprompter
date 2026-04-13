// TODO: extract shared test harness with unpair-e2e.test.ts and multi-frontend.test.ts.
// Specifically, add Daemon test-only accessors (e.g., daemon.getRelayClientForTesting())
// instead of `as unknown as` casts here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import type { RelayClient } from "@teleprompter/daemon";
import {
  CONTROL_RENAME,
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
 * E2E test for the rename notification round-trip.
 * - Test A: daemon-side sendRenameNotice notifies the frontend with a
 *   control.rename frame on RELAY_CHANNEL_CONTROL containing the new label.
 * - Test B: a frontend-sent control.rename frame causes the daemon to
 *   update the persisted pairing label via store.updatePairingLabel.
 */
describe("Rename Notification E2E", () => {
  let relay: RelayServer;
  let daemon: Daemon;
  let relayPort: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-rename-"));
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

  test("daemon sendRenameNotice notifies frontend via control.rename", async () => {
    const daemonId = "rename-daemon-A";
    const frontendId = "rename-frontend-A";

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

    // Reach into the daemon to get the active relay client and call
    // sendRenameNotice directly (the public path is symmetric to unpair —
    // see daemon.removePairing → client.sendUnpairNotice).
    const relayClients = (daemon as unknown as { relayClients: RelayClient[] })
      .relayClients;
    const client = relayClients.find((c) => c.daemonId === daemonId);
    expect(client).toBeDefined();
    const newLabel = "MacBook Pro 14";
    const sent = await client!.sendRenameNotice(frontendId, newLabel);
    expect(sent).toBe(true);

    const frame = (await framePromise) as unknown as { ct: string };
    const pt = await decrypt(frame.ct, frontendKeys.rx);
    const msg = JSON.parse(new TextDecoder().decode(pt));

    expect(msg.t).toBe(CONTROL_RENAME);
    expect(msg.daemonId).toBe(daemonId);
    expect(msg.frontendId).toBe(frontendId);
    expect(msg.label).toBe(newLabel);
    expect(typeof msg.ts).toBe("number");

    ws.close();
  });

  test("frontend-initiated control.rename updates daemon store label", async () => {
    const daemonId = "rename-daemon-B";
    const frontendId = "rename-frontend-B";

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

    const newLabel = "Office iMac";
    const renameMsg = {
      t: CONTROL_RENAME,
      daemonId,
      frontendId,
      label: newLabel,
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(renameMsg)),
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

    // Poll for daemon store label update (or timeout).
    const store = (
      daemon as unknown as {
        store: { listPairings(): Array<{ daemonId: string; label: string | null }> };
      }
    ).store;
    const deadline = Date.now() + 2000;
    let observed: string | null = null;
    while (Date.now() < deadline) {
      const row = store.listPairings().find((p) => p.daemonId === daemonId);
      if (row?.label === newLabel) {
        observed = row.label;
        break;
      }
      await Bun.sleep(50);
    }

    expect(observed).toBe(newLabel);

    // Pairing should still be present (rename does not remove it).
    expect(daemon.getActivePairingIds()).toContain(daemonId);

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
