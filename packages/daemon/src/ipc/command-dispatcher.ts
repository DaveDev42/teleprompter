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
  Label,
  Namespace,
  RecordKind,
  RelayControlMessage,
  SessionDeleteErr,
  SessionDeleteOk,
  SessionExport,
  SessionRec,
  SessionStateMsg,
} from "@teleprompter/protocol";
import {
  assertSafeSid,
  createLogger,
  NAMESPACE_SET,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
  sanitizeForSid,
} from "@teleprompter/protocol";
import { formatMarkdown } from "../export-formatter";
import type { PushNotifier } from "../push/push-notifier";
import type {
  SessionManager,
  SpawnRunnerOptions,
} from "../session/session-manager";
import { type Store, toSessionMeta } from "../store";
import type { StoredRecord } from "../store/session-db";
import type { RelayClient } from "../transport/relay-client";
import type { WorktreeManager } from "../worktree/worktree-manager";
import type { ConnectedRunner, IpcServer } from "./server";

const log = createLogger("IpcDispatcher");

/** Convert an unknown thrown value to a string error message. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Unified NO_REPO error message published when no WorktreeManager is configured. */
const NO_REPO_MESSAGE = "No repository configured for worktree management";

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
  renamePairing: (daemonId: string, label: Label) => Promise<number>;
  /** Local record observer (passthrough CLI). Getter because Daemon can
   * install the observer after dispatcher construction. */
  getOnRecord: () =>
    | ((sid: string, kind: RecordKind, payload: Buffer, name?: string) => void)
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
    /** In the dead-pairing reconnect throttle (peerless backoff) — see
     * RelayClient.isThrottled(). `connected: false` is expected here. */
    throttled: boolean;
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
      // CLI→Daemon passthrough: forward input/resize to the runner for the
      // given sid. This allows a passthrough CLI process to relay local stdin
      // bytes and terminal resize events to a session whose runner is managed
      // by this daemon (service-daemon routing path).
      case "input": {
        const inputRunner = this.deps.ipcServer.findRunnerBySid(msg.sid);
        if (inputRunner) {
          this.deps.ipcServer.send(inputRunner, msg);
        }
        return;
      }
      case "resize": {
        const resizeRunner = this.deps.ipcServer.findRunnerBySid(msg.sid);
        if (resizeRunner) {
          this.deps.ipcServer.send(resizeRunner, msg);
        }
        return;
      }
      // The following are daemon→runner messages. A runner that echoes one
      // back is misbehaving but harmless — log and move on. The explicit arms
      // (rather than a catch-all `default`) make the switch exhaustive so the
      // TypeScript compiler will flag any newly-added IpcMessage variant that
      // is neither handled nor explicitly ignored here.
      case "ack":
      case "pair.begin.ok":
      case "pair.begin.err":
      case "pair.completed":
      case "pair.cancelled":
      case "pair.error":
      case "pair.remove.ok":
      case "pair.remove.err":
      case "pair.rename.ok":
      case "pair.rename.err":
      case "session.delete.ok":
      case "session.delete.err":
      case "session.prune.ok":
      case "session.prune.err":
      case "doctor.probe.ok":
        log.warn(`ignoring unexpected IPC message from runner: ${msg.t}`);
        return;
      default: {
        // Exhaustiveness guard: every IpcMessage variant is covered above.
        // Adding a new variant to the union without a corresponding arm here
        // will cause a compile-time error, not a silent runtime drop.
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  /**
   * Shared guard: verify that a pairing with `daemonId` is registered.
   * Sends the not-found error frame and returns `false` when it is absent.
   */
  private guardPairingExists(
    runner: ConnectedRunner,
    daemonId: string,
    notFoundMsg: IpcPairRemoveErr | IpcPairRenameErr,
  ): boolean {
    const pairings = this.deps.store.listPairings();
    if (pairings.some((p) => p.daemonId === daemonId)) return true;
    this.deps.ipcServer.send(runner, notFoundMsg);
    return false;
  }

  private async handlePairRemove(
    runner: ConnectedRunner,
    msg: IpcPairRemove,
  ): Promise<void> {
    if (
      !this.guardPairingExists(runner, msg.daemonId, {
        t: "pair.remove.err",
        daemonId: msg.daemonId,
        reason: "not-found",
      })
    )
      return;
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
        message: errMsg(e),
      };
      this.deps.ipcServer.send(runner, err);
    }
  }

  private async handlePairRename(
    runner: ConnectedRunner,
    msg: IpcPairRename,
  ): Promise<void> {
    if (
      !this.guardPairingExists(runner, msg.daemonId, {
        t: "pair.rename.err",
        daemonId: msg.daemonId,
        reason: "not-found",
      })
    )
      return;
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
        message: errMsg(e),
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
        // killRunner only signals the process; it does not drop the in-memory
        // registration. The async proc.exited handler eventually unregisters,
        // but we are about to delete the store row synchronously, so unregister
        // now to keep activeCount/listRunners consistent immediately.
        this.deps.sessionManager.unregisterRunner(msg.sid);
      }
      this.deps.store.deleteSession(msg.sid);
    } catch (e) {
      const err: IpcSessionDeleteErr = {
        t: "session.delete.err",
        sid: msg.sid,
        reason: "internal",
        message: errMsg(e),
      };
      this.deps.ipcServer.send(runner, err);
      return;
    }
    // Drop the relay subscription for the deleted sid, mirroring the relay-plane
    // session.delete path (see :606). Without this, each RelayClient's
    // subscribedSessions Set keeps a stale entry for every CLI-deleted sid.
    for (const client of this.deps.getRelayClients()) {
      client.unsubscribe(msg.sid);
    }
    const ok: IpcSessionDeleteOk = {
      t: "session.delete.ok",
      sid: msg.sid,
      wasRunning,
    };
    this.deps.ipcServer.send(runner, ok);
  }

  /**
   * Prune sessions matching a filter. `msg.age` scopes the selection: `"all"`
   * matches every stopped/error session; `"olderThan"` restricts to sessions
   * whose `updated_at` is older than `ms`. `includeRunning: true` also kills
   * running runners before delete. `dryRun: true` returns the selection
   * without mutating anything.
   */
  private handleSessionPrune(
    runner: ConnectedRunner,
    msg: IpcSessionPrune,
  ): void {
    const now = Date.now();
    const cutoffMs = msg.age.kind === "olderThan" ? now - msg.age.ms : null;

    const candidates = this.deps.store.listSessions().filter((s) => {
      if (s.state === "running" && !msg.includeRunning) return false;
      if (cutoffMs === null) return true;
      return s.updated_at < cutoffMs;
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
          // Same as handleSessionDelete: drop the in-memory registration
          // synchronously since the store row goes away on the next line.
          this.deps.sessionManager.unregisterRunner(s.sid);
          runningKilled++;
        }
        this.deps.store.deleteSession(s.sid);
        // Drop the relay subscription for each pruned sid (mirrors the
        // relay-plane unsubscribe at :606 and handleSessionDelete above).
        for (const client of this.deps.getRelayClients()) {
          client.unsubscribe(s.sid);
        }
        deleted.push(s.sid);
      }
    } catch (e) {
      const err: IpcSessionPruneErr = {
        t: "session.prune.err",
        reason: "internal",
        message: errMsg(e),
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
        const sessions = this.deps.store.listSessions().map(toSessionMeta);
        // Include the daemon's pairing label so the frontend can display which
        // daemon it just connected to without a separate round-trip. This is a
        // keep-current surface: `relay.label` is undefined when no label is set,
        // which the app decodes via `decodeKxLabelOrKeep` (absence = keep current).
        const daemonLabel = relay.label;
        reply(RELAY_CHANNEL_META, {
          t: "hello",
          v: 1,
          d: {
            sessions,
            ...(daemonLabel !== undefined ? { daemonLabel } : {}),
          },
        });
        break;
      }

      case "attach": {
        const meta = this.deps.store.getSession(msg.sid);
        if (meta) {
          reply(msg.sid, {
            t: "state",
            sid: msg.sid,
            d: toSessionMeta(meta),
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
          // `msg.sid` is frontend-supplied over the relay and reaches Store's
          // `join(storeDir, 'sessions', sid + '.sqlite')` path-join, so a crafted
          // `../../evil` could create/unlink a SQLite file at any daemon-writable
          // path (and leak relay subscriptions that the later runner-crash never
          // cleans up). Validate BEFORE createSession/subscribe so a bad sid is a
          // clean SESSION_ERROR with zero side-effects. Auto-generated sids
          // (`session-<base36ts>`) and worktree `<safeBranch>-<ts>` sids always
          // pass the allowlist, so no legitimate create path breaks.
          assertSafeSid(sid);
          this.deps.createSession(sid, msg.cwd, {
            cols: msg.cols,
            rows: msg.rows,
          });
          // Subscribe every relay client to the new sid IMMEDIATELY, before
          // the runner's IPC `hello` round-trips. `handleHello` also subscribes
          // (idempotent — `subscribedSessions` is a Set), but waiting for it
          // opens a race window of tens-to-hundreds of ms during which the
          // relay would not forward this sid's frames to/from this daemon —
          // so early app→daemon input frames for a freshly created session
          // would be silently dropped by the relay. Subscribing here closes
          // that window the moment the create is accepted.
          for (const relay of this.deps.getRelayClients()) {
            relay.subscribe(sid);
          }
          // Synchronous success ack so the app can optimistically attach
          // without waiting for the runner hello → `state` broadcast. The
          // `state` broadcast (from `handleHello`) remains the canonical
          // session-metadata signal; this ack only confirms the create was
          // accepted (mirrors the existing error reply for failures).
          reply(sid, { t: "session.create.ok", sid });
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

      case "session.delete": {
        // Relay-plane sibling of the CLI's IPC `session.delete`. Mirrors the
        // same kill→unregister→deleteSession semantics, then unsubscribes the
        // relay clients from the sid (symmetry with `session.create`'s
        // immediate subscribe) and replies ok/err to the originating frontend.
        // Other connected frontends drop the (now-ghost) row on their next
        // `hello` snapshot (Store is the SoT — a deleted row is absent from the
        // next session list), so no extra broadcast is required.
        const meta = this.deps.store.getSession(msg.sid);
        if (!meta) {
          reply(msg.sid, {
            t: "session.delete.err",
            sid: msg.sid,
            reason: "not-found",
          } satisfies SessionDeleteErr);
          break;
        }
        const wasRunning = meta.state === "running";
        try {
          if (wasRunning) {
            this.deps.sessionManager.killRunner(msg.sid);
            this.deps.sessionManager.unregisterRunner(msg.sid);
          }
          this.deps.store.deleteSession(msg.sid);
        } catch (err) {
          reply(msg.sid, {
            t: "session.delete.err",
            sid: msg.sid,
            reason: "internal",
            message: err instanceof Error ? err.message : "Failed to delete",
          } satisfies SessionDeleteErr);
          break;
        }
        for (const client of this.deps.getRelayClients()) {
          client.unsubscribe(msg.sid);
        }
        reply(msg.sid, {
          t: "session.delete.ok",
          sid: msg.sid,
          wasRunning,
        } satisfies SessionDeleteOk);
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

  /**
   * Fan-out a session-state update to all connected relay clients.
   * Shared by `handleHello` and `handleBye` so the broadcast shape is
   * defined once — any future protocol change only touches this method.
   */
  private broadcastSessionState(sid: string): void {
    const meta = this.deps.store.getSession(sid);
    if (!meta) return;
    const stateMsg = {
      t: "state" as const,
      sid,
      d: toSessionMeta(meta),
    } satisfies SessionStateMsg;
    for (const relay of this.deps.getRelayClients()) {
      relay.publishState(RELAY_CHANNEL_META, stateMsg).catch(() => {});
    }
  }

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
    this.broadcastSessionState(msg.sid);
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
    const sessionRec: SessionRec = {
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
      relay.publishRecord(sessionRec).catch(() => {});
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
    // Generation guard. `session.restart` synchronously kills the old Runner
    // (SIGTERM → stop() sends bye) then spawns a fresh Runner for the same sid.
    // If the old Runner's bye arrives AFTER the new generation's hello has
    // registered, processing it would mark the live session "error" and
    // unregister the freshly-registered Runner — orphaning a running PTY as a
    // phantom-stopped session. When the bye carries a pid (a back-compat-old
    // Runner omits it) that does not match the currently-registered Runner, the
    // bye is from a stale generation and must be ignored. Mirrors the
    // `proc.exited` generation guard in SessionManager (which uses the
    // Subprocess reference; the IPC layer has no handle, so it uses the pid).
    if (msg.pid !== undefined) {
      const current = this.deps.sessionManager.getRunner(msg.sid);
      if (current && current.pid !== msg.pid) {
        log.info(
          `ignoring stale bye sid=${msg.sid} from old runner pid=${msg.pid} (current pid=${current.pid})`,
        );
        return;
      }
    }

    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.deps.store.updateSessionState(msg.sid, state);
    this.deps.sessionManager.unregisterRunner(msg.sid);
    log.info(
      `session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`,
    );

    // Notify relay of session state change
    this.broadcastSessionState(msg.sid);
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
    const sessionRecs = toSessionRecs(sid, records);

    relay
      .publishToPeer(frontendId, sid, { t: "batch", sid, d: sessionRecs })
      .catch(() => {});
  }

  /**
   * Guard helper for worktree relay handlers.
   *
   * If `getWorktreeManager()` returns `null`, publishes a `NO_REPO` error to
   * the frontend and returns without calling `fn`. Otherwise calls `fn` with
   * the live `WorktreeManager`. Any exception thrown by `fn` is caught and
   * published as a `WORKTREE_ERROR` frame using `fallbackMsg` as the fallback
   * when the error has no message.
   */
  private async withWorktreeManager(
    relay: RelayClient,
    frontendId: string,
    fallbackMsg: string,
    fn: (wm: WorktreeManager) => Promise<void>,
  ): Promise<void> {
    const wm = this.deps.getWorktreeManager();
    if (!wm) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "NO_REPO",
          m: NO_REPO_MESSAGE,
        })
        .catch(() => {});
      return;
    }

    try {
      await fn(wm);
    } catch (err) {
      relay
        .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
          t: "err",
          e: "WORKTREE_ERROR",
          m: err instanceof Error ? err.message : fallbackMsg,
        })
        .catch(() => {});
    }
  }

  private handleRelayWorktreeList(
    relay: RelayClient,
    frontendId: string,
  ): void {
    void this.withWorktreeManager(
      relay,
      frontendId,
      "Failed to list worktrees",
      async (wm) => {
        const worktrees = await wm.list();
        relay
          .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
            t: "worktree.list",
            d: worktrees,
          })
          .catch(() => {});
      },
    );
  }

  private handleRelayWorktreeCreate(
    relay: RelayClient,
    frontendId: string,
    branch: string,
    baseBranch?: string,
    path?: string,
  ): void {
    void this.withWorktreeManager(
      relay,
      frontendId,
      "Failed to create worktree",
      async (wm) => {
        const ts = Date.now().toString(36);
        // A branch name can legally contain characters outside the sid allowlist
        // (`[A-Za-z0-9_-]`): '/' (`feat/x`) turns the sid into a nested subdir,
        // and — just as breaking — `git check-ref-format` accepts '.', '+', and
        // non-ASCII letters (`release-1.2`, `feat.x`, `café`). The sid is joined
        // into `storeDir/sessions/<sid>.sqlite` and validated by
        // `store.createSession`'s `assertSafeSid`, so ANY such character made the
        // create throw AFTER `wm.add` had already built the on-disk worktree —
        // orphaning it. `sanitizeForSid` collapses every non-allowlist char to
        // '-' so the derived sid (and default worktree path) is always
        // allowlist-clean; the original `branch` is still passed to git verbatim.
        // Both derived values are local-only (no wire/schema impact).
        const safeBranch = sanitizeForSid(branch);
        const wtPath = path ?? `${safeBranch}-${ts}`;
        const wt = await wm.add(wtPath, branch, baseBranch);
        const sid = `${safeBranch}-${ts}`;

        // `wm.add` has now created the worktree on disk. Everything below can
        // still fail — `createSession` runs a synchronous SQLite write +
        // per-session DB open (disk-full / SQLITE_BUSY / corrupt page / a
        // base36-ts sid collision all throw). If it throws here, the catch in
        // `withWorktreeManager` would surface a `WORKTREE_ERROR` but leave the
        // freshly-created, session-less worktree orphaned on disk (the analog of
        // the documented deleteSession non-atomicity). Roll the worktree back so
        // a transient store failure does not accumulate orphan worktrees +
        // dangling branches. The rollback is best-effort and MUST NOT mask the
        // original failure: `wm.remove` can itself throw (git error), so it is
        // independently try/caught and we always re-throw the *original* error
        // for the user-facing frame. `force: true` because this is our own
        // just-created worktree with no committed work to protect.
        try {
          this.deps.createSession(sid, wt.path, { worktreePath: wt.path });
        } catch (createErr) {
          try {
            await wm.remove(wt.path, true);
            log.warn(
              `rolled back orphaned worktree at ${wt.path} after createSession failed`,
            );
          } catch (rollbackErr) {
            // Surface the cleanup failure for operator visibility, but keep the
            // original createSession error as the thrown/reported one.
            log.warn(
              `failed to roll back worktree at ${wt.path} after createSession failed: ${rollbackErr}`,
            );
          }
          throw createErr;
        }

        // Subscribe every relay client to the new sid IMMEDIATELY, before the
        // runner's IPC `hello` round-trips — mirroring session.create. Without
        // this, the relay forwards no frames for this sid until handleHello
        // subscribes (tens-to-hundreds of ms later), so the user's first
        // app→daemon input frames for a freshly created worktree session would
        // be silently dropped. Subscribing here closes that race window.
        for (const r of this.deps.getRelayClients()) {
          r.subscribe(sid);
        }

        relay
          .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
            t: "worktree.created",
            d: wt,
            sid,
          })
          .catch(() => {});
      },
    );
  }

  private handleRelayWorktreeRemove(
    relay: RelayClient,
    frontendId: string,
    path: string,
    force?: boolean,
  ): void {
    void this.withWorktreeManager(
      relay,
      frontendId,
      "Failed to remove worktree",
      async (wm) => {
        // ------------------------------------------------------------------
        // Live-session guard (refuse-non-force, kill-on-force).
        //
        // `git worktree remove` does NOT protect a *running* session whose
        // cwd is inside the worktree: a non-force remove succeeds against a
        // CLEAN worktree even with a live process inside it, and on POSIX
        // that process keeps running with a now-unlinked cwd (the kernel
        // holds the inode) — a live session silently loses its directory.
        // So we guard here, in the dispatcher, where the session<->worktree
        // mapping lives.
        //
        // Truth source = the LIVE runner map (`listRunners()`), not the
        // store's `state` column: a row can read "running" while its runner
        // has already exited (the reconcile is async), and blocking on such a
        // stale row would wrongly refuse a legitimate remove. Each live
        // runner's worktree path is `runner.worktreePath`, falling back to the
        // stored `worktree_path` for runners registered (via the hello IPC
        // path) without that field.
        const target = wm.canonicalize(path);
        const blockers = this.deps.sessionManager
          .listRunners()
          .map((runner) => {
            const wtPath =
              runner.worktreePath ??
              this.deps.store.getSession(runner.sid)?.worktree_path ??
              null;
            return { sid: runner.sid, wtPath, hasProcess: !!runner.process };
          })
          .filter(
            (r): r is { sid: string; wtPath: string; hasProcess: boolean } =>
              r.wtPath !== null && wm.canonicalize(r.wtPath) === target,
          );

        if (blockers.length > 0) {
          if (!force) {
            // Refuse: surface the blocking sids so the app can offer a
            // force-remove. `return` (not `throw`) so `withWorktreeManager`
            // does not also publish a second WORKTREE_ERROR frame.
            const sids = blockers.map((b) => b.sid).join(", ");
            relay
              .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
                t: "err",
                e: "WORKTREE_ERROR",
                m:
                  `Cannot remove worktree: ${blockers.length} running ` +
                  `session(s) (${sids}). Use force to kill and remove.`,
              })
              .catch(() => {});
            return;
          }

          // Force path. A blocker WITHOUT a tracked process is a runner this
          // daemon did not spawn (passthrough / registered-only) — we cannot
          // SIGTERM it, so `killRunner` would no-op and we'd remove the dir
          // out from under a live process. Refuse rather than orphan it.
          const unkillable = blockers.filter((b) => !b.hasProcess);
          if (unkillable.length > 0) {
            const sids = unkillable.map((b) => b.sid).join(", ");
            relay
              .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
                t: "err",
                e: "WORKTREE_ERROR",
                m:
                  `Cannot force-remove worktree: session(s) (${sids}) are ` +
                  `not managed by this daemon and cannot be killed.`,
              })
              .catch(() => {});
            return;
          }

          // Kill each blocking session and reconcile its store row BEFORE
          // touching the worktree on disk. Mirror `handleSessionDelete`:
          // kill -> (await exit) -> unregister -> stopped. We additionally
          // AWAIT process exit (waitForExit) because `killRunner` only sends
          // SIGTERM — without the await, `git worktree remove` would race the
          // dying PTY which still holds the worktree dir as its cwd. If any
          // step throws, the re-throw lets `withWorktreeManager` surface a
          // WORKTREE_ERROR and `wm.remove` is never reached (the safe
          // direction: worktree intact, no orphaned-cwd remove).
          for (const b of blockers) {
            this.deps.sessionManager.killRunner(b.sid);
            await this.deps.sessionManager.waitForExit(b.sid);
            this.deps.sessionManager.unregisterRunner(b.sid);
            this.deps.store.updateSessionState(b.sid, "stopped");
          }
          // Unsubscribe OUTSIDE the kill loop's failure path (matching
          // handleSessionDelete) so a partial-kill failure does not strand
          // relay subscriptions. Reached only after all kills succeeded.
          for (const client of this.deps.getRelayClients()) {
            for (const b of blockers) client.unsubscribe(b.sid);
          }
        }

        await wm.remove(path, force);
        relay
          .publishToPeer(frontendId, RELAY_CHANNEL_CONTROL, {
            t: "worktree.removed",
            path,
          })
          .catch(() => {});
      },
    );
  }

  private handleRelaySessionExport(
    relay: RelayClient,
    frontendId: string,
    msg: SessionExport,
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
    // Fetch one MORE than the limit so we can distinguish "exactly effectiveLimit
    // records" (complete export) from "more than effectiveLimit" (genuinely
    // truncated). `records.length >= effectiveLimit` was a false-positive at
    // exactly the limit — it flagged truncated:true even when the whole history
    // was returned, showing the user a bogus "results truncated" warning.
    const fetched = db.getRecordsFiltered({
      kinds: recordTypes,
      from: timeRange?.from,
      to: timeRange?.to,
      limit: effectiveLimit + 1,
    });
    const truncated = fetched.length > effectiveLimit;
    const records = truncated ? fetched.slice(0, effectiveLimit) : fetched;

    const meta = toSessionMeta(session);

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

function toNamespace(value: string | null): Namespace | undefined {
  if (value === null) return undefined;
  for (const v of NAMESPACE_SET) if (v === value) return v;
  return undefined;
}

function toSessionRecs(sid: string, records: StoredRecord[]): SessionRec[] {
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
