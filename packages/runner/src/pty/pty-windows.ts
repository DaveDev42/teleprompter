import { createLogger } from "@teleprompter/protocol";
import { type ChildProcess, spawn } from "child_process";
import { join } from "path";
import { createInterface } from "readline";
import type { PtyManager, PtyOptions } from "./pty-manager";

const log = createLogger("PtyWindows");

export class PtyWindows implements PtyManager {
  private child: ChildProcess | null = null;
  private _pid: number | undefined;
  private hostScriptPath: string;

  constructor(hostScriptPath?: string) {
    // Default is empty string — resolved at spawn() time via ensurePtyHost()
    // to avoid require.resolve() / __dirname issues in compiled binaries.
    this.hostScriptPath = hostScriptPath ?? "";
  }

  spawn(opts: PtyOptions): void {
    let exitNotified = false;

    // If no custom host script path (e.g. test override), use the installed path
    if (!this.hostScriptPath) {
      const { ensurePtyHost } =
        require("./pty-host-installer") as typeof import("./pty-host-installer");
      // Use runner package version — npm_package_version is unreliable in compiled binaries
      const { version } = require("../../package.json") as { version: string };
      const hostDir = ensurePtyHost(version);
      this.hostScriptPath = join(hostDir, "pty-windows-host.cjs");
    }

    this.child = spawn("node", [this.hostScriptPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!this.child.stdout) {
      log.error("host process stdout is null");
      return;
    }
    const rl = createInterface({ input: this.child.stdout });

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
          opts.onData(
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          );
          break;
        }
        case "exit":
          exitNotified = true;
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
      // If host crashed without sending an exit message, notify the Runner
      if (!exitNotified) {
        exitNotified = true;
        opts.onExit(code ?? 1);
      }
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
    const buf =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
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
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
}
