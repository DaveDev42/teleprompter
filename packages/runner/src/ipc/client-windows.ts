import { connect as netConnect, type Socket } from "node:net";
import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  type IpcMessage,
  QueuedWriter,
} from "@teleprompter/protocol";

const log = createLogger("IpcClient:Windows");

type IncomingHandler = (msg: unknown) => void;

interface WindowsIpcConnection {
  send(msg: IpcMessage): void;
  close(): void;
}

export async function connectWindows(
  path: string,
  onMessage: IncomingHandler,
): Promise<WindowsIpcConnection> {
  // Try Bun.connect first
  try {
    const writer = new QueuedWriter();
    const decoder = new FrameDecoder();

    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          const messages = decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            onMessage(msg);
          }
        },
        drain(socket) {
          writer.drain(socket);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
        close() {
          log.info("disconnected");
        },
      },
    });

    log.info(`connected to ${path} (bun native pipe)`);
    return {
      send(msg: IpcMessage) {
        const frame = encodeFrame(msg);
        writer.write(socket, frame);
      },
      close() {
        socket.end();
      },
    };
  } catch {
    log.info("Bun named pipe connect failed, falling back to node:net");
  }

  // Fallback: node:net
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const socket: Socket = netConnect(path, () => {
      log.info(`connected to ${path} (node:net fallback)`);
      resolve({
        send(msg: IpcMessage) {
          const frame = encodeFrame(msg);
          socket.write(Buffer.from(frame));
        },
        close() {
          socket.end();
        },
      });
    });

    socket.on("data", (data: Buffer) => {
      const messages = decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      for (const msg of messages) {
        onMessage(msg);
      }
    });

    socket.on("error", (err) => {
      log.error("socket error:", err.message);
      socket.destroy();
      reject(err);
    });

    socket.on("close", () => {
      log.info("disconnected");
    });
  });
}
