import type {
  IpcBye,
  IpcDoctorProbeOk,
  IpcHello,
  IpcMessage,
  IpcPairBegin,
  IpcPairCancel,
  IpcPairRemove,
  IpcPairRemoveErr,
  IpcPairRemoveOk,
  IpcPairRename,
  IpcPairRenameErr,
  IpcPairRenameOk,
  IpcRec,
  IpcSessionDelete,
  IpcSessionDeleteErr,
  IpcSessionDeleteOk,
  IpcSessionPrune,
  IpcSessionPruneErr,
  IpcSessionPruneOk,
  Namespace,
  RelayControlMessage,
  WsRec,
  WsSessionExport,
} from "@teleprompter/protocol";
import {
  createLogger,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
} from "@teleprompter/protocol";
import { formatMarkdown } from "../export-formatter";
import type { PushNotifier } from "../push/push-notifier";
import type {
  SessionManager,
  SpawnRunnerOptions,
} from "../session/session-manager";
import { type Store, toWsSessionMeta } from "../store";
import type { StoredRecord } from "../store/session-db";
import type { RelayClient } from "../transport/relay-client";
import type { WorktreeManager } from "../worktree/worktree-manager";
import type { ConnectedRunner, IpcServer } from "./server";

const log = createLogger("IpcDispatcher");

/**
 * Dependencies injected into {@link IpcCommandDispatcher}.
 *
 * Pairing lifecycle hooks (`onPairBegin`, `onPairCancel`, `onCliDisconnect`)
 * remain callbacks because IPC-frame ownership (`ConnectedRunner` wiring,
 * `pair.begin.ok`/`pair.begin.err` responses, CLI-disconnect cancellation)
 * stays on the Daemon. The pending-pairing state machine itself lives in
 * {@link PairingOrchestrator} (see `../pairing/pairing-orchestrator.ts`).
 */
export interface IpcCommandDispatcherDeps {
  ipcServer: IpcServer;
  store: Store;
  sessionManager: SessionManager;
  pushNotifier: PushNotifier;
  /** Current WorktreeManager. Getter form so the dispatcher picks up
   * a later `setRepoRoot` call without re-construction. */
  getWorktreeManager: () => WorktreeManager | null;
  /** Spawn a runner for `sid` using the daemon's current socketPath. */
  createSession: (sid: string, cwd: string, opts?: SpawnRunnerOptions) => void;
  /** Pairing callbacks — delegated to Daemon, which forwards the state
   * transitions to `PairingOrchestrator` and owns the IPC response framing. */
  onPairBegin: (runner: ConnectedRunner, msg: IpcPairBegin) => void;
  onPairCancel: (runner: ConnectedRunner, msg: IpcPairCancel) => void;
  onCliDisconnect: (runner: ConnectedRunner) => void;
  /** Remove a pairing (notifies peers, tears down relay client, deletes from
   * store). Returns the number of peers notified. */
  removePairing: (daemonId: string) => Promise<number>;
  /** Rename a pairing's label (updates store, notifies peers). Returns the
   * number of peers notified. */
  renamePairing: (daemonId: string, label: string | null) => Promise<number>;
  /** Local record observer (passthrough CLI). Getter because Daemon can
   * install the observer after dispatcher construction. */
  getOnRecord: () =>
    | ((sid: string, kind: string, payload: Buffer, name?: string) => void)
    | null;
  /** All active relay clients. Getter so newly added relays are picked up
   * on each IPC rec. */
  getRelayClients: () => RelayClient[];
  /** Returns relay health snapshots from the daemon's live RelayClients.
   * Used by `doctor.probe` so the CLI never opens a second daemon-role WS. */
  getRelayHealth: () => Array<{
    daemonId: string;
    relayUrl: string;
    connected: boolean;
    peerCount: number;
  }>;
}

/**
 * Routes IPC messages (Runner → Daemon) and relay control messages
 * (Frontend → Relay → Daemon) to their handlers.
 *
 * This class is a pure router: no transport I/O of its own, no state beyond
 * injected collaborators. All responses flow back through the injected
 * `IpcServer` / `RelayClient` (passed per-call).
 */
export class IpcCommandDispatcher {
  private readonly deps: IpcCommandDispatcherDeps;

  constructor(deps: IpcCommandDispatcherDeps) {
    this.deps = deps;
  }

