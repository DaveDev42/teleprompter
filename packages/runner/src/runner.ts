import { PtyManager } from "./pty/pty-manager";
import { IpcClient } from "./ipc/client";
import { HookReceiver } from "./hooks/hook-receiver";
import { buildSettings } from "./hooks/settings-builder";
import { Collector } from "./collector";
import { createLogger, type IpcAck, type IpcInput, type IpcResize } from "@teleprompter/protocol";

const log = createLogger("Runner");

type RunnerState =
  | "created"
  | "connecting"
  | "spawning"
  | "running"
  | "stopping"
  | "stopped";

export interface RunnerOptions {
  sid: string;
  cwd: string;
  worktreePath?: string;
  socketPath?: string;
  cols?: number;
  rows?: number;
  claudeArgs?: string[];
}

export class Runner {
  private state: RunnerState = "created";
  private pty = new PtyManager();
  private ipc: IpcClient;
  private hookReceiver: HookReceiver;
  private collector: Collector;
  private opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.collector = new Collector(opts.sid);

    this.ipc = new IpcClient((msg) => {
      this.handleDaemonMessage(msg as IpcAck | IpcInput | IpcResize);
    });

    const hookSocketPath = HookReceiver.defaultSocketPath(opts.sid);
    this.hookReceiver = new HookReceiver(hookSocketPath, (event) => {
      if (this.state === "running") {
        this.ipc.send(this.collector.eventRecord(event));
      }
    });
  }

  async start(): Promise<void> {
    try {
      // Connect to daemon
      this.state = "connecting";
      await this.ipc.connect(this.opts.socketPath);

      // Send hello
      this.ipc.send({
        t: "hello",
        sid: this.opts.sid,
        cwd: this.opts.cwd,
        worktreePath: this.opts.worktreePath,
        pid: process.pid,
      });

      // Start hook receiver
      this.state = "spawning";
      const hookSocketPath = this.hookReceiver.start();

      // Build settings with hook capture commands
      const settingsJson = buildSettings(hookSocketPath, this.opts.cwd);

      // Spawn Claude Code in PTY
      const claudeCmd = [
        "claude",
        "--settings",
        settingsJson,
        ...(this.opts.claudeArgs ?? []),
      ];

      this.pty.spawn({
        command: claudeCmd,
        cwd: this.opts.cwd,
        cols: this.opts.cols,
        rows: this.opts.rows,
        onData: (data) => {
          if (this.state === "running") {
            this.ipc.send(this.collector.ioRecord(data));
          }
        },
        onExit: (exitCode) => {
          this.stop(exitCode);
        },
      });

      this.state = "running";
      log.info(`started sid=${this.opts.sid} pid=${this.pty.pid}`);
    } catch (err) {
      this.state = "stopped";
      throw err;
    }
  }

  private stop(exitCode: number): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    this.state = "stopping";

    log.info(`stopping sid=${this.opts.sid} exitCode=${exitCode}`);

    // Send bye to daemon
    this.ipc.send({
      t: "bye",
      sid: this.opts.sid,
      exitCode,
    });

    // Cleanup
    this.hookReceiver.stop();
    this.ipc.close();
    this.state = "stopped";
  }

  private handleDaemonMessage(msg: IpcAck | IpcInput | IpcResize): void {
    switch (msg.t) {
      case "ack":
        // Informational only, no action needed
        break;
      case "input":
        this.pty.write(Buffer.from(msg.data, "base64"));
        break;
      case "resize":
        this.pty.resize(msg.cols, msg.rows);
        break;
    }
  }
}
