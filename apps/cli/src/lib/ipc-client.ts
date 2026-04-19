import { encodeFrame, FrameDecoder } from "@teleprompter/protocol";

export interface IpcClient {
  send(msg: unknown): void;
  onMessage(handler: (msg: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/**
 * Connect to the daemon IPC socket as a CLI client (distinct from runner).
 * Returns an IpcClient with send/receive helpers. The daemon's IpcServer
 * treats any connecting peer the same — the "role" is inferred from the
 * message types the peer sends (pair.* vs hello/rec/bye).
 */
export async function connectIpcAsClient(socketPath: string): Promise<IpcClient> {
  if (process.platform === "win32") {
    const { connectWindowsIpc } = await import("./ipc-client-windows");
    return connectWindowsIpc(socketPath);
  }

  const decoder = new FrameDecoder();
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];

  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data) {
        const msgs = decoder.decode(new Uint8Array(data));
        for (const m of msgs) {
          for (const h of messageHandlers) h(m);
        }
      },
      close() {
        for (const h of closeHandlers) h();
      },
      error() {},
    },
  });

  return {
    send(msg) {
      sock.write(encodeFrame(msg));
    },
    onMessage(h) {
      messageHandlers.push(h);
    },
    onClose(h) {
      closeHandlers.push(h);
    },
    close() {
      sock.end();
    },
  };
}