  /**
   * Dispatch a typed IPC message from a connected runner. Pairing messages
   * are delegated to the injected callbacks; session lifecycle messages are
   * handled inline.
   */
  dispatchIpc(
    runner: ConnectedRunner,
    msg: IpcMessage,
    binary: Uint8Array<ArrayBufferLike> | null = null,
  ): void {
    switch (msg.t) {
      case "pair.begin":
        this.deps.onPairBegin(runner, msg);
        return;
      case "pair.cancel":
        this.deps.onPairCancel(runner, msg);
        return;
      case "pair.remove":
        void this.handlePairRemove(runner, msg);
        return;
      case "pair.rename":
        void this.handlePairRename(runner, msg);
        return;
      case "session.delete":
        this.handleSessionDelete(runner, msg);
        return;
      case "session.prune":
        this.handleSessionPrune(runner, msg);
        return;
      case "doctor.probe":
        this.handleDoctorProbe(runner);
        return;
      case "hello":
        this.handleHello(msg);
        return;
      case "rec":
        this.handleRec(runner, msg, binary);
        return;
      case "bye":
        this.handleBye(msg);
        return;
      default:
        // ack/input/resize/pair.begin.ok/pair.begin.err/
        // pair.completed/pair.cancelled/pair.error/pair.remove.ok etc.
        // are daemon→runner messages; if a runner sends one we simply ignore it.
        log.warn(`ignoring unexpected IPC message from runner: ${msg.t}`);
    }
  }

  private async handlePairRemove(
    runner: ConnectedRunner,
    msg: IpcPairRemove,
  ): Promise<void> {
    const pairings = this.deps.store.listPairings();
    const exists = pairings.some((p) => p.daemonId === msg.daemonId);
    if (!exists) {
      const err: IpcPairRemoveErr = {
        t: "pair.remove.err",
        daemonId: msg.daemonId,
        reason: "not-found",
      };
      this.deps.ipcServer.send(runner, err);
      return;
    }
    try {
      const notified = await this.deps.removePairing(msg.daemonId);
      const ok: IpcPairRemoveOk = {
        t: "pair.remove.ok",
        daemonId: msg.daemonId,
        notifiedPeers: notified,
      };
      this.deps.ipcServer.send(runner, ok);
    } catch (e) {
      const err: IpcPairRemoveErr = {
        t: "pair.remove.err",
        daemonId: msg.daemonId,
        reason: "internal",
        message: e instanceof Error ? e.message : String(e),
      };
      this.deps.ipcServer.send(runner, err);
    }
  }

  private async handlePairRename(
    runner: ConnectedRunner,
    msg: IpcPairRename,
  ): Promise<void> {
    const pairings = this.deps.store.listPairings();
    const exists = pairings.some((p) => p.daemonId === msg.daemonId);
    if (!exists) {
      const err: IpcPairRenameErr = {
        t: "pair.rename.err",
        daemonId: msg.daemonId,
        reason: "not-found",
      };
      this.deps.ipcServer.send(runner, err);
      return;
    }
    try {
      const notified = await this.deps.renamePairing(msg.daemonId, msg.label);
      const ok: IpcPairRenameOk = {
        t: "pair.rename.ok",
        daemonId: msg.daemonId,
        label: msg.label,
        notifiedPeers: notified,
      };
      this.deps.ipcServer.send(runner, ok);
    } catch (e) {
      const err: IpcPairRenameErr = {
        t: "pair.rename.err",
        daemonId: msg.daemonId,
        reason: "internal",
        message: e instanceof Error ? e.message : String(e),
      };
      this.deps.ipcServer.send(runner, err);
    }
  }

  /**
   * Delete a single session. Kills the runner first when the session is still
   * marked running, then removes the metadata row and per-session DB file via
   * `Store.deleteSession`. Replies `session.delete.ok { wasRunning }` so the
   * CLI can report whether a live Runner was killed.
   */
  private handleSessionDelete(
    runner: ConnectedRunner,
    msg: IpcSessionDelete,
  ): void {
    const meta = this.deps.store.getSession(msg.sid);
    if (!meta) {
      const err: IpcSessionDeleteErr = {
        t: "session.delete.err",
        sid: msg.sid,
        reason: "not-found",
      };
      this.deps.ipcServer.send(runner, err);
      return;
    }
    const wasRunning = meta.state === "running";
    try {
      if (wasRunning) {
        this.deps.sessionManager.killRunner(msg.sid);
      }
      this.deps.store.deleteSession(msg.sid);
    } catch (e) {
      const err: IpcSessionDeleteErr = {
        t: "session.delete.err",
        sid: msg.sid,
        reason: "internal",
        message: e instanceof Error ? e.message : String(e),
      };
      this.deps.ipcServer.send(runner, err);
      return;
    }
    const ok: IpcSessionDeleteOk = {
      t: "session.delete.ok",
      sid: msg.sid,
      wasRunning,
    };
    this.deps.ipcServer.send(runner, ok);
  }

