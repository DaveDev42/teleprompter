import { describe, test, expect } from "bun:test";
import { Daemon, SessionManager } from "./lib";
import {
  encodeFrame,
  FrameDecoder,
  type IpcHello,
  type IpcRec,
  type WsServerMessage,
} from "@teleprompter/protocol";
import { connect } from "net";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("Performance", () => {
  test("throughput: 1000 records via IPC → WS in <5s", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tp-bench-"));
    SessionManager.setRunnerCommand(["true"]);

    const daemon = new Daemon(tmpDir);
    daemon.start(join(tmpDir, "daemon.sock"));
    daemon.startWs(0);
    const wsPort = daemon.wsPort;

    // Connect WS client
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.send(JSON.stringify({ t: "hello" }));

    const wsMessages: WsServerMessage[] = [];
    ws.onmessage = (e) => {
      wsMessages.push(JSON.parse(e.data as string));
    };

    // Wait for hello reply
    await Bun.sleep(50);

    // Connect IPC runner
    const socketPath = join(tmpDir, "daemon.sock");
    const ipc = connect(socketPath);
    await new Promise<void>((r) => { ipc.on("connect", () => r()); });

    // Send hello
    const hello: IpcHello = { t: "hello", sid: "bench-session", cwd: "/tmp", pid: process.pid };
    ipc.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);

    // Attach WS to session
    ws.send(JSON.stringify({ t: "attach", sid: "bench-session" }));
    await Bun.sleep(50);

    // Blast 1000 records
    const start = Date.now();
    const COUNT = 1000;
    const payload = Buffer.from("x".repeat(1024)).toString("base64"); // 1KB per record

    for (let i = 0; i < COUNT; i++) {
      const rec: IpcRec = {
        t: "rec",
        sid: "bench-session",
        kind: "io",
        payload,
        ts: Date.now(),
      };
      ipc.write(Buffer.from(encodeFrame(rec)));
    }

    // Wait for all to arrive at WS
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const recCount = wsMessages.filter((m) => m.t === "rec").length;
      if (recCount >= COUNT) break;
      await Bun.sleep(10);
    }

    const elapsed = Date.now() - start;
    const recCount = wsMessages.filter((m) => m.t === "rec").length;

    console.log(`[Bench] ${recCount}/${COUNT} records in ${elapsed}ms (${Math.round(recCount / (elapsed / 1000))} rec/s)`);

    expect(recCount).toBe(COUNT);
    expect(elapsed).toBeLessThan(5000);

    ipc.end();
    ws.close();
    daemon.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("throughput: codec encode/decode 10000 frames in <1s", () => {
    const { encodeFrame: encode, FrameDecoder: Decoder } = require("@teleprompter/protocol");
    const decoder = new Decoder();

    const data = { t: "rec", sid: "bench", seq: 0, k: "io", d: "x".repeat(512), ts: 0 };
    const COUNT = 10000;

    const start = Date.now();
    for (let i = 0; i < COUNT; i++) {
      data.seq = i;
      const frame = encode(data);
      decoder.decode(frame);
    }
    const elapsed = Date.now() - start;

    console.log(`[Bench] codec: ${COUNT} frames in ${elapsed}ms (${Math.round(COUNT / (elapsed / 1000))} frames/s)`);
    expect(elapsed).toBeLessThan(1000);
  });

  test("throughput: crypto encrypt/decrypt 1000 messages in <2s", async () => {
    const { generateKeyPair, deriveSessionKeys, encrypt, decrypt } = require("@teleprompter/protocol");

    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const keys = await deriveSessionKeys(kp1, kp2.publicKey, "daemon");

    const plaintext = new TextEncoder().encode('{"t":"rec","d":"' + "x".repeat(256) + '"}');
    const COUNT = 1000;

    const start = Date.now();
    for (let i = 0; i < COUNT; i++) {
      const ct = await encrypt(plaintext, keys.tx);
      await decrypt(ct, keys.tx);
    }
    const elapsed = Date.now() - start;

    console.log(`[Bench] crypto: ${COUNT} encrypt+decrypt in ${elapsed}ms (${Math.round(COUNT / (elapsed / 1000))} ops/s)`);
    expect(elapsed).toBeLessThan(2000);
  });
});
