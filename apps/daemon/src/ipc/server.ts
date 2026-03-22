import { unlinkSync, existsSync } from "fs";
import {
  encodeFrame,
  FrameDecoder,
  QueuedWriter,
  getSocketPath,
  type IpcMessage,
  type IpcHello,
  type IpcRec,
  type IpcBye,
} from "@teleprompter/protocol";

type IncomingMessage = IpcHello | IpcRec | IpcBye;

interface ConnectedRunner {
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

export class IpcServer {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private runners = new Set<ConnectedRunner>();
  private events: IpcServerEvents;

  constructor(events: IpcServerEvents) {
    this.events = events;
  }

  start(socketPath?: string): string {
    const path = socketPath ?? getSocketPath();

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
          console.error("[IpcServer] socket error:", err.message);
        },
      },
    });

    console.log(`[IpcServer] listening on ${path}`);
    return path;
  }

  send(runner: ConnectedRunner, msg: IpcMessage): void {
    const frame = encodeFrame(msg);
    runner.writer.write(runner.socket as Parameters<QueuedWriter["write"]>[0], frame);
  }

  findRunnerBySid(sid: string): ConnectedRunner | undefined {
    for (const runner of this.runners) {
      if (runner.sid === sid) return runner;
    }
    return undefined;
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
    this.runners.clear();
  }
}
