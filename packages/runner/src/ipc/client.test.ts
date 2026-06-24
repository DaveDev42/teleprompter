import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeFrame,
  type IpcAck,
  type IpcBye,
  type IpcHello,
  type IpcInput,
  type IpcMessage,
  type IpcRec,
  QueuedWriter,
} from "@teleprompter/protocol";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { IpcServer } from "../../../daemon/src/ipc/server";
import { IpcClient } from "./client";

describe("IpcClient", () => {
  let server: IpcServer;
  let client: IpcClient;
  let socketPath: string;
  let tmpDir: string;
  let serverMessages: IpcMessage[];
  let clientMessages: IpcMessage[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-ipc-client-"));
    socketPath = join(tmpDir, "test.sock");
    serverMessages = [];
    clientMessages = [];

    server = new IpcServer({
      onMessage: (_runner, msg) => serverMessages.push(msg),
      onConnect: () => {},
      onDisconnect: () => {},
    });
    server.start(socketPath);

    client = new IpcClient((msg) => clientMessages.push(msg));
    await client.connect(socketPath);
    await Bun.sleep(50);
  });

  afterEach(async () => {
    client.close();
    server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("sends hello and server receives it", async () => {
    client.send({
      t: "hello",
      sid: "test-client",
      cwd: "/tmp",
      pid: process.pid,
    });
    await Bun.sleep(50);

    expect(serverMessages.length).toBe(1);
    const msg = serverMessages[0];
    expect(msg?.t).toBe("hello");
    expect((msg as IpcHello | undefined)?.sid).toBe("test-client");
  });

  test("sends record and server receives it", async () => {
    client.send({
      t: "hello",
      sid: "rec-test",
      cwd: "/tmp",
      pid: process.pid,
    });
    client.send({
      t: "rec",
      sid: "rec-test",
      kind: "io",
      payload: Buffer.from("hello").toString("base64"),
      ts: Date.now(),
    });
    await Bun.sleep(50);

    expect(serverMessages.length).toBe(2);
    expect(serverMessages[1]?.t).toBe("rec");
    const rec = serverMessages[1] as IpcRec | undefined;
    expect(rec?.kind).toBe("io");
  });

  test("receives ack from server", async () => {
    client.send({
      t: "hello",
      sid: "ack-client",
      cwd: "/tmp",
      pid: process.pid,
    });
    await Bun.sleep(50);

    const runner = server.findRunnerBySid("ack-client");
    if (!runner) throw new Error("expected runner for ack-client");
    expect(runner).toBeDefined();

    server.send(runner, { t: "ack", sid: "ack-client", seq: 99 });
    await Bun.sleep(50);

    expect(clientMessages.length).toBe(1);
    expect((clientMessages[0] as IpcAck).t).toBe("ack");
    expect((clientMessages[0] as IpcAck).seq).toBe(99);
  });

  test("receives input from server", async () => {
    client.send({
      t: "hello",
      sid: "input-client",
      cwd: "/tmp",
      pid: process.pid,
    });
    await Bun.sleep(50);

    const runner = server.findRunnerBySid("input-client");
    if (!runner) throw new Error("expected runner for input-client");
    server.send(runner, {
      t: "input",
      sid: "input-client",
      data: Buffer.from("user input").toString("base64"),
    });
    await Bun.sleep(50);

    expect(clientMessages.length).toBe(1);
    expect((clientMessages[0] as IpcInput).t).toBe("input");
    expect(
      Buffer.from((clientMessages[0] as IpcInput).data, "base64").toString(),
    ).toBe("user input");
  });

  test("sends bye and server receives it", async () => {
    client.send({
      t: "hello",
      sid: "bye-test",
      cwd: "/tmp",
      pid: process.pid,
    });
    client.send({ t: "bye", sid: "bye-test", exitCode: 0 });
    await Bun.sleep(50);

    expect(serverMessages.length).toBe(2);
    expect(serverMessages[1]?.t).toBe("bye");
    expect((serverMessages[1] as IpcBye | undefined)?.exitCode).toBe(0);
  });
});

describe("IpcClient inbound guard", () => {
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-ipc-guard-"));
    socketPath = join(tmpDir, "guard.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("drops malformed and non-runner-inbound frames", async () => {
    // A bare server that injects exactly the frames the real IpcServer would
    // never send: a malformed discriminant, a valid-but-not-runner-inbound
    // message (bye is a runner→daemon type), an ack missing required fields,
    // and finally a well-formed ack. Only the last must reach onMessage.
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(encodeFrame({ t: "totally-bogus", evil: 1 }));
          sock.write(encodeFrame({ t: "bye", sid: "s", exitCode: 0 }));
          sock.write(encodeFrame({ t: "ack", sid: "s" })); // missing seq
          sock.write(encodeFrame({ t: "ack", sid: "s", seq: 42 }));
        },
        data() {},
        close() {},
        error() {},
      },
    });

    const received: IpcMessage[] = [];
    const client = new IpcClient((msg) => received.push(msg));
    await client.connect(socketPath);
    await Bun.sleep(80);

    expect(received).toEqual([{ t: "ack", sid: "s", seq: 42 }]);

    client.close();
    server.stop();
  });
});

