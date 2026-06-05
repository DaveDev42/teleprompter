import {
  createLogger,
  type IpcAck,
  type IpcInput,
  type IpcResize,
} from "@teleprompter/protocol";
import { Collector } from "./collector";
import { HookReceiver } from "./hooks/hook-receiver";
import { buildSettings } from "./hooks/settings-builder";
import { IpcClient } from "./ipc/client";
import { createPtyManager, type PtyManager } from "./pty/pty-manager";

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
  private pty: PtyManager = createPtyManager();
  private ipc: IpcClient;
  private hookReceiver: HookReceiver;
  private collector: Collector;
  private opts: RunnerOptions;

  /**
   * Tracks which subsystems have been started so the error path in start()
   * can clean up exactly what was initialised without crashing on components
   * that were never started.
   */
  private ipcConnected = false;
  private hookReceiverStarted = false;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.collector = new Collector(opts.sid);

    // IpcClient's MessageHandler already types `msg` as IpcAck | IpcInput |
    // IpcResize — the same union handleDaemonMessage accepts — so no cast.
    // The onClose callback triggers a stop() when the IPC socket is torn down
    // (e.g. queue overflow), so the session is not silently orphaned.
    this.ipc = new IpcClient(
      (msg) => {
        this.handleDaemonMessage(msg);
      },
      () => {
        this.stop(-1);
      },
    );

    const hookSocketPath = HookReceiver.defaultSocketPath(opts.sid);
    this.hookReceiver = new HookReceiver(hookSocketPath, (event) => {
      // Forward every hook claude emits while the IPC channel is up. We
      // deliberately accept events during "spawning" because claude's
      // SessionStart fires before the PTY has produced the first byte that
      // would flip us to "running". Dropping during stop/stopped prevents
      // races with daemon teardown.
      if (this.state === "stopping" || this.state === "stopped") return;
      log.info(`forwarding hook ${event.hook_event_name} to daemon`);
      this.ipc.send(this.collector.eventRecord(event));
    });
  }

  async start(): Promise<void> {
    try {
      // Connect to daemon
      this.state = "connecting";
      await this.ipc.connect(this.opts.socketPath);
      this.ipcConnected = true;

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
      this.hookReceiverStarted = true;

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
            const io = this.collector.ioRecord(data);
            this.ipc.send(io.msg, io.binary);
          }
        },
        onExit: (exitCode) => {
          this.stop(exitCode);
        },
      });

      this.state = "running";
      log.info(`started sid=${this.opts.sid} pid=${this.pty.pid}`);
    } catch (err) {
      // Clean up whatever was already started before re-throwing so we don't
      // leak the hook receiver unix socket or the IPC connection. Each guard
      // is idempotent: stop()/close() are safe to call even if the underlying
      // resource was only partially initialised.
      //
      // Set state to "stopped" first so the IPC onClose callback (which calls
      // this.stop()) becomes a no-op and does not attempt a double-cleanup.
      log.error("start failed, cleaning up:", err);
      this.state = "stopped";
      if (this.hookReceiverStarted) {
        try {
          this.hookReceiver.stop();
        } catch (cleanupErr) {
          log.error(
            "hookReceiver.stop() failed during error cleanup:",
            cleanupErr,
          );
        }
      }
      if (this.ipcConnected) {
        try {
          this.ipc.close();
        } catch (cleanupErr) {
          log.error("ipc.close() failed during error cleanup:", cleanupErr);
        }
      }
      this.pty.kill();
      throw err;
    }
  }

  stop(exitCode: number): void {
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
