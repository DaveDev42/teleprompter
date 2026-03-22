import { unlinkSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { HookEventBase } from "@teleprompter/protocol";

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
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    const self = this;

    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        data(_socket, data) {
          try {
            const text = Buffer.from(data).toString("utf-8");
            const event = JSON.parse(text) as HookEventBase;
            self.onEvent(event);
          } catch (err) {
            console.error("[HookReceiver] parse error:", err);
          }
        },
        open() {},
        close() {},
        error(_socket, err) {
          console.error("[HookReceiver] socket error:", err.message);
        },
      },
    });

    return this.socketPath;
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
  }

  static defaultSocketPath(sid: string): string {
    const runtimeDir =
      process.env.XDG_RUNTIME_DIR ??
      join("/tmp", `teleprompter-${process.getuid!()}`);
    return join(runtimeDir, `hook-${sid}.sock`);
  }
}
