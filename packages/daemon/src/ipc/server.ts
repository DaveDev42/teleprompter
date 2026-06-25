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
  sid?: string | undefined;
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
          let frames: ReturnType<FrameDecoder["decode"]>;
          try {
            frames = runner.decoder.decode(new Uint8Array(data));
          } catch (err) {
            log.error(
              "frame decode error — closing socket:",
              err instanceof Error ? err.message : String(err),
            );
            (socket as unknown as { end(): void }).end();
            return;
          }
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
            // onMessage → dispatchIpc → handleRec/handleHello/handleBye, which run
            // synchronous SQLite writes (insertStmt.run() etc.). Those CAN throw on
            // a transient I/O error (disk full, SQLITE_BUSY, a corrupt page). Bun
            // does NOT wrap socket `data` callbacks in an implicit try/catch, so an
            // unguarded throw here escapes the event-loop callback and terminates
            // the ENTIRE daemon — killing every other running session, its IPC, and
            // the relay client. Contain it to the offending socket: log + end() it
            // (mirrors the decode-error path above), so one runner's transient DB
            // error never crashes the mux.
            try {
              self.events.onMessage(runner, msg, frame.binary);
            } catch (err) {
              log.error(
                `onMessage handler threw (sid=${runner.sid ?? "?"}, t=${msg.t}) — closing socket:`,
                err instanceof Error ? err.message : String(err),
              );
              (socket as unknown as { end(): void }).end();
              return;
            }
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
        error(socket, err) {
          log.error("socket error:", err.message);
          // Bun unix sockets can fire `error` WITHOUT a following `close`
          // (the same pattern the client side already guards against). If we
          // only logged here, the ConnectedRunner would leak in `runners`:
          // findRunnerBySid would return a stale runner and onDisconnect
          // (which cancels pending pairings owned by this runner) would never
          // fire. Mirror close()'s cleanup. Set.delete()'s boolean return
          // makes onDisconnect fire at most once even if `close` also runs.
          const runner = (socket as unknown as { _runner?: ConnectedRunner })
            ._runner;
          if (runner && self.runners.delete(runner)) {
            self.events.onDisconnect(runner);
          }
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