/**
 * Decode-throw teardown regression.
 *
 * FrameDecoder.decode() throws on a protocol-fatal frame — an oversized header
 * (jsonLen+binLen > MAX_FRAME_SIZE, the H1 path) or a malformed JSON payload
 * (the M1 path). The throw escapes the Bun `data` callback but Bun does NOT
 * translate it into a socket `error`/`close`. Before the guard, the IpcClient
 * stayed in `{ connected: true }` on a wedged stream, so every subsequent
 * send() returned early-success while silently dropping all PTY io + hook
 * events. The guard must catch the throw, reset the decoder, and end() the
 * socket so the close handler runs (onClose fires) and the owning Runner tears
 * down. After teardown, send() must be a no-op (the connected guard rejects).
 */
describe("IpcClient decode-throw teardown", () => {
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-ipc-decode-"));
    socketPath = join(tmpDir, "decode.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("oversized frame header tears down socket and fires onClose", async () => {
    // Bare server that, on connect, writes an 8-byte frame header declaring a
    // 4 GiB binary payload (binLen=0xFFFFFFFF) — far over the 64 MiB cap, so
    // FrameDecoder.decode() throws on the very first decode without buffering.
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(sock) {
          const header = new Uint8Array(8);
          const view = new DataView(header.buffer);
          view.setUint32(0, 0); // jsonLen = 0
          view.setUint32(4, 0xffffffff); // binLen = 4 GiB → over MAX_FRAME_SIZE
          sock.write(header);
        },
        data() {},
        close() {},
        error() {},
      },
    });

    let closeFired = false;
    const received: IpcMessage[] = [];
    const client = new IpcClient(
      (msg) => received.push(msg),
      () => {
        closeFired = true;
      },
    );
    await client.connect(socketPath);
    await Bun.sleep(80);

    // The decode throw must have torn the socket down via the close handler.
    expect(closeFired).toBe(true);
    expect(received).toEqual([]);

    // send() after teardown must be a silent no-op, never throw.
    expect(() => {
      client.send({ t: "hello", sid: "decode-test", cwd: "/tmp", pid: 1 });
    }).not.toThrow();

    server.stop();
  });

  test("malformed JSON frame tears down socket and fires onClose", async () => {
    // A well-formed header whose JSON payload is not parseable triggers the M1
    // decode throw. encodeFrame always produces valid JSON, so we hand-build a
    // frame: jsonLen = len("{bad"), binLen = 0, then the raw bytes "{bad".
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(sock) {
          const payload = new TextEncoder().encode("{bad");
          const frame = new Uint8Array(8 + payload.length);
          const view = new DataView(frame.buffer);
          view.setUint32(0, payload.length); // jsonLen
          view.setUint32(4, 0); // binLen
          frame.set(payload, 8);
          sock.write(frame);
        },
        data() {},
        close() {},
        error() {},
      },
    });

    let closeFired = false;
    const client = new IpcClient(
      () => {},
      () => {
        closeFired = true;
      },
    );
    await client.connect(socketPath);
    await Bun.sleep(80);

    expect(closeFired).toBe(true);

    server.stop();
  });
});

/**
 * H4 regression — IPC send queue overflow must be a hard error.
 *
 * We inject a QueuedWriter pre-set to a 1-byte cap and force it into the
 * overflowed state (by calling write() with a zero-write socket so the chunk
 * is enqueued, which immediately exceeds the 1-byte limit). When the next
 * send() fires, IpcClient must detect isOverflowed, close the socket, and
 * invoke the onClose callback rather than silently dropping data.
 */
describe("IpcClient overflow — H4 regression", () => {
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-ipc-overflow-"));
    socketPath = join(tmpDir, "overflow.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("closes socket and fires onClose when queue overflows", async () => {
    // A server that accepts the connection but never drains; used only to
    // give IpcClient a valid connected socket to call send() on.
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open() {},
        data() {},
        close() {},
        error() {},
      },
    });

    let closeFired = false;

    // Inject a writer that is already in the overflowed state.
    // maxQueuedBytes=1 — a single byte cap; writing anything larger via a
    // socket that returns 0 (zero-write) will immediately set overflowed=true.
    const writer = new QueuedWriter({ maxQueuedBytes: 1 });
    // Force overflow by writing to a mock socket that always returns 0
    // (simulates full kernel buffer, triggering enqueue → immediate overflow).
    const zeroWriteSocket = { write: (_data: Uint8Array) => 0 };
    writer.write(zeroWriteSocket, new Uint8Array(2)); // 2 bytes > 1-byte cap
    expect(writer.isOverflowed).toBe(true);

    const client = new IpcClient(
      () => {},
      () => {
        closeFired = true;
      },
      writer,
    );
    await client.connect(socketPath);

    // Any send on an overflowed writer must trigger teardown.
    client.send({ t: "hello", sid: "overflow-test", cwd: "/tmp", pid: 1 });

    // Give the event loop a tick for the close to propagate.
    await Bun.sleep(50);

    expect(closeFired).toBe(true);

    // Subsequent sends must not crash (idempotent after close).
    expect(() => {
      client.send({ t: "hello", sid: "overflow-test", cwd: "/tmp", pid: 1 });
    }).not.toThrow();

    server.stop();
  });
});
