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
}

export class SessionManager {
  private runners = new Map<string, RunnerInfo>();

  // Allows CLI to inject a custom runner spawn command (e.g., ["./tp", "run"])
  private static runnerCommand: string[] | null = null;

  static setRunnerCommand(cmd: string[]): void {
    SessionManager.runnerCommand = cmd;
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

    // Monitor exit
    proc.exited.then((exitCode) => {
      log.info(`runner exited sid=${sid} exitCode=${exitCode}`);
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
