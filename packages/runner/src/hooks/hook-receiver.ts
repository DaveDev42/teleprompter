import {
  createLogger,
  type HookEventBase,
  parseHookEvent,
  resolveRuntimeDir,
} from "@teleprompter/protocol";
import { chmodSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";

const log = createLogger("HookReceiver");

/**
 * Per-connection accumulation buffer ceiling.
 *
 * Hook events are small JSON payloads (a few KB at most). If a connection
 * sends data that never forms valid JSON — truncated message, garbage bytes,
 * or a malicious flood — the buffer would grow without bound, causing an
 * unbounded-memory DoS on the runner process. 1 MB is generous enough for
 * any real hook event while keeping the worst-case footprint predictable.
 */
const MAX_HOOK_BUF_BYTES = 1 * 1024 * 1024; // 1 MB

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
          // Guard against unbounded-memory DoS: if the accumulated buffer
          // exceeds MAX_HOOK_BUF_BYTES the data can never form a valid hook
          // event within budget, so drop it and reset the buffer. Measure the
          // actual UTF-8 byte length — `_buf` is a JS string whose `.length` is
          // UTF-16 code units, so a flood of multi-byte codepoints could grow
          // the real footprint to ~2-4x the cap before `.length` tripped it.
          if (Buffer.byteLength(conn._buf, "utf-8") > MAX_HOOK_BUF_BYTES) {
            log.warn(
              `hook buffer exceeded ${MAX_HOOK_BUF_BYTES} bytes, dropping oversized payload`,
            );
            conn._buf = "";
            return;
          }
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
    // `sid` originates from the `--tp-sid` passthrough flag and is interpolated
    // directly into the socket filename. Reject any path-traversal sequence
    // before joining so a crafted sid (e.g. `../../etc/x` or `a/b`) cannot
    // escape the per-user runtime dir and bind/unlink a socket elsewhere. There
    // is no privilege boundary here (same-user), but an unguarded join still
    // lets a confused/crafted sid self-DoS by writing outside the runtime dir.
    if (sid.includes("/") || sid.includes("\\") || sid.includes("..")) {
      throw new Error(
        `invalid sid '${sid}': must not contain a path separator or '..'`,
      );
    }
    return join(resolveRuntimeDir(), `hook-${sid}.sock`);
  }
}
