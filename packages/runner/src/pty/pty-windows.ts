import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { createLogger } from "@teleprompter/protocol";
import type { PtyManager, PtyOptions } from "./pty-manager";

const log = createLogger("PtyWindows");

export class PtyWindows implements PtyManager {
  private child: ChildProcess | null = null;
  private _pid: number | undefined;
  private hostScriptPath: string;

  constructor(hostScriptPath?: string) {
    this.hostScriptPath =
      hostScriptPath ?? require.resolve("./pty-windows-host.cjs");
  }

  spawn(opts: PtyOptions): void {
    this.child = spawn("node", [this.hostScriptPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = createInterface({ input: this.child.stdout! });

    rl.on("line", (line) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        log.error("invalid JSON from host:", line);
        return;
      }

      switch (msg.type) {
        case "pid":
          this._pid = msg.pid as number;
          break;
        case "data": {
          const buf = Buffer.from(msg.data as string, "base64");
          opts.onData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          break;
        }
        case "exit":
          opts.onExit((msg.code as number) ?? 1);
          break;
        case "error":
          log.error("host error:", msg.message);
          break;
      }
    });

    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        log.error(`host process exited with code ${code}`);
      }
      this.child = null;
    });

    this.send({
      type: "spawn",
      command: opts.command,
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
    });
  }

  write(data: string | Uint8Array): void {
    if (!this.child) return;
    const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    this.send({ type: "write", data: buf.toString("base64") });
  }

  resize(cols: number, rows: number): void {
    if (!this.child) return;
    this.send({ type: "resize", cols, rows });
  }

  kill(signal: number = 15): void {
    if (!this.child) return;
    this.send({ type: "kill", signal });
  }

  get pid(): number | undefined {
    return this._pid;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
}
