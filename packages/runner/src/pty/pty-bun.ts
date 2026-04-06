import type { Subprocess } from "bun";
import type { PtyManager, PtyOptions } from "./pty-manager";

export class PtyBun implements PtyManager {
  private proc: Subprocess | null = null;

  spawn(opts: PtyOptions): void {
    this.proc = Bun.spawn(opts.command, {
      cwd: opts.cwd,
      terminal: {
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 40,
        name: "xterm-256color",
        data(_term, data) {
          opts.onData(data);
        },
      },
    });

    // Wait for exit in background
    this.proc.exited.then((code) => {
      opts.onExit(code);
    });
  }

  write(data: string | Uint8Array): void {
    if (!this.proc) return;
    (
      this.proc as unknown as {
        terminal: { write(d: string | Uint8Array): void };
      }
    ).terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.proc) return;
    (
      this.proc as unknown as {
        terminal: { resize(c: number, r: number): void };
      }
    ).terminal.resize(cols, rows);
  }

  kill(signal: number = 15): void {
    this.proc?.kill(signal);
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
