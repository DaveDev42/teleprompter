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
export async function connectIpcAsClient(
  socketPath: string,
): Promise<IpcClient> {
  const decoder = new FrameDecoder();
  const messageHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];

  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data) {
        const frames = decoder.decode(new Uint8Array(data));
        for (const frame of frames) {
          for (const h of messageHandlers) h(frame.data);
        }
      },
      close() {
        for (const h of closeHandlers) h();
      },
      error(_s, _err) {
        try {
          _s.end();
        } catch {}
        for (const h of closeHandlers) h();
      },
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
