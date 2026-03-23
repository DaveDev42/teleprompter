import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { IpcClient } from "./client";
import { IpcServer } from "../../../daemon/src/ipc/server";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { IpcAck, IpcInput } from "@teleprompter/protocol";

describe("IpcClient", () => {
  let server: IpcServer;
  let client: IpcClient;
  let socketPath: string;
  let tmpDir: string;
  let serverMessages: any[];
  let clientMessages: any[];

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
    expect(serverMessages[0].t).toBe("hello");
    expect(serverMessages[0].sid).toBe("test-client");
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
    expect(serverMessages[1].t).toBe("rec");
    expect(serverMessages[1].kind).toBe("io");
  });

  test("receives ack from server", async () => {
    client.send({
      t: "hello",
      sid: "ack-client",
      cwd: "/tmp",
      pid: process.pid,
    });
    await Bun.sleep(50);

    const runner = server.findRunnerBySid("ack-client")!;
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

    const runner = server.findRunnerBySid("input-client")!;
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
    expect(serverMessages[1].t).toBe("bye");
    expect(serverMessages[1].exitCode).toBe(0);
  });
});
