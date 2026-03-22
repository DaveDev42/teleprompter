interface RunnerInfo {
  sid: string;
  pid: number;
  cwd: string;
  worktreePath?: string;
  claudeVersion?: string;
  connectedAt: number;
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
    this.runners.set(sid, {
      sid,
      pid,
      cwd,
      worktreePath,
      claudeVersion,
      connectedAt: Date.now(),
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
}