  /**
   * Prune sessions matching a filter. By default only stopped/error sessions
   * older than `olderThanMs` are selected; `includeRunning: true` also kills
   * running runners before delete. `dryRun: true` returns the selection
   * without mutating anything.
   */
  private handleSessionPrune(
    runner: ConnectedRunner,
    msg: IpcSessionPrune,
  ): void {
    const now = Date.now();
    const cutoff = msg.olderThanMs === null ? null : now - msg.olderThanMs;

    const candidates = this.deps.store.listSessions().filter((s) => {
      if (s.state === "running" && !msg.includeRunning) return false;
      if (cutoff === null) return true;
      return s.updated_at < cutoff;
    });

    if (msg.dryRun) {
      const reply: IpcSessionPruneOk = {
        t: "session.prune.ok",
        sids: candidates.map((s) => s.sid),
        runningKilled: 0,
        dryRun: true,
      };
      this.deps.ipcServer.send(runner, reply);
      return;
    }

    const deleted: string[] = [];
    let runningKilled = 0;
    try {
      for (const s of candidates) {
        if (s.state === "running") {
          this.deps.sessionManager.killRunner(s.sid);
          runningKilled++;
        }
        this.deps.store.deleteSession(s.sid);
        deleted.push(s.sid);
      }
    } catch (e) {
      const err: IpcSessionPruneErr = {
        t: "session.prune.err",
        reason: "internal",
        message: e instanceof Error ? e.message : String(e),
        // Partial state: the rows in `deleted` are already gone from the store.
        // Reporting them lets the CLI surface "deleted N/M then errored" instead
        // of implying nothing happened. `runningKilled` may exceed deleted.length
        // if the throw came from `deleteSession` after `killRunner` succeeded —
        // the CLI can render both numbers in the partial-failure report.
        partialSids: deleted,
        partialRunningKilled: runningKilled,
      };
      this.deps.ipcServer.send(runner, err);
      return;
    }

    const reply: IpcSessionPruneOk = {
      t: "session.prune.ok",
      sids: deleted,
      runningKilled,
      dryRun: false,
    };
    this.deps.ipcServer.send(runner, reply);
  }

  /**
   * Handle `doctor.probe`: collect relay health from live RelayClients and
   * reply with `doctor.probe.ok`. No new WebSocket is opened — the daemon
   * reports from its existing authenticated connections, avoiding the dual
   * daemon-role WS conflict that caused `tp doctor` to hang.
   */
  private handleDoctorProbe(runner: ConnectedRunner): void {
    const relays = this.deps.getRelayHealth();
    const ok: IpcDoctorProbeOk = { t: "doctor.probe.ok", relays };
    this.deps.ipcServer.send(runner, ok);
  }

  /**
   * Called by the Daemon when an IPC socket closes. Forwards to the pairing
   * orchestrator callback so it can cancel any pending pairing owned by the
   * disconnecting runner.
   */
  handleRunnerDisconnect(runner: ConnectedRunner): void {
    this.deps.onCliDisconnect(runner);
  }

