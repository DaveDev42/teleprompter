import type {
  IpcBye,
  IpcHello,
  IpcRec,
  Namespace,
  RecordKind,
  WsRec,
  WsSessionMeta,
} from "@teleprompter/protocol";
import {
  createLogger,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
} from "@teleprompter/protocol";
import { formatMarkdown } from "./export-formatter";
import { IpcServer } from "./ipc/server";
import { PushNotifier } from "./push/push-notifier";
import {
  type RunnerInfo,
  SessionManager,
  type SpawnRunnerOptions,
} from "./session/session-manager";
import { Store } from "./store";
import type { StoredRecord } from "./store/session-db";
import type { SessionMeta } from "./store/store";
import { RelayClient, type RelayClientConfig } from "./transport/relay-client";
import { WorktreeManager } from "./worktree/worktree-manager";

const log = createLogger("Daemon");

const DEFAULT_PRUNE_TTL_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class Daemon {
  private ipcServer: IpcServer;
  private store: Store;
  private sessionManager = new SessionManager();
  private relayClients: RelayClient[] = [];
  private worktreeManager: WorktreeManager | null = null;
  private pushNotifier: PushNotifier;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Local record observer for passthrough CLI (pipes PTY io to process.stdout).
   * Only one observer is supported; assigning a second overwrites the first.
   */
  onRecord:
    | ((sid: string, kind: string, payload: Buffer, name?: string) => void)
    | null = null;

  constructor(storeDir?: string) {
    this.store = new Store(storeDir);

    this.pushNotifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        for (const relay of this.relayClients) {
          relay.sendPush(frontendId, token, title, body, data);
        }
      },
    });

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

  /**
   * Connect to a Relay server for remote frontend access.
   * Multiple relays can be connected simultaneously.
   * Pairing data is persisted to store for auto-reconnect on restart.
   */
  async connectRelay(config: RelayClientConfig): Promise<RelayClient> {
    const client = new RelayClient(config, {
      onInput: (kind, _sid, data) => {
        // Relay input from remote frontend → runner
        const runner = this.ipcServer.findRunnerBySid(_sid);
        if (runner) {
          // Chat input needs newline appended (matching WS onInChat behavior)
          const payload =
            kind === "chat"
              ? Buffer.from(`${data}\n`).toString("base64")
              : data;
          this.ipcServer.send(runner, { t: "input", sid: _sid, data: payload });
        }
      },
      onControlMessage: (msg, frontendId) => {
        this.handleRelayControlMessage(client, msg, frontendId);
      },
      onFrontendJoined: (frontendId) => {
        // Send session list to newly connected frontend (like WS hello)
        const sessions = this.store.listSessions().map(toWsSessionMeta);
        const helloMsg = { t: "hello", v: 1, d: { sessions } };
        client
          .publishToPeer(frontendId, RELAY_CHANNEL_META, helloMsg)
          .catch(() => {});

        // Subscribe all running sessions so the frontend gets records
        for (const s of sessions) {
          if (s.state === "running") {
            client.subscribe(s.sid);
          }
        }
      },
      onPushToken: (frontendId, token, platform) => {
        this.pushNotifier.registerToken(frontendId, token, platform);
      },
    });

    client.onUnpair = ({ frontendId, reason }) => {
      log.info(
        `peer unpaired (daemonId=${config.daemonId}, frontendId=${frontendId}, reason=${reason}); removing pairing`,
      );
      this.removePairing(config.daemonId, { notifyPeer: false }).catch(
        (err) => {
          log.error(
            `removePairing failed after inbound unpair (daemonId=${config.daemonId}):`,
            err,
          );
        },
      );
    };

    client.onRename = ({ frontendId, label }) => {
      log.info(
        `peer renamed pairing (daemonId=${config.daemonId}, frontendId=${frontendId}) → "${label}"`,
      );
      try {
        this.store.updatePairingLabel(config.daemonId, label || null);
      } catch (err) {
        log.error(
          `updatePairingLabel failed after inbound rename (daemonId=${config.daemonId}):`,
          err,
        );
      }
    };

    await client.connect();

    // Subscribe to meta, control, and all existing sessions
    client.subscribe(RELAY_CHANNEL_META);
    client.subscribe(RELAY_CHANNEL_CONTROL);
    for (const meta of this.store.listSessions()) {
      if (meta.state === "running") {
        client.subscribe(meta.sid);
      }
    }

    // Persist pairing data for auto-reconnect on daemon restart.
    // Preserve any existing label if the caller didn't supply one, so
    // reconnecting saved relays doesn't overwrite a user-set label.
    const existingLabel =
      this.store
        .listPairings()
        .find((p) => p.daemonId === config.daemonId)?.label ?? null;
    this.store.savePairing({
      daemonId: config.daemonId,
      relayUrl: config.relayUrl,
      relayToken: config.token,
      registrationProof: config.registrationProof,
      publicKey: config.keyPair.publicKey,
      secretKey: config.keyPair.secretKey,
      pairingSecret: config.pairingSecret,
      label: config.label ?? existingLabel,
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
          label: p.label,
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

  /** Send raw terminal input bytes to a running session's PTY (via Runner IPC). */
  sendInput(sid: string, data: Buffer): void {
    const runner = this.ipcServer.findRunnerBySid(sid);
    if (runner) {
      this.ipcServer.send(runner, {
        t: "input",
        sid,
        data: data.toString("base64"),
      });
    }
  }

  /** Resize a running session's PTY (via Runner IPC). */
  resizeSession(sid: string, cols: number, rows: number): void {
    const runner = this.ipcServer.findRunnerBySid(sid);
    if (runner) {
      this.ipcServer.send(runner, { t: "resize", sid, cols, rows });
    }
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

    // Notify relay of new session
    const meta = this.store.getSession(msg.sid);
    if (meta) {
      const stateMsg = {
        t: "state" as const,
        sid: msg.sid,
        d: toWsSessionMeta(meta),
      };
      for (const relay of this.relayClients) {
        relay.publishState(RELAY_CHANNEL_META, stateMsg).catch(() => {});
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

    // Publish to relay(s) for remote frontends
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
    for (const relay of this.relayClients) {
      relay.publishRecord(wsRec).catch(() => {});
    }

    // Notify local observer (passthrough CLI pipes io records to stdout).
    if (this.onRecord) {
      this.onRecord(msg.sid, msg.kind, payload, msg.name);
    }

    // Check if this record should trigger a push notification
    this.pushNotifier.onRecord({
      sid: msg.sid,
      kind: msg.kind,
      name: msg.name,
      ns: msg.ns,
    });
  }

  private handleBye(msg: IpcBye): void {
    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.store.updateSessionState(msg.sid, state);
    this.sessionManager.unregisterRunner(msg.sid);
    log.info(
      `session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`,
    );

    // Notify relay of session state change
    const meta = this.store.getSession(msg.sid);
    if (meta) {
      const stateMsg = {
        t: "state" as const,
        sid: msg.sid,
        d: toWsSessionMeta(meta),
      };
      for (const relay of this.relayClients) {
        relay.publishState(RELAY_CHANNEL_META, stateMsg).catch(() => {});
      }
    }
  }

  /**
   * Handle control messages from a remote frontend via relay.
   * Mirrors the WS server handlers but sends responses back through relay.
   *
   * Note: `control.unpair` is intercepted earlier in
   * RelayClient.decryptAndDispatch and never reaches this handler.
   */
  private handleRelayControlMessage(
    relay: RelayClient,
    msg: Record<string, unknown>,
    frontendId: string,
  ): void {
    if (typeof msg.t !== "string") {
      log.warn("relay control message missing type field");
      return;
    }

    const reply = (sid: string, response: unknown) => {
      relay.publishToPeer(frontendId, sid, response).catch(() => {});
    };
    const replyError = (sid: string, e: string, m: string) => {
      reply(sid, { t: "err", e, m });
    };

    // Validate sid for messages that require it
    // (in.chat/in.term are routed via onInput, never reach here)
    const needsSid = [
      "attach",
      "detach",
      "resume",
      "resize",
      "session.stop",
      "session.restart",
      "session.export",
    ];
    if (needsSid.includes(msg.t) && typeof msg.sid !== "string") {
      replyError(RELAY_CHANNEL_CONTROL, "INVALID", `${msg.t} missing sid`);
      return;
    }

    switch (msg.t) {
      case "hello": {
        const sessions = this.store.listSessions().map(toWsSessionMeta);
        reply(RELAY_CHANNEL_META, { t: "hello", v: 1, d: { sessions } });
        break;
      }

      case "attach": {
        const sid = msg.sid as string;
        const meta = this.store.getSession(sid);
        if (meta) {
          reply(sid, { t: "state", sid, d: toWsSessionMeta(meta) });
        } else {
          replyError(sid, "NOT_FOUND", `Session ${sid} not found`);
        }
        break;
      }

      case "detach":
        // No response needed for detach via relay
        break;

      case "resume": {
        const sid = msg.sid as string;
        const cursor = (msg.c as number) ?? 0;
        this.handleRelayResume(relay, frontendId, sid, cursor);
        break;
      }

      case "resize": {
        const sid = msg.sid as string;
        const runner = this.ipcServer.findRunnerBySid(sid);
        if (runner) {
          this.ipcServer.send(runner, {
            t: "resize",
            sid,
            cols: msg.cols as number,
            rows: msg.rows as number,
          });
        }
        break;
      }

      case "ping":
        reply(RELAY_CHANNEL_CONTROL, { t: "pong" });
        break;

      case "session.create": {
        if (typeof msg.cwd !== "string") {
          replyError(RELAY_CHANNEL_CONTROL, "INVALID", "Missing cwd");
          break;
        }
        const cwd = msg.cwd;
        const sid = (msg.sid as string) ?? `session-${Date.now().toString(36)}`;
        try {
          this.createSession(sid, cwd);
        } catch (err) {
          replyError(
            sid,
            "SESSION_ERROR",
            err instanceof Error ? err.message : "Failed to create session",
          );
        }
        break;
      }

      case "session.stop": {
        const sid = msg.sid as string;
        if (!this.sessionManager.killRunner(sid)) {
          replyError(sid, "NO_RUNNER", `No runner for session ${sid}`);
        }
        break;
      }

      case "session.restart": {
        const sid = msg.sid as string;
        const session = this.store.getSession(sid);
        if (!session) {
          replyError(sid, "NOT_FOUND", `Session ${sid} not found`);
          break;
        }
        this.sessionManager.killRunner(sid);
        try {
          this.createSession(sid, session.cwd, {
            worktreePath: session.worktree_path ?? undefined,
          });
          log.info(`restarted session ${sid} via relay`);
        } catch (err) {
          replyError(
            sid,
            "SESSION_ERROR",
            err instanceof Error ? err.message : "Failed to restart session",
          );
        }
        break;
      }

      case "session.export":
        this.handleRelaySessionExport(relay, frontendId, msg);
        break;

      case "worktree.list":
        this.handleRelayWorktreeList(relay, frontendId);
        break;

      case "worktree.create": {
        if (typeof msg.branch !== "string") {
          replyError(RELAY_CHANNEL_CONTROL, "INVALID", "Missing branch");
          break;
        }
        this.handleRelayWorktreeCreate(
          relay,
          frontendId,
          msg.branch,
          msg.baseBranch as string | undefined,
          msg.path as string | undefined,
        );
        break;
      }

      case "worktree.remove": {
        if (typeof msg.path !== "string") {
          replyError(RELAY_CHANNEL_CONTROL, "INVALID", "Missing path");
          break;
        }
        this.handleRelayWorktreeRemove(
          relay,
          frontendId,
          msg.path,
          msg.force as boolean | undefined,
        );
        break;
      }

      default:
        log.warn(`unknown relay control message: ${msg.t}`);
    }
  }

  private handleRelayResume(
    relay: RelayClient,
    frontendId: string,
    sid: string,
    cursor: number,
  ): void {
    const db = this.store.getSessionDb(sid);
    if (!db) {
      relay
        .publishToPeer(frontendId, sid, {
          t: "err",
          e: "NOT_FOUND",
          m: `Session ${sid} not found`,
        })
        .catch(() => {});
      return;
    }

    const records = db.getRecordsFrom(cursor);
    const wsRecs = toWsRecs(sid, records);

    relay
      .publishToPeer(frontendId, sid, { t: "batch", sid, d: wsRecs })
      .catch(() => {});
  }

  private async handleRelayWorktreeList(
    relay: RelayClient,
    frontendId: string,
  ): Promise<void> {
    if (!this.worktreeManager) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "NO_REPO",
          m: "No repository configured for worktree management",
        })
        .catch(() => {});
      return;
    }

    try {
      const worktrees = await this.worktreeManager.list();
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "worktree.list",
          d: worktrees,
        })
        .catch(() => {});
    } catch (err) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "WORKTREE_ERROR",
          m: err instanceof Error ? err.message : "Failed to list worktrees",
        })
        .catch(() => {});
    }
  }

  private async handleRelayWorktreeCreate(
    relay: RelayClient,
    frontendId: string,
    branch: string,
    baseBranch?: string,
    path?: string,
  ): Promise<void> {
    if (!this.worktreeManager) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "NO_REPO",
          m: "No repository configured",
        })
        .catch(() => {});
      return;
    }

    try {
      const ts = Date.now().toString(36);
      const wtPath = path ?? `${branch}-${ts}`;
      const wt = await this.worktreeManager.add(wtPath, branch, baseBranch);
      const sid = `${branch}-${ts}`;
      this.createSession(sid, wt.path, { worktreePath: wt.path });

      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "worktree.created",
          d: wt,
          sid,
        })
        .catch(() => {});
    } catch (err) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "WORKTREE_ERROR",
          m: err instanceof Error ? err.message : "Failed to create worktree",
        })
        .catch(() => {});
    }
  }

  private async handleRelayWorktreeRemove(
    relay: RelayClient,
    frontendId: string,
    path: string,
    force?: boolean,
  ): Promise<void> {
    if (!this.worktreeManager) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "NO_REPO",
          m: "No repository configured",
        })
        .catch(() => {});
      return;
    }

    try {
      await this.worktreeManager.remove(path, force);
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "worktree.removed",
          path,
        })
        .catch(() => {});
    } catch (err) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "WORKTREE_ERROR",
          m: err instanceof Error ? err.message : "Failed to remove worktree",
        })
        .catch(() => {});
    }
  }

  private handleRelaySessionExport(
    relay: RelayClient,
    frontendId: string,
    msg: Record<string, unknown>,
  ): void {
    const sid = msg.sid as string;
    const format = (msg.format as "json" | "markdown") ?? "markdown";
    const recordTypes = msg.recordTypes as RecordKind[] | undefined;
    const timeRange = msg.timeRange as
      | { from?: number; to?: number }
      | undefined;
    const limit = msg.limit as number | undefined;

    const session = this.store.getSession(sid);
    if (!session) {
      relay
        .publishToPeer(frontendId, sid, {
          t: "err",
          e: "NOT_FOUND",
          m: `Session ${sid} not found`,
        })
        .catch(() => {});
      return;
    }

    const db = this.store.getSessionDb(sid);
    if (!db) {
      relay
        .publishToPeer(frontendId, sid, {
          t: "err",
          e: "NOT_FOUND",
          m: `Session DB for ${sid} not found`,
        })
        .catch(() => {});
      return;
    }

    const effectiveLimit = Math.min(limit ?? 50000, 50000);
    const records = db.getRecordsFiltered({
      kinds: recordTypes,
      from: timeRange?.from,
      to: timeRange?.to,
      limit: effectiveLimit,
    });

    const meta = toWsSessionMeta(session);
    const truncated = records.length >= effectiveLimit;

    if (format === "json") {
      relay
        .publishToPeer(frontendId, sid, {
          t: "session.exported",
          sid,
          format: "json",
          d: JSON.stringify({ meta, records, truncated }),
        })
        .catch(() => {});
    } else {
      const md = formatMarkdown(meta, records, truncated);
      relay
        .publishToPeer(frontendId, sid, {
          t: "session.exported",
          sid,
          format: "markdown",
          d: md,
        })
        .catch(() => {});
    }
  }

  /**
   * Set the repository root for worktree management.
   */
  setRepoRoot(repoRoot: string): void {
    this.worktreeManager = new WorktreeManager(repoRoot);
  }

  /** Get a runner by session ID (for passthrough mode) */
  getRunner(sid: string): RunnerInfo | undefined {
    return this.sessionManager.getRunner(sid);
  }

  /** List all sessions known to the store. */
  listSessions(): SessionMeta[] {
    return this.store.listSessions();
  }

  /** Get a session's metadata by sid. */
  getSession(sid: string): SessionMeta | undefined {
    return this.store.getSession(sid);
  }

  /**
   * Get stored records for a session with seq > afterSeq.
   * Returns empty array if the session is unknown.
   */
  getRecordsSince(sid: string, afterSeq = 0, limit = 1000): StoredRecord[] {
    const db = this.store.getSessionDb(sid);
    if (!db) return [];
    return db.getRecordsFrom(afterSeq, limit);
  }

  /**
   * Close the underlying store without tearing down IPC / relay state.
   * Safe to call without a prior `start()`. Do NOT call if `start()` was
   * invoked — use `stop()` instead, which tears down IPC/relay and then
   * closes the store.
   */
  close(): void {
    this.store.close();
  }

  /**
   * Remove a pairing by daemonId: optionally notifies the peer with a
   * control.unpair frame, tears down the relay client, and deletes the
   * persisted pairing record from the store.
   */
  async removePairing(
    daemonId: string,
    opts: { notifyPeer: boolean } = { notifyPeer: true },
  ): Promise<void> {
    const idx = this.relayClients.findIndex((c) => c.daemonId === daemonId);
    const client = idx >= 0 ? this.relayClients[idx] : undefined;
    if (client && opts.notifyPeer) {
      let notified = 0;
      const peers = client.listPeerFrontendIds();
      for (const frontendId of peers) {
        try {
          if (await client.sendUnpairNotice(frontendId, "user-initiated")) {
            notified++;
          }
        } catch (err) {
          // Best-effort — continue teardown on failure
          log.warn(
            `sendUnpairNotice failed for frontend ${frontendId}: ${String(err)}`,
          );
        }
      }
      const logFn = peers.length === 0 ? log.debug : log.info;
      logFn(
        `removePairing(${daemonId}): notified ${notified}/${peers.length} peers`,
      );
    }
    if (client) {
      client.dispose();
      this.relayClients.splice(idx, 1);
    }
    this.store.deletePairing(daemonId);
  }

  /** @internal for tests */
  getActivePairingIds(): string[] {
    return this.relayClients.map((c) => c.daemonId);
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
    this.ipcServer.stop();
    this.store.close();
    log.info("stopped");
  }
}

function toWsRecs(sid: string, records: StoredRecord[]): WsRec[] {
  return records.map((r) => ({
    t: "rec" as const,
    sid,
    seq: r.seq,
    k: r.kind,
    ns: (r.ns as Namespace) ?? undefined,
    n: r.name ?? undefined,
    d: Buffer.from(r.payload).toString("base64"),
    ts: r.ts,
  }));
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
