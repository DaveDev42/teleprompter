import type {
  IpcPairBegin,
  IpcPairBeginErr,
  IpcPairBeginOk,
  IpcPairCancel,
  IpcPairCancelled,
  IpcPairCompleted,
  IpcPairError,
} from "@teleprompter/protocol";
import { createLogger } from "@teleprompter/protocol";
import { IpcCommandDispatcher } from "./ipc/command-dispatcher";
import type { ConnectedRunner } from "./ipc/server";
import { IpcServer } from "./ipc/server";
import { BeginPairingError } from "./pairing/begin-pairing-error";
import {
  PendingPairing,
  type PendingPairingResult,
} from "./pairing/pending-pairing";
import { PushNotifier } from "./push/push-notifier";
import {
  type RunnerInfo,
  SessionManager,
  type SpawnRunnerOptions,
} from "./session/session-manager";
import { Store } from "./store";
import type { StoredRecord } from "./store/session-db";
import type { SessionMeta } from "./store/store";
import {
  RelayClient,
  type RelayClientConfig,
  type RelayClientEvents,
} from "./transport/relay-client";
import { RelayConnectionManager } from "./transport/relay-manager";
import { WorktreeManager } from "./worktree/worktree-manager";

const log = createLogger("Daemon");

const DEFAULT_PRUNE_TTL_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class Daemon {
  private ipcServer: IpcServer;
  private store: Store;
  private sessionManager = new SessionManager();
  private relayManager: RelayConnectionManager;
  private worktreeManager: WorktreeManager | null = null;
  private pushNotifier: PushNotifier;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPairing: PendingPairing | null = null;
  private pendingPairingOwner: ConnectedRunner | null = null;
  private dispatcher: IpcCommandDispatcher;
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
        this.relayManager.dispatchPush(frontendId, token, title, body, data);
      },
    });

    // IpcServer and dispatcher reference each other at construction time,
    // so create the dispatcher first (with a lazy ipcServer getter is avoided
    // by assigning `this.ipcServer` before the dispatcher references it).
    this.ipcServer = new IpcServer({
      onConnect: (_runner) => {
        log.info("runner connected");
      },
      onDisconnect: (runner) => {
        this.dispatcher.handleRunnerDisconnect(runner);
        if (runner.sid) {
          log.info(`runner disconnected sid=${runner.sid}`);
        }
      },
      onMessage: (runner, msg) => {
        this.dispatcher.dispatchIpc(runner, msg);
      },
    });

    // RelayConnectionManager is constructed before the dispatcher so the
    // dispatcher can read relay clients via `manager.listClients()`. The
    // manager itself reads the dispatcher lazily via `getDispatcher` to
    // close the cycle.
    this.relayManager = new RelayConnectionManager({
      ipcServer: this.ipcServer,
      store: this.store,
      pushNotifier: this.pushNotifier,
      getDispatcher: () => this.dispatcher,
    });

    this.dispatcher = new IpcCommandDispatcher({
      ipcServer: this.ipcServer,
      store: this.store,
      sessionManager: this.sessionManager,
      pushNotifier: this.pushNotifier,
      getWorktreeManager: () => this.worktreeManager,
      createSession: (sid, cwd, opts) => this.createSession(sid, cwd, opts),
      onPairBegin: (runner, msg) => {
        void this.__handlePairBegin(runner, msg);
      },
      onPairCancel: (runner, msg) => this.__handlePairCancel(runner, msg),
      onCliDisconnect: (runner) => this.__handleCliDisconnect(runner),
      getOnRecord: () => this.onRecord,
      getRelayClients: () => [...this.relayManager.listClients()],
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
   *
   * Thin delegate to {@link RelayConnectionManager.addClient}; kept on the
   * Daemon surface for back-compat with CLI tests (unpair-e2e, rename-e2e,
   * multi-frontend).
   */
  async connectRelay(config: RelayClientConfig): Promise<RelayClient> {
    return this.relayManager.addClient(config);
  }

  /** Test-only hook: inject a fake RelayClient factory for PendingPairing. */
  __setRelayFactory(f: (cfg: RelayClientConfig) => RelayClient): void {
    this.relayManager.__setFactory(f);
  }

  /**
   * Start a new pending pairing. Exactly one pending pairing per daemon.
   * Throws `BeginPairingError` on error — the IPC layer converts this into
   * an `IpcPairBeginErr`.
   *
   * Pairing lifecycle (`pendingPairing`, cancel, promote) stays on Daemon
   * for C2 — the RelayConnectionManager is invoked for client construction
   * (via `buildEvents` / `attachHandlers`) and for eventual promotion (via
   * `registerClient`).
   */
  async beginPairing(args: {
    relayUrl: string;
    daemonId?: string;
    label?: string | null;
  }): Promise<{ pairingId: string; qrString: string; daemonId: string }> {
    if (this.pendingPairing) {
      throw new BeginPairingError("already-pending");
    }

    const daemonId = args.daemonId ?? `daemon-${Date.now().toString(36)}`;

    if (this.store.listPairings().some((p) => p.daemonId === daemonId)) {
      throw new BeginPairingError("daemon-id-taken");
    }

    let relayRef: RelayClient | null = null;
    const events = this.relayManager.buildEvents(daemonId, () => relayRef);
    const wrappedEvents: RelayClientEvents = {
      ...events,
      onFrontendJoined: (frontendId) => {
        // Call the original hello/subscribe fan-out logic
        events.onFrontendJoined?.(frontendId);
        // Resolve the pending pairing
        this.pendingPairing?.__markCompleted(frontendId);
      },
    };

    const pp = new PendingPairing({
      relayUrl: args.relayUrl,
      daemonId,
      label: args.label ?? null,
      createRelayClient: (cfg) => {
        const factory = this.relayManager.__getFactory();
        if (factory) {
          // Test path — factory provides a fake; ignore wrappedEvents
          const client = factory(cfg as RelayClientConfig);
          relayRef = client;
          this.relayManager.attachHandlers(client, daemonId);
          return client;
        }
        const client = new RelayClient(cfg as RelayClientConfig, wrappedEvents);
        relayRef = client;
        this.relayManager.attachHandlers(client, daemonId);
        return client;
      },
    });

    // Reserve the slot synchronously before any async work so no concurrent
    // beginPairing can slip in while relay.connect() is in-flight.
    this.pendingPairing = pp;

    try {
      const info = await pp.begin();
      return info;
    } catch (err) {
      pp.cancel();
      if (this.pendingPairing === pp) this.pendingPairing = null;
      throw new BeginPairingError(
        "relay-unreachable",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Returns the awaitCompletion promise, or null if no pending pairing. */
  awaitPendingPairing(): Promise<PendingPairingResult> | null {
    return this.pendingPairing?.awaitCompletion() ?? null;
  }

  /** Cancel the current pending pairing (no-op if none or if `pairingId` mismatches).
   * Also a no-op if the pairing has already completed — the promote path is
   * about to run and must not be disrupted. */
  cancelPendingPairing(pairingId?: string): void {
    if (!this.pendingPairing) return;
    if (pairingId && this.pendingPairing.pairingId !== pairingId) return;
    if (this.pendingPairing.completed) return; // race: promote is about to run
    this.pendingPairing.cancel();
    this.pendingPairing = null;
  }

  /**
   * Persist a completed pending pairing and hand off its RelayClient to the
   * relay manager's pool. Call this after `awaitPendingPairing()` resolves
   * with `{ kind: "completed" }`.
   */
  promoteCompletedPairing(
    result: PendingPairingResult & { kind: "completed" },
  ): void {
    this.store.savePairing({
      daemonId: result.daemonId,
      relayUrl: result.relayUrl,
      relayToken: result.relayToken,
      registrationProof: result.registrationProof,
      publicKey: result.keyPair.publicKey,
      secretKey: result.keyPair.secretKey,
      pairingSecret: result.pairingSecret,
      label: result.label,
    });
    const pp = this.pendingPairing;
    if (pp) {
      const relay = pp.releaseRelay();
      this.relayManager.registerClient(relay);
    }
    this.pendingPairing = null;
  }

  async __handlePairBegin(
    runner: ConnectedRunner,
    msg: IpcPairBegin,
  ): Promise<void> {
    try {
      const info = await this.beginPairing({
        relayUrl: msg.relayUrl,
        daemonId: msg.daemonId,
        label: msg.label ?? null,
      });
      this.pendingPairingOwner = runner;

      const ok: IpcPairBeginOk = {
        t: "pair.begin.ok",
        pairingId: info.pairingId,
        qrString: info.qrString,
        daemonId: info.daemonId,
      };
      this.ipcServer.send(runner, ok);

      // Fire-and-forget: await completion and emit follow-up.
      const p = this.awaitPendingPairing();
      if (!p) return;
      p.then((result) => {
        if (this.pendingPairingOwner === runner)
          this.pendingPairingOwner = null;
        if (result.kind === "completed") {
          try {
            this.promoteCompletedPairing(result);
            const evt: IpcPairCompleted = {
              t: "pair.completed",
              pairingId: info.pairingId,
              daemonId: info.daemonId,
              label: result.label,
            };
            this.ipcServer.send(runner, evt);
          } catch (promoteErr) {
            const message =
              promoteErr instanceof Error
                ? promoteErr.message
                : String(promoteErr);
            log.error(
              `promoteCompletedPairing failed (pairingId=${info.pairingId}): ${message}`,
            );
            // Defensively clear the slot so subsequent pair.begin can proceed.
            this.pendingPairing = null;
            const errEvt: IpcPairError = {
              t: "pair.error",
              pairingId: info.pairingId,
              reason: "internal",
              message,
            };
            this.ipcServer.send(runner, errEvt);
          }
        } else {
          const evt: IpcPairCancelled = {
            t: "pair.cancelled",
            pairingId: info.pairingId,
          };
          this.ipcServer.send(runner, evt);
        }
      }).catch((err) => {
        // Defense in depth: catch unexpected promise rejections (e.g. ipcServer.send throws).
        log.error(
          `unexpected error in pair completion handler (pairingId=${info.pairingId}):`,
          err,
        );
      });
    } catch (err) {
      const reason = err instanceof BeginPairingError ? err.reason : "internal";
      const message =
        err instanceof BeginPairingError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      log.warn(`pair.begin failed: reason=${reason} message=${message}`);
      const reply: IpcPairBeginErr = {
        t: "pair.begin.err",
        reason,
        message,
      };
      this.ipcServer.send(runner, reply);
    }
  }

  __handlePairCancel(runner: ConnectedRunner, msg: IpcPairCancel): void {
    if (this.pendingPairingOwner && this.pendingPairingOwner !== runner) {
      log.warn(
        `pair.cancel from non-owner runner ignored (pairingId=${msg.pairingId})`,
      );
      return;
    }
    this.cancelPendingPairing(msg.pairingId);
  }

  __handleCliDisconnect(runner: ConnectedRunner): void {
    if (this.pendingPairingOwner === runner) {
      log.info("CLI disconnected mid-pairing; cancelling pending");
      this.cancelPendingPairing();
      this.pendingPairingOwner = null;
    }
  }

  /**
   * Reconnect to all saved relay pairings from store. Called on daemon
   * startup to restore relay connections.
   *
   * Thin delegate to {@link RelayConnectionManager.reconnectSaved}.
   */
  async reconnectSavedRelays(): Promise<number> {
    return this.relayManager.reconnectSaved();
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
   *
   * Thin delegate to {@link RelayConnectionManager.removePairing}.
   */
  async removePairing(
    daemonId: string,
    opts: { notifyPeer: boolean } = { notifyPeer: true },
  ): Promise<void> {
    return this.relayManager.removePairing(daemonId, opts);
  }

  /** @internal for tests */
  getActivePairingIds(): string[] {
    return this.relayManager.listDaemonIds();
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
    this.relayManager.stop();
    this.ipcServer.stop();
    this.store.close();
    log.info("stopped");
  }
}
