import { createServer, type Server, type Socket } from "node:net";
import {
  createLogger,
  FrameDecoder,
  type IpcHello,
  QueuedWriter,
} from "@teleprompter/protocol";
import type { ConnectedRunner, IpcServerEvents } from "./server";

const log = createLogger("IpcServer:Windows");

/**
 * Adapter wrapping node:net Socket to match QueuedWriter's Writable interface.
 * QueuedWriter expects write() to return number of bytes written.
 * node:net Socket.write() returns boolean (true=flushed, false=buffered).
 */
class NetSocketAdapter {
  constructor(private socket: Socket) {}

  write(data: Uint8Array): number {
    const canWriteMore = this.socket.write(Buffer.from(data));
    // node:net buffers the entire chunk internally (no partial writes).
    // Return full length if buffer not full, 0 if backpressure (triggers QueuedWriter queueing).
    return canWriteMore ? data.byteLength : 0;
  }
}

export function startWindowsServer(
  path: string,
  events: IpcServerEvents,
  runners: Set<ConnectedRunner>,
): { server: Server; transport: "bun-pipe" | "node-net" } {
  // Try Bun.listen with named pipe first
  try {
    const bunServer = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          const runner: ConnectedRunner = {
            socket,
            writer: new QueuedWriter(),
            decoder: new FrameDecoder(),
          };
          (socket as unknown as { _runner: ConnectedRunner })._runner = runner;
          runners.add(runner);
          events.onConnect(runner);
        },
        data(socket, data) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })._runner;
          const messages = runner.decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            if ((msg as IpcHello).t === "hello") {
              runner.sid = (msg as IpcHello).sid;
            }
            events.onMessage(runner, msg as Parameters<IpcServerEvents["onMessage"]>[1]);
          }
        },
        drain(socket) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })._runner;
          runner.writer.drain(socket);
        },
        close(socket) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })._runner;
          runners.delete(runner);
          events.onDisconnect(runner);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
      },
    });

    log.info(`listening on ${path} (bun native pipe)`);
    return {
      server: { close: () => bunServer.stop() } as unknown as Server,
      transport: "bun-pipe",
    };
  } catch {
    log.info("Bun named pipe not supported, falling back to node:net");
  }

  // Fallback: node:net
  const server = createServer((socket: Socket) => {
    const adapter = new NetSocketAdapter(socket);
    const runner: ConnectedRunner = {
      socket: adapter,
      writer: new QueuedWriter(),
      decoder: new FrameDecoder(),
    };
    runners.add(runner);
    events.onConnect(runner);

    socket.on("data", (data: Buffer) => {
      const messages = runner.decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      for (const msg of messages) {
        if ((msg as IpcHello).t === "hello") {
          runner.sid = (msg as IpcHello).sid;
        }
        events.onMessage(runner, msg as Parameters<IpcServerEvents["onMessage"]>[1]);
      }
    });

    socket.on("drain", () => {
      runner.writer.drain(adapter);
    });

    socket.on("close", () => {
      runners.delete(runner);
      events.onDisconnect(runner);
    });

    socket.on("error", (err) => {
      log.error("socket error:", err.message);
    });
  });

  server.listen(path);
  log.info(`listening on ${path} (node:net fallback)`);
  return { server, transport: "node-net" };
}
