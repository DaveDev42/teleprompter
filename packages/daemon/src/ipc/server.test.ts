import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  type IpcAck,
  type IpcBye,
  type IpcHello,
  type IpcMessage,
  type IpcRec,
} from "@teleprompter/protocol";
import { mkdtemp, rm } from "fs/promises";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { IpcServer } from "./server";

describe("IpcServer", () => {
  let server: IpcServer;
  let socketPath: string;
  let tmpDir: string;
  let receivedMessages: IpcMessage[] = [];
  let connectedCount = 0;
  let disconnectedCount = 0;

  beforeEach(async () => {
    receivedMessages = [];
    connectedCount = 0;
    disconnectedCount = 0;
    tmpDir = await mkdtemp(join(tmpdir(), "tp-ipc-test-"));
    socketPath = join(tmpDir, "test.sock");

    server = new IpcServer({
      onMessage: (_runner, msg) => {
        receivedMessages.push(msg);
      },
      onConnect: () => {
        connectedCount++;
      },
      onDisconnect: () => {
        disconnectedCount++;
      },
    });
    server.start(socketPath);
  });

  afterEach(async () => {
    server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function connectClient(): Promise<ReturnType<typeof connect>> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.on("connect", () => resolve(socket));
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  }

  test("accepts connections", async () => {
    const client = await connectClient();
    await Bun.sleep(50);
    expect(connectedCount).toBe(1);
    client.end();
    await Bun.sleep(50);
    expect(disconnectedCount).toBe(1);
  });

  test("receives hello message", async () => {
    const client = await connectClient();
    const hello: IpcHello = {
      t: "hello",
      sid: "test-session",
      cwd: "/tmp",
      pid: process.pid,
    };
    client.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].t).toBe("hello");
    expect(receivedMessages[0].sid).toBe("test-session");
    client.end();
  });

  test("receives multiple framed messages", async () => {
    const client = await connectClient();

    const hello: IpcHello = {
      t: "hello",
      sid: "multi-test",
      cwd: "/tmp",
      pid: process.pid,
    };
    const rec: IpcRec = {
      t: "rec",
      sid: "multi-test",
      kind: "io",
      payload: Buffer.from("hello world").toString("base64"),
      ts: Date.now(),
    };
    const bye: IpcBye = {
      t: "bye",
      sid: "multi-test",
      exitCode: 0,
    };

    client.write(Buffer.from(encodeFrame(hello)));
    client.write(Buffer.from(encodeFrame(rec)));
    client.write(Buffer.from(encodeFrame(bye)));

    await Bun.sleep(100);
    expect(receivedMessages.length).toBe(3);
    expect(receivedMessages[0].t).toBe("hello");
    expect(receivedMessages[1].t).toBe("rec");
    expect(receivedMessages[2].t).toBe("bye");
    client.end();
  });

  test("findRunnerBySid finds registered runner", async () => {
    const client = await connectClient();
    const hello: IpcHello = {
      t: "hello",
      sid: "find-me",
      cwd: "/tmp",
      pid: process.pid,
    };
    client.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);

    const found = server.findRunnerBySid("find-me");
    expect(found).toBeDefined();
    expect(found?.sid).toBe("find-me");

    const notFound = server.findRunnerBySid("no-such");
    expect(notFound).toBeUndefined();

    client.end();
  });

  test("sends ack back to runner", async () => {
    const client = await connectClient();
    const decoder = new FrameDecoder();
    const received: unknown[] = [];

    client.on("data", (data: Buffer) => {
      const msgs = decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      received.push(...msgs);
    });

    const hello: IpcHello = {
      t: "hello",
      sid: "ack-test",
      cwd: "/tmp",
      pid: process.pid,
    };
    client.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);

    const runner = server.findRunnerBySid("ack-test");
    if (!runner) throw new Error("Expected runner to be registered");
    const ack: IpcAck = { t: "ack", sid: "ack-test", seq: 42 };
    server.send(runner, ack);

    await Bun.sleep(50);
    expect(received.length).toBe(1);
    expect((received[0] as IpcAck).t).toBe("ack");
    expect((received[0] as IpcAck).seq).toBe(42);

    client.end();
  });

  test("handles multiple simultaneous connections", async () => {
    const client1 = await connectClient();
    const client2 = await connectClient();

    client1.write(
      Buffer.from(encodeFrame({ t: "hello", sid: "c1", cwd: "/a", pid: 1 })),
    );
    client2.write(
      Buffer.from(encodeFrame({ t: "hello", sid: "c2", cwd: "/b", pid: 2 })),
    );
    await Bun.sleep(50);

    expect(connectedCount).toBe(2);
    expect(receivedMessages.length).toBe(2);
    expect(server.findRunnerBySid("c1")).toBeDefined();
    expect(server.findRunnerBySid("c2")).toBeDefined();

    client1.end();
    client2.end();
  });
});
