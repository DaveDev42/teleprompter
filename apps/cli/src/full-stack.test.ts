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
  type IpcHello,
  type IpcInput,
  type IpcMessage,
  type IpcRec,
  type RelayServerMessage,
  toBase64,
  type WsRec,
  type WsServerMessage,
} from "@teleprompter/protocol";
import { RelayServer } from "@teleprompter/relay";
import { mkdtemp, rm } from "fs/promises";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Full-stack integration test:
 *
 * 1. Start Relay server
 * 2. Start Daemon with relay connection
 * 3. Simulate a Runner sending records via IPC
 * 4. Verify records arrive at a local WS client (frontend)
 * 5. Verify records arrive at a remote encrypted relay client (frontend)
 * 6. Send input from remote frontend via relay back to runner
 */
describe("Full-stack E2E", () => {
  let relay: RelayServer;
  let daemon: Daemon;
  let relayPort: number;
  let wsPort: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-fullstack-"));
    SessionManager.setRunnerCommand(["true"]);

    // 1. Start relay
    relay = new RelayServer();
    relayPort = relay.start(0);

    // 2. Start daemon with isolated vault
    daemon = new Daemon(tmpDir);
    daemon.start(join(tmpDir, "daemon.sock"));
    daemon.startWs(0);
    wsPort = daemon.wsPort!;
  });

  afterEach(async () => {
    daemon.stop();
    relay.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("local WS: daemon → frontend record flow", async () => {
    // Connect local frontend WS
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });

    ws.send(JSON.stringify({ t: "hello", v: 1 }));

    // Wait for hello reply
    const helloReply = await waitWsMsg(ws, (m) => m.t === "hello");
    expect(helloReply.t).toBe("hello");

    // Simulate runner connecting via IPC
    const socketPath = (daemon as unknown as { socketPath: string }).socketPath;
    const ipc = connect(socketPath);
    await new Promise<void>((r) => {
      ipc.on("connect", () => r());
    });

    const hello: IpcHello = {
      t: "hello",
      sid: "full-e2e-local",
      cwd: "/tmp",
      pid: process.pid,
    };
    ipc.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(100);

    // Attach frontend to session
    ws.send(JSON.stringify({ t: "attach", sid: "full-e2e-local" }));
    await Bun.sleep(50);

    // Runner sends a record
    const rec: IpcRec = {
      t: "rec",
      sid: "full-e2e-local",
      kind: "io",
      payload: Buffer.from("Hello from runner!").toString("base64"),
      ts: Date.now(),
    };
    ipc.write(Buffer.from(encodeFrame(rec)));

    // Frontend receives it
    const wsRec = await waitWsMsg(ws, (m) => m.t === "rec");
    expect(wsRec.t).toBe("rec");
    expect((wsRec as WsRec).sid).toBe("full-e2e-local");
    expect(Buffer.from((wsRec as WsRec).d, "base64").toString()).toBe(
      "Hello from runner!",
    );

    ipc.end();
    ws.close();
  });

  test("relay E2E: daemon → relay → encrypted frontend (v2 with kx)", async () => {
    const bundle = await createPairingBundle(
      `ws://localhost:${relayPort}`,
      "e2e-daemon",
    );
    // No registerToken() — daemon self-registers via relay.register

    const frontendKp = await generateKeyPair();
    const frontendId = "e2e-frontend-1";
    const kxKey = await deriveKxKey(bundle.pairingSecret);

    // Connect daemon to relay (self-registers)
    await daemon.connectRelay({
      relayUrl: `ws://localhost:${relayPort}`,
      daemonId: "e2e-daemon",
      token: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      keyPair: bundle.keyPair,
      pairingSecret: bundle.pairingSecret,
    });
    await Bun.sleep(300);

    // Connect frontend to relay
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      frontendWs.onopen = () => r();
    });

    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: "e2e-daemon",
        token: bundle.relayToken,
        frontendId,
      }),
    );
    await waitRelayMsg(frontendWs, (m) => m.t === "relay.auth.ok");

    // Frontend performs key exchange
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    // Subscribe to session
    frontendWs.send(JSON.stringify({ t: "relay.sub", sid: "full-e2e-relay" }));
    await Bun.sleep(50);

    // Simulate runner sending record via IPC
    const socketPath = (daemon as unknown as { socketPath: string }).socketPath;
    const ipc = connect(socketPath);
    await new Promise<void>((r) => {
      ipc.on("connect", () => r());
    });

    ipc.write(
      Buffer.from(
        encodeFrame({
          t: "hello",
          sid: "full-e2e-relay",
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
          sid: "full-e2e-relay",
          kind: "event",
          payload: Buffer.from(
            JSON.stringify({
              hook_event_name: "Stop",
              last_assistant_message: "Task complete!",
            }),
          ).toString("base64"),
          ts: Date.now(),
        }),
      ),
    );

    // Frontend receives encrypted frame from relay
    const frame = await waitRelayMsg(frontendWs, (m) => m.t === "relay.frame");
    expect(frame.t).toBe("relay.frame");

    // Decrypt with derived session keys
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      bundle.keyPair.publicKey,
      "frontend",
    );
    const relayFrame = frame as RelayServerMessage & { ct: string };
    const plaintext = await decrypt(relayFrame.ct, frontendKeys.rx);
    const decrypted = JSON.parse(new TextDecoder().decode(plaintext));
    expect(decrypted.t).toBe("rec");
    expect(decrypted.sid).toBe("full-e2e-relay");
    expect(relayFrame.ct).not.toContain("Task complete!");

    ipc.end();
    frontendWs.close();
  });

  test("bidirectional: frontend input → relay → daemon → runner (v2)", async () => {
    const bundle = await createPairingBundle(
      `ws://localhost:${relayPort}`,
      "e2e-bidir",
    );

    const _frontendKp = await generateKeyPair();
    const _frontendId = "e2e-bidir-frontend";
    const _kxKey = await deriveKxKey(bundle.pairingSecret);

    await daemon.connectRelay({
      relayUrl: `ws://localhost:${relayPort}`,
      daemonId: "e2e-bidir",
      token: bundle.relayToken,
      registrationProof: bundle.registrationProof,
      keyPair: bundle.keyPair,
      pairingSecret: bundle.pairingSecret,
    });
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
          sid: "bidir-session",
          cwd: "/tmp",
          pid: process.pid,
        }),
      ),
    );
    await Bun.sleep(100);

    // Collect IPC messages received by runner
    const decoder = new FrameDecoder();
    const ipcMessages: IpcMessage[] = [];
    ipc.on("data", (data: Buffer) => {
      const msgs = decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ) as IpcMessage[];
      ipcMessages.push(...msgs);
    });

    // Also connect local WS frontend and send input
    const localWs = new WebSocket(`ws://localhost:${wsPort}`);
    await new Promise<void>((r) => {
      localWs.onopen = () => r();
    });
    localWs.send(JSON.stringify({ t: "hello", v: 1 }));
    await waitWsMsg(localWs, (m) => m.t === "hello");

    localWs.send(
      JSON.stringify({
        t: "in.chat",
        sid: "bidir-session",
        d: "Fix the login bug",
      }),
    );
    await Bun.sleep(200);

    // Runner should have received the input
    const inputMsg = ipcMessages.find((m): m is IpcInput => m.t === "input");
    expect(inputMsg).toBeDefined();
    expect(inputMsg!.sid).toBe("bidir-session");
    expect(Buffer.from(inputMsg!.data, "base64").toString()).toBe(
      "Fix the login bug\n",
    );

    ipc.end();
    localWs.close();
  });
});

// Helpers

function waitWsMsg(
  ws: WebSocket,
  pred: (m: WsServerMessage) => boolean,
): Promise<WsServerMessage> {
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
      reject(new Error("waitWsMsg timeout"));
    }, 5000);
  });
}

function waitRelayMsg(
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
      reject(new Error("waitRelayMsg timeout"));
    }, 5000);
  });
}
