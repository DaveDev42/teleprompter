import {
  encodeFrame,
  FrameDecoder,
  type IpcMessage,
  parseIpcMessage,
} from "@teleprompter/protocol";

export interface IpcClient {
  send(msg: IpcMessage): void;
  onMessage(handler: (msg: IpcMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/**
 * Connect to the daemon IPC socket as a CLI client (distinct from runner).
 * Returns an IpcClient with send/receive helpers. The daemon's IpcServer
 * treats any connecting peer the same — the "role" is inferred from the
 * message types the peer sends (pair.* vs hello/rec/bye).
 *
 * Inbound frames are validated by `parseIpcMessage` at this transport
 * boundary, so every `onMessage` handler receives a fully-typed `IpcMessage`
 * (never a raw `unknown`) and a malformed/unknown daemon reply is dropped here
 * rather than reaching a command handler that would cast it blindly.
 */
export async function connectIpcAsClient(
  socketPath: string,
): Promise<IpcClient> {
  const decoder = new FrameDecoder();
  const messageHandlers: Array<(m: IpcMessage) => void> = [];
  const closeHandlers: Array<() => void> = [];

  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data) {
        const frames = decoder.decode(new Uint8Array(data));
        for (const frame of frames) {
          const msg = parseIpcMessage(frame.data);
          if (!msg) continue;
          for (const h of messageHandlers) h(msg);
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
