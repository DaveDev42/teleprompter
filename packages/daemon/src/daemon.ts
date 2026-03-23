import { IpcServer } from "./ipc/server";
import { Vault } from "./vault";
import { SessionManager, type SpawnRunnerOptions } from "./session/session-manager";
import { ClientRegistry } from "./transport/client-registry";
import { WsServer } from "./transport/ws-server";
import { RelayClient, type RelayClientConfig } from "./transport/relay-client";
import { WorktreeManager } from "./worktree/worktree-manager";
import { createLogger } from "@teleprompter/protocol";
import type {
  IpcHello,
  IpcRec,
  IpcBye,
  Namespace,
  RecordKind,
  WsSessionMeta,
  WsRec,
} from "@teleprompter/protocol";
import type { SessionMeta } from "./vault/vault";
import type { StoredRecord } from "./vault/session-db";
import type { WsClient } from "./transport/client-registry";

const log = createLogger("Daemon");

export class Daemon {
  private ipcServer: IpcServer;
  private vault: Vault;
  private sessionManager = new SessionManager();
  private clientRegistry = new ClientRegistry();
  private wsServer: WsServer;
  private relayClients: RelayClient[] = [];
  private worktreeManager: WorktreeManager | null = null;

  constructor(vaultDir?: string) {
    this.vault = new Vault(vaultDir);

    this.ipcServer = new IpcServer({
      onConnect: (_runner) => {
        log.info("runner connected");
      },
      onDisconnect: (runner) => {
        if (runner.sid) {
          log.info(`runner disconnected sid=${runner.sid}`);
        }
      },
      onMessage: (runner, msg) => {
        this.handleMessage(runner, msg);
      },
    });

    this.wsServer = new WsServer(this.clientRegistry, {
      onHello: (client) => {
        const sessions = this.vault.listSessions().map(toWsSessionMeta);
        this.clientRegistry.send(client, { t: "hello", d: { sessions } });
      },
      onAttach: (client, sid) => {
        this.clientRegistry.attach(client, sid);
        const meta = this.vault.getSession(sid);
        if (meta) {
          this.clientRegistry.send(client, { t: "state", sid, d: toWsSessionMeta(meta) });
        } else {
          this.clientRegistry.send(client, { t: "err", e: "NOT_FOUND", m: `Session ${sid} not found` });
        }
      },
      onDetach: (client, sid) => {
        this.clientRegistry.detach(client, sid);
      },
      onResume: (client, sid, cursor) => {
        this.handleResume(client, sid, cursor);
      },
      onInChat: (client, sid, text) => {
        this.handleWsInput(client, sid, Buffer.from(text + "\n").toString("base64"));
      },
      onInTerm: (client, sid, data) => {
        this.handleWsInput(client, sid, data);
      },
      onResize: (_client, sid, cols, rows) => {
        const runner = this.ipcServer.findRunnerBySid(sid);
        if (runner) {
          this.ipcServer.send(runner, { t: "resize", sid, cols, rows });
        }
      },
      onWorktreeCreate: (client, msg) => {
        this.handleWorktreeCreate(client, msg.branch, msg.baseBranch, msg.path);
      },
      onWorktreeRemove: (client, msg) => {
        this.handleWorktreeRemove(client, msg.path, msg.force);
      },
      onWorktreeList: (client) => {
        this.handleWorktreeList(client);
      },
      onSessionCreate: (client, msg) => {
        this.handleSessionCreate(client, msg.cwd, msg.sid);
      },
      onSessionStop: (client, sid) => {
        this.handleSessionStop(client, sid);
      },
    });
  }

  private socketPath: string = "";

  start(socketPath?: string): string {
    // Mark stale "running" sessions as stopped (from previous daemon run)
    const stale = this.vault.listSessions().filter((s) => s.state === "running");
    for (const s of stale) {
      this.vault.updateSessionState(s.sid, "stopped");
      log.info(`marked stale session as stopped: ${s.sid}`);
    }

    this.socketPath = this.ipcServer.start(socketPath);
    log.info("started");
    return this.socketPath;
  }

  startWs(port: number): void {
    this.wsServer.start(port);
  }

  /**
   * Set the directory for serving the frontend web build.
   * Enables accessing the frontend at http://localhost:<ws-port>/
   */
  setWebDir(dir: string): void {
    this.wsServer.setWebDir(dir);
  }

  /**
   * Prune stopped/error sessions older than maxAgeMs.
   * Returns the number of sessions deleted.
   */
  pruneOldSessions(maxAgeMs: number): number {
    return this.vault.pruneOldSessions(maxAgeMs);
  }

