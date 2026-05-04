import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  getSocketPath,
  type IpcMessage,
  parseIpcMessage,
  QueuedWriter,
} from "@teleprompter/protocol";
import { existsSync, unlinkSync } from "fs";

export interface ConnectedRunner {
  socket: unknown;
  writer: QueuedWriter;
  decoder: FrameDecoder;
  sid?: string;
}

export interface IpcServerEvents {
  onMessage: (
    runner: ConnectedRunner,
    msg: IpcMessage,
    binary: Uint8Array<ArrayBufferLike> | null,
  ) => void;
  onConnect: (runner: ConnectedRunner) => void;
  onDisconnect: (runner: ConnectedRunner) => void;
}

const log = createLogger("IpcServer");

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
          const frames = runner.decoder.decode(new Uint8Array(data));
          for (const frame of frames) {
            const msg = parseIpcMessage(frame.data);
            if (!msg) {
              log.warn("dropped malformed IPC message");
              continue;
            }
            // Track SID from hello message
            if (msg.t === "hello") {
              runner.sid = msg.sid;
            }
            self.events.onMessage(runner, msg, frame.binary);
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

  send(
    runner: ConnectedRunner,
    msg: IpcMessage,
    binary?: Uint8Array<ArrayBufferLike> | null,
  ): void {
    const frame = encodeFrame(msg, binary ?? null);
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
    this.server?.stop();
    this.server = null;
    this.runners.clear();
  }
}
