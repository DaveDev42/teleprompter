import {
  createLogger,
  type HookEventBase,
  parseHookEvent,
} from "@teleprompter/protocol";
import { chmodSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";

const log = createLogger("HookReceiver");

export type HookEventHandler = (event: HookEventBase) => void;

export class HookReceiver {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private socketPath: string;
  private onEvent: HookEventHandler;

  constructor(socketPath: string, onEvent: HookEventHandler) {
    this.socketPath = socketPath;
    this.onEvent = onEvent;
  }

  start(): string {
    const dir = dirname(this.socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Atomic remove: eliminates the existsSync → unlinkSync TOCTOU window.
    rmSync(this.socketPath, { force: true });

    const self = this;

    log.info(`listening on ${this.socketPath}`);
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        data(_socket, data) {
          // Accumulate chunks per-connection into a text buffer; only attempt
          // JSON.parse when the accumulated text is valid UTF-8 (Bun delivers
          // Uint8Array chunks which may split a multi-byte sequence or a large
          // payload across multiple `data` calls).
          const text = Buffer.from(data).toString("utf-8");
          const conn = _socket as typeof _socket & { _buf?: string };
          conn._buf = (conn._buf ?? "") + text;
          try {
            const parsed: unknown = JSON.parse(conn._buf);
            conn._buf = "";
            const event = parseHookEvent(parsed);
            if (!event) {
              log.warn("dropped malformed hook event");
              return;
            }
            log.info(`received hook ${event.hook_event_name}`);
            self.onEvent(event);
          } catch {
            // Incomplete chunk — keep accumulating.
          }
        },
        open() {},
        close(_socket) {
          const conn = _socket as typeof _socket & { _buf?: string };
          if (conn._buf && conn._buf.length > 0) {
            log.warn(
              "connection closed with incomplete hook payload, discarding",
            );
            conn._buf = "";
          }
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
      },
    });

    return this.socketPath;
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
    // Atomic remove: eliminates the existsSync → unlinkSync TOCTOU window.
    rmSync(this.socketPath, { force: true });
  }

  static defaultSocketPath(sid: string): string {
    const xdgRuntimeDir = process.env["XDG_RUNTIME_DIR"];
    if (xdgRuntimeDir) {
      return join(xdgRuntimeDir, `hook-${sid}.sock`);
    }
    const runtimeDir = join("/tmp", `teleprompter-${process.getuid?.()}`);
    return join(runtimeDir, `hook-${sid}.sock`);
  }
}