  /**
   * Dispatch a typed relay control message (from a remote frontend). Responses
   * are addressed back to the originating `frontendId` via `relay.publishToPeer`.
   *
   * Note: `control.unpair` / `control.rename` are intercepted earlier in
   * `RelayClient.decryptAndDispatch` and never reach this handler.
   */
  dispatchRelayControl(
    relay: RelayClient,
    msg: RelayControlMessage,
    frontendId: string,
  ): void {
    const reply = (sid: string, response: unknown) => {
      relay.publishToPeer(frontendId, sid, response).catch(() => {});
    };
    const replyError = (sid: string, e: string, m: string) => {
      reply(sid, { t: "err", e, m });
    };

    switch (msg.t) {
      case "hello": {
        const sessions = this.deps.store.listSessions().map(toWsSessionMeta);
        reply(RELAY_CHANNEL_META, { t: "hello", v: 1, d: { sessions } });
        break;
      }

      case "attach": {
        const meta = this.deps.store.getSession(msg.sid);
        if (meta) {
          reply(msg.sid, {
            t: "state",
            sid: msg.sid,
            d: toWsSessionMeta(meta),
          });
        } else {
          replyError(msg.sid, "NOT_FOUND", `Session ${msg.sid} not found`);
        }
        break;
      }

      case "detach":
        // No response needed for detach via relay
        break;

      case "resume": {
        this.handleRelayResume(relay, frontendId, msg.sid, msg.c);
        break;
      }

      case "resize": {
        const runner = this.deps.ipcServer.findRunnerBySid(msg.sid);
        if (runner) {
          this.deps.ipcServer.send(runner, {
            t: "resize",
            sid: msg.sid,
            cols: msg.cols,
            rows: msg.rows,
          });
        }
        break;
      }

      case "ping":
        reply(RELAY_CHANNEL_CONTROL, { t: "pong" });
        break;

      case "session.create": {
        const sid = msg.sid ?? `session-${Date.now().toString(36)}`;
        try {
          this.deps.createSession(sid, msg.cwd, {
            cols: msg.cols,
            rows: msg.rows,
          });
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
        if (!this.deps.sessionManager.killRunner(msg.sid)) {
          replyError(msg.sid, "NO_RUNNER", `No runner for session ${msg.sid}`);
        }
        break;
      }

      case "session.restart": {
        const session = this.deps.store.getSession(msg.sid);
        if (!session) {
          replyError(msg.sid, "NOT_FOUND", `Session ${msg.sid} not found`);
          break;
        }
        this.deps.sessionManager.killRunner(msg.sid);
        try {
          this.deps.createSession(msg.sid, session.cwd, {
            worktreePath: session.worktree_path ?? undefined,
          });
          log.info(`restarted session ${msg.sid} via relay`);
        } catch (err) {
          replyError(
            msg.sid,
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
        this.handleRelayWorktreeCreate(
          relay,
          frontendId,
          msg.branch,
          msg.baseBranch,
          msg.path,
        );
        break;
      }

      case "worktree.remove": {
        this.handleRelayWorktreeRemove(relay, frontendId, msg.path, msg.force);
        break;
      }

      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  // ---------------------------------------------------------------------
  // IPC handlers
  // ---------------------------------------------------------------------

  private handleHello(msg: IpcHello): void {
    this.deps.store.createSession(
      msg.sid,
      msg.cwd,
      msg.worktreePath,
      msg.claudeVersion,
    );
    this.deps.sessionManager.registerRunner(
      msg.sid,
      msg.pid,
      msg.cwd,
      msg.worktreePath,
      msg.claudeVersion,
    );
    log.info(`session created sid=${msg.sid}`);

    // Subscribe relay clients to the new session
    for (const relay of this.deps.getRelayClients()) {
      relay.subscribe(msg.sid);
    }

    // Notify relay of new session
    const meta = this.deps.store.getSession(msg.sid);
    if (meta) {
      const stateMsg = {
        t: "state" as const,
        sid: msg.sid,
        d: toWsSessionMeta(meta),
      };
      for (const relay of this.deps.getRelayClients()) {
        relay.publishState(RELAY_CHANNEL_META, stateMsg).catch(() => {});
      }
    }
  }

  private handleRec(
    runner: ConnectedRunner,
    msg: IpcRec,
    binary: Uint8Array<ArrayBufferLike> | null,
  ): void {
    const db = this.deps.store.getSessionDb(msg.sid);
    if (!db) {
      log.error(`unknown session sid=${msg.sid}`);
      return;
    }

    // Runner may either send the payload base64-encoded in `msg.payload`
    // (event/meta records, small enough that the wire overhead doesn't
    // matter) or as the frame's binary sidecar (io records, which carry
    // raw PTY bytes and skip base64 entirely). Use whichever is present.
    const payload = binary
      ? Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength)
      : Buffer.from(msg.payload, "base64");
    const seq = db.append(msg.kind, msg.ts, payload, msg.ns, msg.name);

    this.deps.store.updateLastSeq(msg.sid, seq);

    // Send ack (informational, non-blocking)
    this.deps.ipcServer.send(runner, {
      t: "ack",
      sid: msg.sid,
      seq,
    });

    // Publish to relay(s) for remote frontends. The WS protocol still
    // sends payloads as base64 text (WebSocket frames are JSON), so if
    // the runner handed us raw bytes we base64-encode once here before
    // fanning out to relays.
    const wsPayload = binary ? payload.toString("base64") : msg.payload;
    const wsRec: WsRec = {
      t: "rec",
      sid: msg.sid,
      seq,
      k: msg.kind,
      ns: msg.ns,
      n: msg.name,
      d: wsPayload,
      ts: msg.ts,
    };
    for (const relay of this.deps.getRelayClients()) {
      relay.publishRecord(wsRec).catch(() => {});
    }

    // Notify local observer (passthrough CLI pipes io records to stdout).
    const onRecord = this.deps.getOnRecord();
    if (onRecord) {
      onRecord(msg.sid, msg.kind, payload, msg.name);
    }

    // Check if this record should trigger a push notification. Decode the
    // payload defensively — non-event records (io/meta) skip this branch
    // because PushNotifier short-circuits on `kind !== "event"`, but the
    // payload of an event record is the JSON the hook script wrote.
    let parsedPayload: Record<string, unknown> | undefined;
    if (msg.kind === "event") {
      try {
        const text = payload.toString("utf-8");
        if (text.length > 0) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedPayload = parsed as Record<string, unknown>;
          }
        }
      } catch {
        // Hooks should always produce valid JSON; if parsing fails we fall
        // back to generic copy in PushNotifier — no error path needed.
      }
    }
    this.deps.pushNotifier.onRecord({
      sid: msg.sid,
      kind: msg.kind,
      name: msg.name,
      ns: msg.ns,
      payload: parsedPayload,
    });
  }

  private handleBye(msg: IpcBye): void {
    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.deps.store.updateSessionState(msg.sid, state);
    this.deps.sessionManager.unregisterRunner(msg.sid);
    log.info(
      `session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`,
    );

    // Notify relay of session state change
    const meta = this.deps.store.getSession(msg.sid);
    if (meta) {
      const stateMsg = {
        t: "state" as const,
        sid: msg.sid,
        d: toWsSessionMeta(meta),
      };
      for (const relay of this.deps.getRelayClients()) {
        relay.publishState(RELAY_CHANNEL_META, stateMsg).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------
  // Relay control handlers (session / worktree / export)
  // ---------------------------------------------------------------------

  private handleRelayResume(
    relay: RelayClient,
    frontendId: string,
    sid: string,
    cursor: number,
  ): void {
    const db = this.deps.store.getSessionDb(sid);
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
    const worktreeManager = this.deps.getWorktreeManager();
    if (!worktreeManager) {
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
      const worktrees = await worktreeManager.list();
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
    const worktreeManager = this.deps.getWorktreeManager();
    if (!worktreeManager) {
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
      const wt = await worktreeManager.add(wtPath, branch, baseBranch);
      const sid = `${branch}-${ts}`;
      this.deps.createSession(sid, wt.path, { worktreePath: wt.path });

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
    const worktreeManager = this.deps.getWorktreeManager();
    if (!worktreeManager) {
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
      await worktreeManager.remove(path, force);
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
    msg: WsSessionExport,
  ): void {
    const sid = msg.sid;
    const format = msg.format ?? "markdown";
    const recordTypes = msg.recordTypes;
    const timeRange = msg.timeRange;
    const limit = msg.limit;

    const session = this.deps.store.getSession(sid);
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

    const db = this.deps.store.getSessionDb(sid);
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
}

const NAMESPACE_VALUES: ReadonlySet<Namespace> = new Set([
  "claude",
  "tp",
  "runner",
  "daemon",
]);

function toNamespace(value: string | null): Namespace | undefined {
  if (value === null) return undefined;
  for (const v of NAMESPACE_VALUES) if (v === value) return v;
  return undefined;
}

function toWsRecs(sid: string, records: StoredRecord[]): WsRec[] {
  return records.map((r) => ({
    t: "rec" as const,
    sid,
    seq: r.seq,
    k: r.kind,
    ns: toNamespace(r.ns),
    n: r.name ?? undefined,
    d: Buffer.from(r.payload).toString("base64"),
    ts: r.ts,
  }));
}
