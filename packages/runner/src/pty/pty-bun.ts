import { createLogger } from "@teleprompter/protocol";
import type { Subprocess } from "bun";
import type { PtyManager, PtyOptions } from "./pty-manager";

const log = createLogger("PtyBun");

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

    // Wait for exit in background. The .catch ensures that if onExit (i.e.
    // Runner.stop()) throws, the rejection is logged rather than becoming an
    // unhandled promise rejection that Bun may escalate to process termination
    // without normal cleanup.
    this.proc.exited
      .then((code) => {
        opts.onExit(code);
      })
      .catch((err: unknown) => {
        log.error("error in PTY exit handler:", err);
      });
  }

  write(data: string | Uint8Array): void {
    // bun-types models `terminal` as `Terminal | undefined` — it is only unset
    // when spawned without the `terminal` option, which spawn() above always
    // provides. The guard makes that invariant explicit (no non-null assertion,
    // no behavior change: an unspawned/killed proc is a no-op as before).
    const terminal = this.proc?.terminal;
    if (!terminal) return;
    terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    const terminal = this.proc?.terminal;
    if (!terminal) return;
    terminal.resize(cols, rows);
  }

  kill(signal: number = 15): void {
    this.proc?.kill(signal);
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
