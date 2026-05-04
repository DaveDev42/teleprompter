import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "@teleprompter/protocol";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connectIpcAsClient } from "./ipc-client";

describe("connectIpcAsClient", () => {
  test("sends and receives framed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-ipc-"));
    const sockPath = join(dir, "s.sock");

    const server = Bun.listen({
      unix: sockPath,
      socket: {
        open() {},
        data(sock, data) {
          const dec = new FrameDecoder();
          const msgs = dec.decode(new Uint8Array(data));
          const frame = encodeFrame({ t: "echo", payload: msgs[0] });
          sock.write(frame);
        },
        close() {},
        error() {},
      },
    });

    const client = await connectIpcAsClient(sockPath);
    const replies: unknown[] = [];
    client.onMessage((m) => replies.push(m));
    client.send({ t: "ping" });
    await new Promise((r) => setTimeout(r, 50));
    expect(replies[0]).toMatchObject({ t: "echo" });
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
    client.send({ t: "hello" });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
    client.close();
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
