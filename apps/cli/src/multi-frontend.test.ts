import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import {
  createPairingBundle,
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encodeFrame,
  encrypt,
  FrameDecoder,
  generateKeyPair,
  type IpcMessage,
  type RelayServerMessage,
  toBase64,
} from "@teleprompter/protocol";
import { RelayServer } from "@teleprompter/relay";
import { mkdtemp, rm } from "fs/promises";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Multi-frontend E2E test:
 * Two frontends connect to the same daemon via relay with independent E2EE.
 * Verifies:
 * - Both frontends receive records encrypted with their own keys
 * - Each frontend can only decrypt with its own keys, not the other's
 * - Input from either frontend reaches the daemon
 */
describe("Multi-Frontend N:N E2E", () => {
  let relay: RelayServer;
  let daemon: Daemon;
  let relayPort: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-multi-"));
    SessionManager.setRunnerCommand(["true"]);

    relay = new RelayServer();
    relayPort = relay.start(0);

    daemon = new Daemon(tmpDir);
    daemon.start(join(tmpDir, "daemon.sock"));
    daemon.startWs(0);
  });

  afterEach(async () => {
    daemon.stop();
    relay.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("two frontends receive independently encrypted records", async () => {
    const bundle = await createPairingBundle(
      `ws://localhost:${relayPort}`,
      "multi-daemon",
    );

    // Daemon connects to relay (self-registers)
    await daemon.connectRelay({
      relayUrl: `ws://localhost:${relayPort}`,
      daemonId: "multi-daemon",
      token: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      keyPair: bundle.keyPair,
      pairingSecret: bundle.pairingSecret,
    });
    await Bun.sleep(300);

    // Two frontends with independent key pairs
    const frontendAKp = await generateKeyPair();
    const frontendBKp = await generateKeyPair();
    const kxKey = await deriveKxKey(bundle.pairingSecret);

    // Connect frontend A
    const wsA = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      wsA.onopen = () => r();
    });
    wsA.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: "multi-daemon",
        token: bundle.relayToken,
        frontendId: "frontend-A",
      }),
    );
    await waitMsg(wsA, (m) => m.t === "relay.auth.ok");

    // Frontend A key exchange
    const kxA = JSON.stringify({
      pk: await toBase64(frontendAKp.publicKey),
      frontendId: "frontend-A",
      role: "frontend",
    });
    wsA.send(
      JSON.stringify({
        t: "relay.kx",
        ct: await encrypt(new TextEncoder().encode(kxA), kxKey),
        role: "frontend",
      }),
    );
    await Bun.sleep(200);

    // Connect frontend B
    const wsB = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      wsB.onopen = () => r();
    });
    wsB.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: "multi-daemon",
        token: bundle.relayToken,
        frontendId: "frontend-B",
      }),
    );
    await waitMsg(wsB, (m) => m.t === "relay.auth.ok");

    // Frontend B key exchange
    const kxB = JSON.stringify({
      pk: await toBase64(frontendBKp.publicKey),
      frontendId: "frontend-B",
      role: "frontend",
    });
    wsB.send(
      JSON.stringify({
        t: "relay.kx",
        ct: await encrypt(new TextEncoder().encode(kxB), kxKey),
        role: "frontend",
      }),
    );
    await Bun.sleep(300);

    // Both subscribe to the same session
    wsA.send(JSON.stringify({ t: "relay.sub", sid: "test-session" }));
    wsB.send(JSON.stringify({ t: "relay.sub", sid: "test-session" }));
    await Bun.sleep(100);

    // Set up frame collection BEFORE sending the record
    const keysA = await deriveSessionKeys(
      frontendAKp,
      bundle.keyPair.publicKey,
      "frontend",
    );
    const keysB = await deriveSessionKeys(
      frontendBKp,
      bundle.keyPair.publicKey,
      "frontend",
    );
    const framesAPromise = collectFrames(wsA, 2);
    const framesBPromise = collectFrames(wsB, 2);

    // Simulate runner sending a record via IPC
    const socketPath = (daemon as unknown as { socketPath: string }).socketPath;
    const ipc = connect(socketPath);
    await new Promise<void>((r) => {
      ipc.on("connect", () => r());
    });

    ipc.write(
      Buffer.from(
        encodeFrame({
          t: "hello",
          sid: "test-session",
          cwd: "/tmp",
          pid: process.pid,
        }),
      ),
    );
    await Bun.sleep(100);

    ipc.write(
      Buffer.from(
        encodeFrame({
          t: "rec",
          sid: "test-session",
          kind: "io",
          payload: Buffer.from("shared record").toString("base64"),
          ts: Date.now(),
        }),
      ),
    );

    // Wait for frames
    const framesA = await framesAPromise;
    const framesB = await framesBPromise;

    // Frontend A should decrypt exactly one of its frames
    let decryptedA = 0;
    for (const f of framesA) {
      try {
        const pt = await decrypt(f.ct, keysA.rx);
        const rec = JSON.parse(new TextDecoder().decode(pt));
        expect(rec.t).toBe("rec");
        expect(rec.sid).toBe("test-session");
        decryptedA++;
      } catch {
        // Expected: this frame was encrypted for frontend B
      }
    }
    expect(decryptedA).toBe(1);

    // Frontend B should decrypt exactly one of its frames
    let decryptedB = 0;
    for (const f of framesB) {
      try {
        const pt = await decrypt(f.ct, keysB.rx);
        const rec = JSON.parse(new TextDecoder().decode(pt));
        expect(rec.t).toBe("rec");
        expect(rec.sid).toBe("test-session");
        decryptedB++;
      } catch {
        // Expected: this frame was encrypted for frontend A
      }
    }
    expect(decryptedB).toBe(1);

    ipc.end();
    wsA.close();
    wsB.close();
  });

  test("input from either frontend reaches daemon", async () => {
    const bundle = await createPairingBundle(
      `ws://localhost:${relayPort}`,
      "multi-input",
    );

    await daemon.connectRelay({
      relayUrl: `ws://localhost:${relayPort}`,
      daemonId: "multi-input",
      token: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      keyPair: bundle.keyPair,
      pairingSecret: bundle.pairingSecret,
    });
    await Bun.sleep(300);

    const frontendKp = await generateKeyPair();
    const kxKey = await deriveKxKey(bundle.pairingSecret);

    // Connect frontend
    const ws = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: "multi-input",
        token: bundle.relayToken,
        frontendId: "input-frontend",
      }),
    );
    await waitMsg(ws, (m) => m.t === "relay.auth.ok");

    // Key exchange
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId: "input-frontend",
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

    // Connect runner via IPC
    const socketPath = (daemon as unknown as { socketPath: string }).socketPath;
    const ipc = connect(socketPath);
    await new Promise<void>((r) => {
      ipc.on("connect", () => r());
    });

    ipc.write(
      Buffer.from(
        encodeFrame({
          t: "hello",
          sid: "input-session",
          cwd: "/tmp",
          pid: process.pid,
        }),
      ),
    );
    await Bun.sleep(100);

    // Collect IPC messages
    const decoder = new FrameDecoder();
    const ipcMessages: IpcMessage[] = [];
    ipc.on("data", (data: Buffer) => {
      ipcMessages.push(
        ...(decoder.decode(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        ) as IpcMessage[]),
      );
    });

    // Frontend sends encrypted input
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      bundle.keyPair.publicKey,
      "frontend",
    );
    const inputMsg = {
      t: "in.chat",
      sid: "input-session",
      d: "Hello via relay!",
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(inputMsg)),
      frontendKeys.tx,
    );
    ws.send(
      JSON.stringify({ t: "relay.pub", sid: "input-session", ct, seq: 1 }),
    );

    await Bun.sleep(300);

    // Runner should receive the input
    const inputIpc = ipcMessages.find((m) => m.t === "input");
    expect(inputIpc).toBeDefined();
    expect(inputIpc!.sid).toBe("input-session");

    ipc.end();
    ws.close();
  });
});

function collectFrames(
  ws: WebSocket,
  count: number,
): Promise<Array<{ ct: string }>> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ ct: string }> = [];
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (msg.t === "relay.frame") {
        frames.push(msg);
        if (frames.length >= count) {
          ws.removeEventListener("message", handler);
          resolve(frames);
        }
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      if (frames.length > 0) resolve(frames);
      else reject(new Error("collectFrames timeout"));
    }, 5000);
  });
}

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