  /**
   * Connect to a Relay server for remote frontend access.
   * Multiple relays can be connected simultaneously.
   */
  async connectRelay(config: RelayClientConfig): Promise<RelayClient> {
    const client = new RelayClient(config, {
      onInput: (_sid, data) => {
        // Relay input from remote frontend → runner
        // data is base64 encoded
        const runner = this.ipcServer.findRunnerBySid(_sid);
        if (runner) {
          this.ipcServer.send(runner, { t: "input", sid: _sid, data });
        }
      },
      onRecord: (_rec) => {
        // Remote frontend sends records (unusual but possible)
      },
    });

    await client.connect();

    // Subscribe to all existing sessions
    for (const meta of this.vault.listSessions()) {
      if (meta.state === "running") {
        client.subscribe(meta.sid);
      }
    }

    this.relayClients.push(client);
    return client;
  }

  createSession(
    sid: string,
    cwd: string,
    opts?: SpawnRunnerOptions,
  ): void {
    this.sessionManager.spawnRunner(sid, cwd, {
      ...opts,
      socketPath: this.socketPath,
    });
  }

  private handleMessage(
    runner: Parameters<IpcServer["send"]>[0],
    msg: IpcHello | IpcRec | IpcBye,
  ): void {
    switch (msg.t) {
      case "hello":
        this.handleHello(runner, msg);
        break;
      case "rec":
        this.handleRec(runner, msg);
        break;
      case "bye":
        this.handleBye(msg);
        break;
    }
  }

  private handleHello(
    _runner: unknown,
    msg: IpcHello,
  ): void {
    this.vault.createSession(
      msg.sid,
      msg.cwd,
      msg.worktreePath,
      msg.claudeVersion,
    );
    this.sessionManager.registerRunner(
      msg.sid,
      msg.pid,
      msg.cwd,
      msg.worktreePath,
      msg.claudeVersion,
    );
    log.info(`session created sid=${msg.sid}`);

    // Subscribe relay clients to the new session
    for (const relay of this.relayClients) {
      relay.subscribe(msg.sid);
    }

    // Notify WS clients of new session
    const meta = this.vault.getSession(msg.sid);
    if (meta) {
      this.clientRegistry.sendAll({ t: "state", sid: msg.sid, d: toWsSessionMeta(meta) });
    }
  }

  private handleRec(
    runner: Parameters<IpcServer["send"]>[0],
    msg: IpcRec,
  ): void {
    const db = this.vault.getSessionDb(msg.sid);
    if (!db) {
      log.error(`unknown session sid=${msg.sid}`);
      return;
    }

    const payload = Buffer.from(msg.payload, "base64");
    const seq = db.append(
      msg.kind as RecordKind,
      msg.ts,
      payload,
      msg.ns as Namespace | undefined,
      msg.name,
    );

    this.vault.updateLastSeq(msg.sid, seq);

    // Send ack (informational, non-blocking)
    this.ipcServer.send(runner, {
      t: "ack",
      sid: msg.sid,
      seq,
    });

    // Fan out to WS clients subscribed to this session
    const wsRec: WsRec = {
      t: "rec",
      sid: msg.sid,
      seq,
      k: msg.kind as RecordKind,
      ns: msg.ns as Namespace | undefined,
      n: msg.name,
      d: msg.payload, // already base64
      ts: msg.ts,
    };
    this.clientRegistry.broadcast(msg.sid, wsRec);

    // Also publish to relay(s) for remote frontends
    for (const relay of this.relayClients) {
      relay.publishRecord(wsRec).catch(() => {});
    }
  }

  /**
   * Emit a teleprompter-internal event (tp namespace).
   * Stored in vault and broadcast to WS/relay clients.
   */
  private emitTpEvent(sid: string, name: string, data: unknown): void {
    const db = this.vault.getSessionDb(sid);
    if (!db) return;

    const payload = Buffer.from(JSON.stringify(data)).toString("base64");
    const seq = db.append("event" as RecordKind, Date.now(), Buffer.from(payload), "tp" as Namespace, name);
    this.vault.updateLastSeq(sid, seq);

    const wsRec: WsRec = {
      t: "rec", sid, seq, k: "event" as RecordKind,
      ns: "tp" as Namespace, n: name, d: payload, ts: Date.now(),
    };
    this.clientRegistry.broadcast(sid, wsRec);
    for (const relay of this.relayClients) {
      relay.publishRecord(wsRec).catch(() => {});
    }
  }

  private handleBye(msg: IpcBye): void {
    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.vault.updateSessionState(msg.sid, state);
    this.sessionManager.unregisterRunner(msg.sid);
    log.info(`session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`);

    // Notify WS clients of session state change
    const meta = this.vault.getSession(msg.sid);
    if (meta) {
      this.clientRegistry.sendAll({ t: "state", sid: msg.sid, d: toWsSessionMeta(meta) });
    }
  }

