import { createLogger } from "@teleprompter/protocol";
import type { Subprocess } from "bun";
import { resolve } from "path";

const log = createLogger("SessionManager");

export interface RunnerInfo {
  sid: string;
  pid: number;
  cwd: string;
  worktreePath?: string;
  claudeVersion?: string;
  connectedAt: number;
  process?: Subprocess;
}

export interface SpawnRunnerOptions {
  socketPath?: string;
  worktreePath?: string;
  cols?: number;
  rows?: number;
  claudeArgs?: string[];
  env?: Record<string, string>;
}

/**
 * Called when a spawned Runner process exits — for ANY reason (clean shutdown,
 * crash, or kill). Lets the owner (Daemon) reconcile the session row to
 * "stopped" so a crashed Runner does not leave a phantom "running" session for
 * the rest of the daemon's lifetime.
 */
export type RunnerExitHandler = (sid: string, exitCode: number) => void;

export class SessionManager {
  private runners = new Map<string, RunnerInfo>();
  private onRunnerExit?: RunnerExitHandler;

  // Allows CLI to inject a custom runner spawn command (e.g., ["./tp", "run"])
  private static runnerCommand: string[] | null = null;

  static setRunnerCommand(cmd: string[]): void {
    SessionManager.runnerCommand = cmd;
  }

  /** Register a callback fired when any spawned Runner process exits. */
  setOnRunnerExit(handler: RunnerExitHandler): void {
    this.onRunnerExit = handler;
  }

  registerRunner(
    sid: string,
    pid: number,
    cwd: string,
    worktreePath?: string,
    claudeVersion?: string,
  ): void {
    const existing = this.runners.get(sid);
    this.runners.set(sid, {
      sid,
      pid,
      cwd,
      worktreePath,
      claudeVersion,
      connectedAt: Date.now(),
      process: existing?.process,
    });
    log.info(`registered runner sid=${sid} pid=${pid}`);
  }

  unregisterRunner(sid: string): void {
    this.runners.delete(sid);
    log.info(`unregistered runner sid=${sid}`);
  }

  getRunner(sid: string): RunnerInfo | undefined {
    return this.runners.get(sid);
  }

  listRunners(): RunnerInfo[] {
    return Array.from(this.runners.values());
  }

  get activeCount(): number {
    return this.runners.size;
  }

  private defaultRunnerCommand(): string[] {
    const runnerEntry = resolve(
      import.meta.dir,
      "..",
      "..",
      "..",
      "runner",
      "src",
      "index.ts",
    );
    return ["bun", "run", runnerEntry];
  }

  spawnRunner(sid: string, cwd: string, opts?: SpawnRunnerOptions): Subprocess {
    const baseCmd = SessionManager.runnerCommand ?? this.defaultRunnerCommand();
    const args = [...baseCmd, "--sid", sid, "--cwd", cwd];

    if (opts?.socketPath) {
      args.push("--socket-path", opts.socketPath);
    }
    if (opts?.worktreePath) {
      args.push("--worktree-path", opts.worktreePath);
    }
    if (opts?.cols) {
      args.push("--cols", String(opts.cols));
    }
    if (opts?.rows) {
      args.push("--rows", String(opts.rows));
    }

    // Add "--" separator and claude args
    if (opts?.claudeArgs?.length) {
      args.push("--", ...opts.claudeArgs);
    }

    const proc = Bun.spawn(args, {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });

    // Track the spawned process
    this.runners.set(sid, {
      sid,
      pid: proc.pid,
      cwd,
      worktreePath: opts?.worktreePath,
      connectedAt: Date.now(),
      process: proc,
    });

    log.info(`spawned runner sid=${sid} pid=${proc.pid}`);

    // Monitor exit. A Runner can die without sending a clean "bye" (crash,
    // OOM-kill, kill -9), which previously left the session row stuck at
    // "running" and the in-memory registration leaked for the daemon's
    // lifetime. On ANY exit we unregister and notify the owner to reconcile.
    proc.exited.then((exitCode) => {
      log.info(`runner exited sid=${sid} exitCode=${exitCode}`);
      // Guard against a restart race: session.restart kills the old process
      // and spawns a new one for the same sid. If the new Runner has already
      // re-registered (its `process` differs from the one that just exited),
      // this exit belongs to the old generation — do not tear down the live
      // session.
      const current = this.runners.get(sid);
      if (current && current.process !== proc) return;
      this.runners.delete(sid);
      this.onRunnerExit?.(sid, exitCode ?? 0);
    });

    return proc;
  }

  killRunner(sid: string): boolean {
    const info = this.runners.get(sid);
    if (!info?.process) {
      log.info(`no spawned process for sid=${sid}`);
      return false;
    }

    info.process.kill();
    log.info(`killed runner sid=${sid} pid=${info.pid}`);
    return true;
  }
}
