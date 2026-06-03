import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeFrame,
  type IpcAck,
  type IpcBye,
  type IpcHello,
  type IpcInput,
  type IpcMessage,
  type IpcRec,
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
    expect(serverMessages[0]!.t).toBe("hello");
    expect((serverMessages[0]! as IpcHello).sid).toBe("test-client");
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
    expect(serverMessages[1]!.t).toBe("rec");
    const rec = serverMessages[1]! as IpcRec;
    expect(rec.kind).toBe("io");
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
    expect(serverMessages[1]!.t).toBe("bye");
    expect((serverMessages[1]! as IpcBye).exitCode).toBe(0);
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