  private handleResume(client: WsClient, sid: string, cursor: number): void {
    const db = this.vault.getSessionDb(sid);
    if (!db) {
      this.clientRegistry.send(client, { t: "err", e: "NOT_FOUND", m: `Session ${sid} not found` });
      return;
    }

    const records = db.getRecordsFrom(cursor);
    const wsRecs: WsRec[] = records.map((r: StoredRecord) => ({
      t: "rec" as const,
      sid,
      seq: r.seq,
      k: r.kind,
      ns: (r.ns as Namespace) ?? undefined,
      n: r.name ?? undefined,
      d: Buffer.from(r.payload).toString("base64"),
      ts: r.ts,
    }));

    this.clientRegistry.send(client, { t: "batch", sid, d: wsRecs });
  }

  private handleWsInput(client: WsClient, sid: string, base64Data: string): void {
    const runner = this.ipcServer.findRunnerBySid(sid);
    if (!runner) {
      this.clientRegistry.send(client, { t: "err", e: "NO_RUNNER", m: `No runner for session ${sid}` });
      return;
    }

    this.ipcServer.send(runner, {
      t: "input",
      sid,
      data: base64Data,
    });
  }

  /**
   * Set the repository root for worktree management.
   */
  setRepoRoot(repoRoot: string): void {
    this.worktreeManager = new WorktreeManager(repoRoot);
  }

  private async handleWorktreeList(client: WsClient): Promise<void> {
    if (!this.worktreeManager) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NO_REPO",
        m: "No repository configured for worktree management",
      });
      return;
    }

    try {
      const worktrees = await this.worktreeManager.list();
      this.clientRegistry.send(client, {
        t: "worktree.list",
        d: worktrees,
      });
    } catch (err) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "WORKTREE_ERROR",
        m: err instanceof Error ? err.message : "Failed to list worktrees",
      });
    }
  }

  private async handleWorktreeCreate(
    client: WsClient,
    branch: string,
    baseBranch?: string,
    path?: string,
  ): Promise<void> {
    if (!this.worktreeManager) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NO_REPO",
        m: "No repository configured",
      });
      return;
    }

    try {
      const wtPath =
        path ?? `${branch}-${Date.now().toString(36)}`;
      const wt = await this.worktreeManager.add(wtPath, branch, baseBranch);

      // Auto-create a session in the new worktree
      const sid = `${branch}-${Date.now().toString(36)}`;
      this.createSession(sid, wt.path, { worktreePath: wt.path });

      this.clientRegistry.send(client, {
        t: "worktree.created",
        d: wt,
        sid,
      });
    } catch (err) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "WORKTREE_ERROR",
        m: err instanceof Error ? err.message : "Failed to create worktree",
      });
    }
  }

  private async handleWorktreeRemove(
    client: WsClient,
    path: string,
    force?: boolean,
  ): Promise<void> {
    if (!this.worktreeManager) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NO_REPO",
        m: "No repository configured",
      });
      return;
    }

    try {
      await this.worktreeManager.remove(path, force);
      this.clientRegistry.send(client, {
        t: "worktree.removed",
        path,
      });
    } catch (err) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "WORKTREE_ERROR",
        m: err instanceof Error ? err.message : "Failed to remove worktree",
      });
    }
  }

  private handleSessionCreate(
    client: WsClient,
    cwd: string,
    sid?: string,
  ): void {
    const sessionId = sid ?? `session-${Date.now().toString(36)}`;
    try {
      this.createSession(sessionId, cwd);
      // Session state will be broadcast via handleHello when runner connects
    } catch (err) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "SESSION_ERROR",
        m: err instanceof Error ? err.message : "Failed to create session",
      });
    }
  }

  private handleSessionStop(client: WsClient, sid: string): void {
    if (!this.sessionManager.killRunner(sid)) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NO_RUNNER",
        m: `No runner for session ${sid}`,
      });
    }
    // Session end will be handled by handleBye when the process exits
  }

  stop(): void {
    // Kill all running sessions gracefully
    const runners = this.sessionManager.listRunners();
    let killed = 0;
    for (const runner of runners) {
      if (this.sessionManager.killRunner(runner.sid)) {
        killed++;
      }
    }
    if (killed > 0) {
      log.info(`killed ${killed} running session(s)`);
    }

    for (const relay of this.relayClients) {
      relay.dispose();
    }
    this.relayClients = [];
    this.wsServer.stop();
    this.ipcServer.stop();
    this.vault.close();
    log.info("stopped");
  }
}

function toWsSessionMeta(meta: SessionMeta): WsSessionMeta {
  return {
    sid: meta.sid,
    state: meta.state,
    cwd: meta.cwd,
    worktreePath: meta.worktree_path ?? undefined,
    claudeVersion: meta.claude_version ?? undefined,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    lastSeq: meta.last_seq,
  };
}
