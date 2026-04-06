import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  getSocketPath,
  type IpcBye,
  type IpcHello,
  type IpcMessage,
  type IpcRec,
  QueuedWriter,
} from "@teleprompter/protocol";
import { existsSync, unlinkSync } from "fs";
import type { Server } from "node:net";

type IncomingMessage = IpcHello | IpcRec | IpcBye;

export interface ConnectedRunner {
  socket: unknown;
  writer: QueuedWriter;
  decoder: FrameDecoder;
  sid?: string;
}

export interface IpcServerEvents {
  onMessage: (runner: ConnectedRunner, msg: IncomingMessage) => void;
  onConnect: (runner: ConnectedRunner) => void;
  onDisconnect: (runner: ConnectedRunner) => void;
}

const log = createLogger("IpcServer");

export class IpcServer {
  private server: ReturnType<typeof Bun.listen> | Server | null = null;
  private runners = new Set<ConnectedRunner>();
  private events: IpcServerEvents;

  constructor(events: IpcServerEvents) {
    this.events = events;
  }

  start(socketPath?: string): string {
    const path = socketPath ?? getSocketPath();

    if (process.platform === "win32") {
      const { startWindowsServer } = require("./server-windows") as typeof import("./server-windows");
      const result = startWindowsServer(path, this.events, this.runners);
      this.server = result.server;
      log.info(`listening on ${path}`);
      return path;
    }

    // Clean up stale socket file
    if (existsSync(path)) {
      unlinkSync(path);
    }

    const self = this;

    this.server = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          const runner: ConnectedRunner = {
            socket,
            writer: new QueuedWriter(),
            decoder: new FrameDecoder(),
          };
          (socket as unknown as { _runner: ConnectedRunner })._runner = runner;
          self.runners.add(runner);
          self.events.onConnect(runner);
        },
        data(socket, data) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })
            ._runner;
          const messages = runner.decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            // Track SID from hello message
            if ((msg as IpcHello).t === "hello") {
              runner.sid = (msg as IpcHello).sid;
            }
            self.events.onMessage(runner, msg as IncomingMessage);
          }
        },
        drain(socket) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })
            ._runner;
          runner.writer.drain(socket);
        },
        close(socket) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })
            ._runner;
          self.runners.delete(runner);
          self.events.onDisconnect(runner);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
      },
    });

    log.info(`listening on ${path}`);
    return path;
  }

  send(runner: ConnectedRunner, msg: IpcMessage): void {
    const frame = encodeFrame(msg);
    runner.writer.write(
      runner.socket as Parameters<QueuedWriter["write"]>[0],
      frame,
    );
  }

  findRunnerBySid(sid: string): ConnectedRunner | undefined {
    for (const runner of this.runners) {
      if (runner.sid === sid) return runner;
    }
    return undefined;
  }

  stop(): void {
    if (this.server && "close" in this.server) {
      (this.server as Server).close();
    } else if (this.server && "stop" in this.server) {
      (this.server as ReturnType<typeof Bun.listen>).stop();
    }
    this.server = null;
    this.runners.clear();
  }
}
