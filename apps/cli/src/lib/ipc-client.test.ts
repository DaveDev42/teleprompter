import { describe, expect, test } from "bun:test";
import { encodeFrame, type IpcMessage } from "@teleprompter/protocol";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connectIpcAsClient } from "./ipc-client";

describe("connectIpcAsClient", () => {
  test("sends and receives a validated IpcMessage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-ipc-"));
    const sockPath = join(dir, "s.sock");

    // Server echoes back a well-formed ack for whatever it receives.
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        open() {},
        data(sock) {
          const ack: IpcMessage = { t: "ack", sid: "s1", seq: 7 };
          sock.write(encodeFrame(ack));
        },
        close() {},
        error() {},
      },
    });

    const client = await connectIpcAsClient(sockPath);
    const replies: IpcMessage[] = [];
    client.onMessage((m) => replies.push(m));
    client.send({ t: "hello", sid: "s1", cwd: "/work", pid: 123 });
    await new Promise((r) => setTimeout(r, 50));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({ t: "ack", sid: "s1", seq: 7 });
    client.close();
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("drops a malformed inbound frame instead of dispatching it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-ipc-"));
    const sockPath = join(dir, "s.sock");

    // Server sends: an unknown discriminant, an ack missing required fields,
    // and finally a well-formed ack. Only the last should reach a handler —
    // parseIpcMessage drops the first two at the transport boundary.
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        open() {},
        data(sock) {
          sock.write(encodeFrame({ t: "totally-bogus", evil: 1 }));
          sock.write(encodeFrame({ t: "ack", sid: "s1" })); // missing seq
          sock.write(encodeFrame({ t: "ack", sid: "s1", seq: 9 }));
        },
        close() {},
        error() {},
      },
    });

    const client = await connectIpcAsClient(sockPath);
    const replies: IpcMessage[] = [];
    client.onMessage((m) => replies.push(m));
    client.send({ t: "hello", sid: "s1", cwd: "/work", pid: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(replies).toEqual([{ t: "ack", sid: "s1", seq: 9 }]);
    client.close();
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("onClose fires when server disconnects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-ipc-"));
    const sockPath = join(dir, "s.sock");

    const server = Bun.listen({
      unix: sockPath,
      socket: {
        open() {},
        data(sock) {
          sock.end();
        },
        close() {},
        error() {},
      },
    });

    const client = await connectIpcAsClient(sockPath);
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    client.send({ t: "hello", sid: "s1", cwd: "/work", pid: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
    client.close();
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
