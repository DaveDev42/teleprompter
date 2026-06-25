import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  getSocketPath,
  type IpcMessage,
  parseIpcMessage,
  QueuedWriter,
} from "@teleprompter/protocol";
import { existsSync, lstatSync, unlinkSync } from "fs";

// How often the daemon re-checks that its IPC socket dirent still exists at the
// bound path. The in-kernel listening socket survives a dirent unlink, but the
// path becomes unreachable by `connect()` (macOS AF_UNIX = VFS, no abstract
// namespace), so every new client (`tp status`, `tp` passthrough → ensureDaemon)
// sees ENOENT, reports the live daemon as "not running", and risks spawning a
// duplicate. 30s is a tunable heartbeat — cheap (one lstat) and far below the
// human-noticeable window for a stale "not running".
const SOCKET_HEAL_INTERVAL_MS = 30_000;

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
  private boundPath: string | null = null;
  private healTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(events: IpcServerEvents) {
    this.events = events;
  }

  start(socketPath?: string): string {
    const path = socketPath ?? getSocketPath();
    this.stopped = false;
    this.listen(path);
    this.boundPath = path;
    this.startHealTimer();
    return path;
  }

  /**
   * Bind (or re-bind) the Unix listening socket at `path`. Extracted from
   * `start()` so the heal timer can recreate the dirent after it is unlinked
   * out from under a live daemon (restart races, a stray `tp daemon start` that
   * pre-unlinks then early-exits on the lock, OS tmp churn). Re-binding creates
   * a fresh listening socket + dirent; already-accepted runner connections live
   * in the OS independent of the listener and are unaffected.
   */
  private listen(path: string): void {
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
  }

  /**
   * Returns true if the dirent at `path` exists and is a Unix socket. A missing
   * dirent (ENOENT) or a path that has been replaced by a regular file/dir both
   * mean the bound path can no longer accept `connect()` and must be re-bound.
   */
  private socketDirentHealthy(path: string): boolean {
    try {
      return lstatSync(path).isSocket();
    } catch {
      // ENOENT (unlinked) or any stat error → not healthy.
      return false;
    }
  }

  /**
   * Periodically re-assert that the bound socket dirent still exists. If it has
   * been unlinked while the daemon is alive, re-bind so new clients can reach
   * the daemon again instead of seeing ENOENT and spawning a duplicate. The
   * callback is fully guarded: a throw escaping a timer callback terminates the
   * Bun process (same hazard the auto-cleanup / data-callback guards address),
   * which would be a far worse outcome than a missed heal.
   */
  private startHealTimer(): void {
    if (this.healTimer) return;
    this.healTimer = setInterval(() => {
      try {
        if (this.stopped || !this.boundPath) return;
        if (this.socketDirentHealthy(this.boundPath)) return;
        log.warn(
          `IPC socket dirent missing at ${this.boundPath} — re-binding so the daemon stays reachable`,
        );
        // Drop the old listening socket (default keeps already-accepted runner
        // connections alive) before binding a fresh listener at the same path.
        this.server?.stop();
        this.server = null;
        this.listen(this.boundPath);
      } catch (err) {
        log.error(
          "IPC socket heal failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }, SOCKET_HEAL_INTERVAL_MS);
    // Don't keep the event loop alive solely for the heal heartbeat.
    (this.healTimer as unknown as { unref?: () => void }).unref?.();
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
    this.stopped = true;
    if (this.healTimer) {
      clearInterval(this.healTimer);
      this.healTimer = null;
    }
    this.server?.stop();
    this.server = null;
    this.boundPath = null;
    this.runners.clear();
  }

  /**
   * Test-only: force a heal check synchronously (the heal timer's body),
   * letting a regression test drive the unlink→rebind path without waiting
   * for the 30s interval. Returns true if a re-bind occurred.
   */
  __healNow(): boolean {
    if (this.stopped || !this.boundPath) return false;
    if (this.socketDirentHealthy(this.boundPath)) return false;
    this.server?.stop();
    this.server = null;
    this.listen(this.boundPath);
    return true;
  }
}
