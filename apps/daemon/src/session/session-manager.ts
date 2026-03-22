import { resolve, join } from "path";
import { Subprocess } from "bun";

interface RunnerInfo {
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
    console.log(`[SessionManager] registered runner sid=${sid} pid=${pid}`);
  }

  unregisterRunner(sid: string): void {
    this.runners.delete(sid);
    console.log(`[SessionManager] unregistered runner sid=${sid}`);
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

  spawnRunner(sid: string, cwd: string, opts?: SpawnRunnerOptions): Subprocess {
    const runnerEntry = resolve(
      import.meta.dir,
      "..",
      "..",
      "..",
      "runner",
      "src",
      "index.ts",
    );

    const args = ["bun", "run", runnerEntry, "--sid", sid, "--cwd", cwd];

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

    console.log(
      `[SessionManager] spawned runner sid=${sid} pid=${proc.pid}`,
    );

    // Monitor exit
    proc.exited.then((exitCode) => {
      console.log(
        `[SessionManager] runner exited sid=${sid} exitCode=${exitCode}`,
      );
    });

    return proc;
  }

  killRunner(sid: string): boolean {
    const info = this.runners.get(sid);
    if (!info?.process) {
      console.log(`[SessionManager] no spawned process for sid=${sid}`);
      return false;
    }

    info.process.kill();
    console.log(`[SessionManager] killed runner sid=${sid} pid=${info.pid}`);
    return true;
  }
}
