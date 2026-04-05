import type {
  IpcBye,
  IpcHello,
  IpcRec,
  Namespace,
  RecordKind,
  WsRec,
  WsSessionMeta,
} from "@teleprompter/protocol";
import { createLogger } from "@teleprompter/protocol";
import { IpcServer } from "./ipc/server";
import {
  type RunnerInfo,
  SessionManager,
  type SpawnRunnerOptions,
} from "./session/session-manager";
import { Store } from "./store";
import type { StoredRecord } from "./store/session-db";
import type { SessionMeta } from "./store/store";
import type { WsClient } from "./transport/client-registry";
import { ClientRegistry } from "./transport/client-registry";
import { RelayClient, type RelayClientConfig } from "./transport/relay-client";
import { WsServer } from "./transport/ws-server";
import { WorktreeManager } from "./worktree/worktree-manager";

const log = createLogger("Daemon");

const DEFAULT_PRUNE_TTL_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class Daemon {
  private ipcServer: IpcServer;
  private store: Store;
  private sessionManager = new SessionManager();
  private clientRegistry = new ClientRegistry();
  private wsServer: WsServer;
  private relayClients: RelayClient[] = [];
  private worktreeManager: WorktreeManager | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storeDir?: string) {
    this.store = new Store(storeDir);

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
        const sessions = this.store.listSessions().map(toWsSessionMeta);
        this.clientRegistry.send(client, { t: "hello", v: 1, d: { sessions } });
      },
      onAttach: (client, sid) => {
        this.clientRegistry.attach(client, sid);
        const meta = this.store.getSession(sid);
        if (meta) {
          this.clientRegistry.send(client, {
            t: "state",
            sid,
            d: toWsSessionMeta(meta),
          });
        } else {
          this.clientRegistry.send(client, {
            t: "err",
            e: "NOT_FOUND",
            m: `Session ${sid} not found`,
          });
        }
      },
      onDetach: (client, sid) => {
        this.clientRegistry.detach(client, sid);
      },
      onResume: (client, sid, cursor) => {
        this.handleResume(client, sid, cursor);
      },
      onInChat: (client, sid, text) => {
        this.handleWsInput(
          client,
          sid,
          Buffer.from(`${text}\n`).toString("base64"),
        );
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
      onSessionRestart: (client, sid) => {
        this.handleSessionRestart(client, sid);
      },
      onSessionExport: (client, sid, format) => {
        this.handleSessionExport(client, sid, format);
      },
    });
  }

  private socketPath: string = "";

  start(socketPath?: string): string {
    // Mark stale "running" sessions as stopped (from previous daemon run)
    const stale = this.store
      .listSessions()
      .filter((s) => s.state === "running");
    for (const s of stale) {
      this.store.updateSessionState(s.sid, "stopped");
      log.info(`marked stale session as stopped: ${s.sid}`);
    }

    this.socketPath = this.ipcServer.start(socketPath);
    log.info("started");
    return this.socketPath;
  }

  /**
   * Start automatic session cleanup.
   * Prunes immediately on call, then every 24 hours.
   * @param ttlDays Days to keep stopped/error sessions (default: 7, env: TP_PRUNE_TTL_DAYS)
   */
  startAutoCleanup(ttlDays?: number): void {
    const days =
      ttlDays ??
      (process.env.TP_PRUNE_TTL_DAYS
        ? Number(process.env.TP_PRUNE_TTL_DAYS)
        : DEFAULT_PRUNE_TTL_DAYS);
    const maxAgeMs = days * 24 * 60 * 60 * 1000;

    // Prune immediately on startup
    const pruned = this.store.pruneOldSessions(maxAgeMs);
    if (pruned > 0) {
      log.info(`pruned ${pruned} old session(s) (>${days}d)`);
    }

    // Schedule periodic cleanup
    this.stopAutoCleanup();
    this.pruneTimer = setInterval(() => {
      const n = this.store.pruneOldSessions(maxAgeMs);
      if (n > 0) {
        log.info(`periodic prune: removed ${n} session(s) (>${days}d)`);
      }
    }, PRUNE_INTERVAL_MS);

    // Don't keep the process alive just for cleanup
    this.pruneTimer.unref();
  }

  /**
   * Stop the automatic cleanup scheduler.
   */
  stopAutoCleanup(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
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
   * Connect to a Relay server for remote frontend access.
   * Multiple relays can be connected simultaneously.
   * Pairing data is persisted to store for auto-reconnect on restart.
   */
  async connectRelay(config: RelayClientConfig): Promise<RelayClient> {
    const client = new RelayClient(config, {
      onInput: (_sid, data) => {
        // Relay input from remote frontend → runner
        const runner = this.ipcServer.findRunnerBySid(_sid);
        if (runner) {
          this.ipcServer.send(runner, { t: "input", sid: _sid, data });
        }
      },
      onFrontendJoined: (frontendId) => {
        // Send session list to newly connected frontend (like WS hello)
        const sessions = this.store.listSessions().map(toWsSessionMeta);
        const helloMsg = { t: "hello", v: 1, d: { sessions } };
        client.publishToPeer(frontendId, "__meta__", helloMsg).catch(() => {});

        // Subscribe all running sessions so the frontend gets records
        for (const s of sessions) {
          if (s.state === "running") {
            client.subscribe(s.sid);
          }
        }
      },
    });

    await client.connect();

    // Subscribe to meta channel and all existing sessions
    client.subscribe("__meta__");
    for (const meta of this.store.listSessions()) {
      if (meta.state === "running") {
        client.subscribe(meta.sid);
      }
    }

    // Persist pairing data for auto-reconnect on daemon restart
    this.store.savePairing({
      daemonId: config.daemonId,
      relayUrl: config.relayUrl,
      relayToken: config.token,
      registrationProof: config.registrationProof,
      publicKey: config.keyPair.publicKey,
      secretKey: config.keyPair.secretKey,
      pairingSecret: config.pairingSecret,
    });

    this.relayClients.push(client);
    return client;
  }

  /**
   * Reconnect to all saved relay pairings from store.
   * Called on daemon startup to restore relay connections.
   */
  async reconnectSavedRelays(): Promise<number> {
    const pairings = this.store.loadPairings();
    let count = 0;
    for (const p of pairings) {
      try {
        await this.connectRelay({
          relayUrl: p.relayUrl,
          daemonId: p.daemonId,
          token: p.relayToken,
          registrationProof: p.registrationProof,
          keyPair: { publicKey: p.publicKey, secretKey: p.secretKey },
          pairingSecret: p.pairingSecret,
        });
        count++;
        log.info(`reconnected to relay ${p.relayUrl} (daemon ${p.daemonId})`);
      } catch (err) {
        log.error(`failed to reconnect to relay ${p.relayUrl}:`, err);
      }
    }
    return count;
  }

  createSession(sid: string, cwd: string, opts?: SpawnRunnerOptions): void {
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

  private handleHello(_runner: unknown, msg: IpcHello): void {
    this.store.createSession(
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

    // Notify WS clients + relay of new session
    const meta = this.store.getSession(msg.sid);
    if (meta) {
      const stateMsg = {
        t: "state" as const,
        sid: msg.sid,
        d: toWsSessionMeta(meta),
      };
      this.clientRegistry.sendAll(stateMsg);
      for (const relay of this.relayClients) {
        relay.publishState("__meta__", stateMsg).catch(() => {});
      }
    }
  }

  private handleRec(
    runner: Parameters<IpcServer["send"]>[0],
    msg: IpcRec,
  ): void {
    const db = this.store.getSessionDb(msg.sid);
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

    this.store.updateLastSeq(msg.sid, seq);

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

  private handleBye(msg: IpcBye): void {
    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.store.updateSessionState(msg.sid, state);
    this.sessionManager.unregisterRunner(msg.sid);
    log.info(
      `session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`,
    );

    // Notify WS clients + relay of session state change
    const meta = this.store.getSession(msg.sid);
    if (meta) {
      const stateMsg = {
        t: "state" as const,
        sid: msg.sid,
        d: toWsSessionMeta(meta),
      };
      this.clientRegistry.sendAll(stateMsg);
      for (const relay of this.relayClients) {
        relay.publishState("__meta__", stateMsg).catch(() => {});
      }
    }
  }

  private handleResume(client: WsClient, sid: string, cursor: number): void {
    const db = this.store.getSessionDb(sid);
    if (!db) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NOT_FOUND",
        m: `Session ${sid} not found`,
      });
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

  private handleWsInput(
    client: WsClient,
    sid: string,
    base64Data: string,
  ): void {
    const runner = this.ipcServer.findRunnerBySid(sid);
    if (!runner) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NO_RUNNER",
        m: `No runner for session ${sid}`,
      });
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
      const wtPath = path ?? `${branch}-${Date.now().toString(36)}`;
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

  private handleSessionRestart(client: WsClient, sid: string): void {
    const session = this.store.getSession(sid);
    if (!session) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NOT_FOUND",
        m: `Session ${sid} not found`,
      });
      return;
    }

    // Kill existing runner if still running
    this.sessionManager.killRunner(sid);

    // Re-create the session with the same cwd and worktree
    try {
      this.createSession(sid, session.cwd, {
        worktreePath: session.worktree_path ?? undefined,
      });
      log.info(`restarted session ${sid}`);
    } catch (err) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "SESSION_ERROR",
        m: err instanceof Error ? err.message : "Failed to restart session",
      });
    }
  }

  private handleSessionExport(
    client: WsClient,
    sid: string,
    format?: string,
  ): void {
    const session = this.store.getSession(sid);
    if (!session) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NOT_FOUND",
        m: `Session ${sid} not found`,
      });
      return;
    }

    const db = this.store.getSessionDb(sid);
    if (!db) {
      this.clientRegistry.send(client, {
        t: "err",
        e: "NOT_FOUND",
        m: `Session DB for ${sid} not found`,
      });
      return;
    }

    const records = db.getRecordsFrom(0, 10000);
    const meta = toWsSessionMeta(session);

    if (format === "markdown") {
      const lines: string[] = [];
      lines.push(`# Session: ${sid}`);
      lines.push(`- CWD: ${meta.cwd}`);
      lines.push(`- State: ${meta.state}`);
      lines.push(`- Created: ${new Date(meta.createdAt).toISOString()}`);
      lines.push("");

      for (const rec of records) {
        const payload = Buffer.from(rec.payload).toString("utf-8");
        if (rec.kind === "event" && rec.name) {
          lines.push(`## ${rec.name}`);
          try {
            const data = JSON.parse(Buffer.from(payload, "base64").toString());
            if (data.last_assistant_message) {
              lines.push(data.last_assistant_message);
            } else if (data.prompt) {
              lines.push(`> ${data.prompt}`);
            } else {
              lines.push(
                `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
              );
            }
          } catch {
            lines.push(payload);
          }
          lines.push("");
        }
      }

      this.clientRegistry.send(client, {
        t: "session.exported" as const,
        sid,
        format: "markdown" as const,
        d: lines.join("\n"),
      });
    } else {
      this.clientRegistry.send(client, {
        t: "session.exported" as const,
        sid,
        format: "json" as const,
        d: JSON.stringify({ meta, records }),
      });
    }
  }

  /** Get the WebSocket server port (for tests) */
  get wsPort(): number | undefined {
    return this.wsServer.port;
  }

  /** Get a runner by session ID (for passthrough mode) */
  getRunner(sid: string): RunnerInfo | undefined {
    return this.sessionManager.getRunner(sid);
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

    this.stopAutoCleanup();
    for (const relay of this.relayClients) {
      relay.dispose();
    }
    this.relayClients = [];
    this.wsServer.stop();
    this.ipcServer.stop();
    this.store.close();
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
