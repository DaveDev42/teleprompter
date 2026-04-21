import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "@teleprompter/protocol";
import { connectWindowsIpc } from "./ipc-client-windows";

/**
 * Windows-only coverage for the Named Pipe CLI IPC client. macOS/Linux CI
 * skips this suite because Unix domain socket paths and Named Pipe paths are
 * not interchangeable. The POSIX path is already covered by
 * `ipc-client.test.ts`.
 */
describe.skipIf(process.platform !== "win32")("connectWindowsIpc", () => {
  let pipePath: string;
  let server: { stop(): void } | null = null;

  beforeEach(() => {
    // Unique Named Pipe name per test. Named pipes live in a flat kernel
    // namespace, so uniqueness matters more than filesystem isolation.
    pipePath = `\\\\.\\pipe\\tp-ipc-client-win-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  });

  afterEach(() => {
    try {
      server?.stop();
    } catch {
      /* best effort */
    }
    server = null;
  });

  test("sends and receives framed JSON over named pipe", async () => {
    server = Bun.listen({
      unix: pipePath,
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

    const client = await connectWindowsIpc(pipePath);
    const replies: unknown[] = [];
    client.onMessage((m) => replies.push(m));
    client.send({ t: "ping" });
    await Bun.sleep(100);
    expect(replies[0]).toMatchObject({ t: "echo" });
    client.close();
  });

  test("onClose fires when server disconnects", async () => {
    server = Bun.listen({
      unix: pipePath,
      socket: {
        open() {},
        data(sock) {
          sock.end();
        },
        close() {},
        error() {},
      },
    });

    const client = await connectWindowsIpc(pipePath);
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    client.send({ t: "hello" });
    await Bun.sleep(200);
    expect(closed).toBe(true);
    client.close();
  });
});
