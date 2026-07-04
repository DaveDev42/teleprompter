import { describe, expect, test } from "bun:test";
import type {
  IpcAck,
  IpcBye,
  IpcHello,
  IpcMessage,
  IpcPairBegin,
  IpcPairCancel,
  IpcRec,
  Label,
  RelayControlMessage,
} from "@teleprompter/protocol";
import { FrameDecoder, makeLabel, QueuedWriter } from "@teleprompter/protocol";
import { resolve as nodeResolve } from "path";
import type { PushNotifier } from "../push/push-notifier";
import type {
  RunnerInfo,
  SessionManager,
  SpawnRunnerOptions,
} from "../session/session-manager";
import type { Store } from "../store";
import type { SessionDb } from "../store/session-db";
import type { SessionMeta } from "../store/store";
import type { RelayClient } from "../transport/relay-client";
import type { WorktreeManager } from "../worktree/worktree-manager";
import { IpcCommandDispatcher } from "./command-dispatcher";
import type { ConnectedRunner, IpcServer } from "./server";

/**
 * Minimal stub set for routing tests. The dispatcher owns no I/O — it
 * forwards to `ipcServer.send` / `relay.publishToPeer` and to injected
 * callbacks. We verify each message type lands in the expected collaborator.
 */
interface Calls {
  ipcSends: unknown[];
  storeCreateSession: Array<
    [string, string, string | undefined, string | undefined]
  >;
  storeUpdateState: Array<[string, string]>;
  storeUpdateLastSeq: Array<[string, number]>;
  storeDeleteSession: string[];
  sessionRegister: Array<
    [string, number, string, string | undefined, string | undefined]
  >;
  sessionUnregister: string[];
  killRunner: string[];
  waitForExit: string[];
  createSession: Array<[string, string, SpawnRunnerOptions | undefined]>;
  pairBegin: IpcPairBegin[];
  pairCancel: IpcPairCancel[];
  cliDisconnect: number;
  pushNotifier: unknown[];
  recordObserver: Array<[string, string, Buffer, string | undefined]>;
  removePairing: string[];
  renamePairing: Array<[string, Label]>;
}

function mkMeta(sid: string, state: string, updated_at: number): SessionMeta {
  return {
    sid,
    state,
    cwd: "/cwd",
    worktree_path: null,
    claude_version: null,
    created_at: updated_at,
    updated_at,
    last_seq: 0,
  };
}

function makeRunner(sid?: string): ConnectedRunner {
  // The dispatcher treats ConnectedRunner as opaque — we never drive the
  // socket, so real writer/decoder instances just satisfy the type.
  return {
    socket: null,
    writer: new QueuedWriter(),
    decoder: new FrameDecoder(),
    sid,
  };
}

function makeHarness(
  opts: {
    getWorktreeManager?: () => WorktreeManager | null;
    sessionMeta?: SessionMeta;
    sessions?: SessionMeta[];
    sessionDb?: SessionDb | undefined;
    relayClients?: RelayClient[];
    pairings?: Array<{ daemonId: string }>;
    removePairingResult?: (daemonId: string) => Promise<number>;
    renamePairingResult?: (daemonId: string, label: Label) => Promise<number>;
    runningSids?: string[];
    deleteSessionThrows?: (sid: string) => Error | null;
    createSessionThrows?: (sid: string) => Error | null;
    /** Seed the live runner registry (drives listRunners() for the
     * worktree.remove live-session guard). `hasProcess` controls whether the
     * RunnerInfo carries a tracked Subprocess — false models a passthrough /
     * registered-only runner this daemon did not spawn. */
    runners?: Array<{
      sid: string;
      worktreePath?: string | undefined;
      hasProcess?: boolean;
    }>;
    killRunnerThrows?: (sid: string) => Error | null;
  } = {},
) {
  const calls: Calls = {
    ipcSends: [],
    storeCreateSession: [],
    storeUpdateState: [],
    storeUpdateLastSeq: [],
    storeDeleteSession: [],
    sessionRegister: [],
    sessionUnregister: [],
    killRunner: [],
    waitForExit: [],
    createSession: [],
    pairBegin: [],
    pairCancel: [],
    cliDisconnect: 0,
    pushNotifier: [],
    recordObserver: [],
    removePairing: [],
    renamePairing: [],
  };

  const fakeSessions: SessionMeta[] = opts.sessions
    ? [...opts.sessions]
    : opts.sessionMeta
      ? [opts.sessionMeta]
      : [];
  const runningSet = new Set(opts.runningSids ?? []);

  const ipcServer: Pick<IpcServer, "send" | "findRunnerBySid"> = {
    send: (runner, msg) => {
      void runner;
      calls.ipcSends.push(msg);
    },
    findRunnerBySid: (sid) => (sid === "present" ? makeRunner(sid) : undefined),
  };

  const fakeDb = opts.sessionDb;
  const store: Pick<
    Store,
    | "createSession"
    | "updateSessionState"
    | "updateLastSeq"
    | "listSessions"
    | "getSession"
    | "getSessionDb"
    | "listPairings"
    | "deleteSession"
  > = {
    createSession: (sid, cwd, worktreePath, claudeVersion) => {
      calls.storeCreateSession.push([sid, cwd, worktreePath, claudeVersion]);
      // Not exercised by the dispatcher; return a stub to satisfy the type.
      return {} as SessionDb;
    },
    updateSessionState: (sid, state) => {
      calls.storeUpdateState.push([sid, state]);
    },
    updateLastSeq: (sid, seq) => {
      calls.storeUpdateLastSeq.push([sid, seq]);
    },
    listSessions: () => fakeSessions,
    getSession: (sid) => fakeSessions.find((s) => s.sid === sid),
    getSessionDb: () => fakeDb,
    listPairings: () =>
      (opts.pairings ?? []).map((p) => ({
        daemonId: p.daemonId,
        relayUrl: "ws://mock",
        label: { set: false } as Label,
        createdAt: 0,
      })),
    deleteSession: (sid) => {
      const err = opts.deleteSessionThrows?.(sid) ?? null;
      if (err) throw err;
      calls.storeDeleteSession.push(sid);
      const idx = fakeSessions.findIndex((s) => s.sid === sid);
      if (idx >= 0) fakeSessions.splice(idx, 1);
    },
  };

  // Mirror the real SessionManager's runner registry so the generation guard
  // in handleBye (getRunner → pid compare) is exercised against live state.
  const runnerRegistry = new Map<string, RunnerInfo>();
  // Seed the registry for the worktree.remove live-session guard, which scans
  // listRunners(). `hasProcess` (default true) controls whether the RunnerInfo
  // carries a tracked Subprocess: a sentinel object is enough since the guard
  // only checks truthiness of `runner.process`, never drives it.
  for (const r of opts.runners ?? []) {
    runnerRegistry.set(r.sid, {
      sid: r.sid,
      pid: 0,
      cwd: "/cwd",
      worktreePath: r.worktreePath,
      connectedAt: 0,
      process:
        r.hasProcess === false
          ? undefined
          : ({
              kill() {},
              exited: Promise.resolve(0),
            } as unknown as RunnerInfo["process"]),
    });
  }
  const sessionManager: Pick<
    SessionManager,
    | "registerRunner"
    | "unregisterRunner"
    | "killRunner"
    | "getRunner"
    | "listRunners"
    | "waitForExit"
  > = {
    registerRunner: (sid, pid, cwd, worktreePath, claudeVersion) => {
      calls.sessionRegister.push([sid, pid, cwd, worktreePath, claudeVersion]);
      runnerRegistry.set(sid, {
        sid,
        pid,
        cwd,
        worktreePath,
        claudeVersion,
        connectedAt: 0,
      });
    },
    unregisterRunner: (sid) => {
      calls.sessionUnregister.push(sid);
      runnerRegistry.delete(sid);
    },
    getRunner: (sid) => runnerRegistry.get(sid),
    listRunners: () => Array.from(runnerRegistry.values()),
    waitForExit: async (sid) => {
      calls.waitForExit.push(sid);
    },
    killRunner: (sid) => {
      calls.killRunner.push(sid);
      const err = opts.killRunnerThrows?.(sid) ?? null;
      if (err) throw err;
      if (runningSet.has(sid)) {
        runningSet.delete(sid);
        return true;
      }
      return sid === "present" || runnerRegistry.has(sid);
    },
  };

  const pushNotifier: Pick<PushNotifier, "onRecord"> = {
    onRecord: (info) => {
      calls.pushNotifier.push(info);
    },
  };

  const relayClients = opts.relayClients ?? [];

  const recordObserver:
    | ((sid: string, kind: string, payload: Buffer, name?: string) => void)
    | null = (sid, kind, payload, name) => {
    calls.recordObserver.push([sid, kind, payload, name]);
  };

  const dispatcher = new IpcCommandDispatcher({
    ipcServer: ipcServer as IpcServer,
    store: store as Store,
    sessionManager: sessionManager as SessionManager,
    pushNotifier: pushNotifier as PushNotifier,
    getWorktreeManager: opts.getWorktreeManager ?? (() => null),
    createSession: (sid, cwd, options) => {
      const err = opts.createSessionThrows?.(sid) ?? null;
      if (err) throw err;
      calls.createSession.push([sid, cwd, options]);
    },
    onPairBegin: (_runner, msg) => {
      calls.pairBegin.push(msg);
    },
    onPairCancel: (_runner, msg) => {
      calls.pairCancel.push(msg);
    },
    onCliDisconnect: () => {
      calls.cliDisconnect++;
    },
    removePairing: async (daemonId) => {
      calls.removePairing.push(daemonId);
      return opts.removePairingResult
        ? await opts.removePairingResult(daemonId)
        : 0;
    },
    renamePairing: async (daemonId, label) => {
      calls.renamePairing.push([daemonId, label]);
      return opts.renamePairingResult
        ? await opts.renamePairingResult(daemonId, label)
        : 0;
    },
    getOnRecord: () => recordObserver,
    getRelayClients: () => relayClients,
    getRelayHealth: () =>
      relayClients.map((c) => ({
        daemonId: c.daemonId,
        relayUrl: c.relayUrl,
        connected: c.isConnected(),
        peerCount: c.getPeerCount(),
        throttled: c.isThrottled(),
      })),
  });

  return { dispatcher, calls };
}

/** Build a minimal RelayClient whose publishToPeer records into `out`. */
function fakeRelay(
  out: Array<{ frontendId: string; sid: string; msg: unknown }>,
): RelayClient {
  return {
    publishToPeer: async (frontendId: string, sid: string, msg: unknown) => {
      out.push({ frontendId, sid, msg });
    },
    peerPctB64: () => undefined,
  } as unknown as RelayClient;
}

describe("IpcCommandDispatcher.dispatchIpc", () => {
  test("routes pair.begin to onPairBegin callback", () => {
    const { dispatcher, calls } = makeHarness();
    const runner = makeRunner();
    const msg: IpcPairBegin = {
      t: "pair.begin",
      relayUrl: "wss://r",
      daemonId: "d1",
    };
    dispatcher.dispatchIpc(runner, msg);
    expect(calls.pairBegin).toEqual([msg]);
    expect(calls.pairCancel).toEqual([]);
  });

  test("routes pair.cancel to onPairCancel callback", () => {
    const { dispatcher, calls } = makeHarness();
    const msg: IpcPairCancel = { t: "pair.cancel", pairingId: "pp-1" };
    dispatcher.dispatchIpc(makeRunner(), msg);
    expect(calls.pairCancel).toEqual([msg]);
    expect(calls.pairBegin).toEqual([]);
  });

  test("pair.remove dispatches removePairing and replies pair.remove.ok", async () => {
    const { dispatcher, calls } = makeHarness({
      pairings: [{ daemonId: "d1" }],
      removePairingResult: async () => 2,
    });
    const runner = makeRunner();
    dispatcher.dispatchIpc(runner, { t: "pair.remove", daemonId: "d1" });
    // Wait one microtask tick for the async handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.removePairing).toEqual(["d1"]);
    expect(calls.ipcSends).toEqual([
      { t: "pair.remove.ok", daemonId: "d1", notifiedPeers: 2 },
    ]);
  });

  test("pair.remove replies pair.remove.err not-found when no matching pairing", async () => {
    const { dispatcher, calls } = makeHarness({ pairings: [] });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "pair.remove",
      daemonId: "missing",
    });
    await Promise.resolve();
    expect(calls.removePairing).toEqual([]);
    expect(calls.ipcSends).toEqual([
      { t: "pair.remove.err", daemonId: "missing", reason: "not-found" },
    ]);
  });

  test("pair.remove replies pair.remove.err internal when remove throws", async () => {
    const { dispatcher, calls } = makeHarness({
      pairings: [{ daemonId: "d1" }],
      removePairingResult: async () => {
        throw new Error("db write failed");
      },
    });
    dispatcher.dispatchIpc(makeRunner(), { t: "pair.remove", daemonId: "d1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.ipcSends).toEqual([
      {
        t: "pair.remove.err",
        daemonId: "d1",
        reason: "internal",
        message: "db write failed",
      },
    ]);
  });

  test("pair.rename dispatches renamePairing and replies pair.rename.ok", async () => {
    const { dispatcher, calls } = makeHarness({
      pairings: [{ daemonId: "d1" }],
      renamePairingResult: async () => 1,
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "pair.rename",
      daemonId: "d1",
      label: makeLabel("Office Mac"),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.renamePairing).toEqual([
      ["d1", { set: true, value: "Office Mac" }],
    ]);
    expect(calls.ipcSends).toEqual([
      {
        t: "pair.rename.ok",
        daemonId: "d1",
        label: { set: true, value: "Office Mac" },
        notifiedPeers: 1,
      },
    ]);
  });

  test("pair.rename with an unset label (clear) round-trips through reply", async () => {
    const { dispatcher, calls } = makeHarness({
      pairings: [{ daemonId: "d1" }],
      renamePairingResult: async () => 0,
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "pair.rename",
      daemonId: "d1",
      label: { set: false },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.renamePairing).toEqual([["d1", { set: false }]]);
    expect(calls.ipcSends).toEqual([
      {
        t: "pair.rename.ok",
        daemonId: "d1",
        label: { set: false },
        notifiedPeers: 0,
      },
    ]);
  });

  test("pair.rename replies pair.rename.err not-found when pairing missing", async () => {
    const { dispatcher, calls } = makeHarness({ pairings: [] });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "pair.rename",
      daemonId: "missing",
      label: makeLabel("x"),
    });
    await Promise.resolve();
    expect(calls.renamePairing).toEqual([]);
    expect(calls.ipcSends).toEqual([
      { t: "pair.rename.err", daemonId: "missing", reason: "not-found" },
    ]);
  });

  test("session.delete on a stopped session replies ok without killing a runner", async () => {
    const meta: SessionMeta = {
      sid: "s-stopped",
      state: "stopped",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 2,
      last_seq: 0,
    };
    const { dispatcher, calls } = makeHarness({ sessionMeta: meta });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.delete",
      sid: "s-stopped",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.killRunner).toEqual([]);
    expect(calls.storeDeleteSession).toEqual(["s-stopped"]);
    expect(calls.ipcSends).toEqual([
      { t: "session.delete.ok", sid: "s-stopped", wasRunning: false },
    ]);
  });

  test("session.delete unsubscribes the deleted sid from every relay client (rank 8)", async () => {
    // The IPC (CLI) session.delete path must mirror the relay-plane path and
    // unsubscribe relay clients for the deleted sid — otherwise each client's
    // subscribedSessions Set keeps a stale entry.
    const meta: SessionMeta = {
      sid: "s-stopped",
      state: "stopped",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 2,
      last_seq: 0,
    };
    const unsubscribed: string[] = [];
    const removed: Array<{ sid: string; msg: unknown }> = [];
    const relay = {
      unsubscribe: (sid: string) => unsubscribed.push(sid),
      publishRemoved: async (sid: string, msg: unknown) => {
        removed.push({ sid, msg });
      },
    } as unknown as RelayClient;
    const { dispatcher } = makeHarness({
      sessionMeta: meta,
      relayClients: [relay],
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.delete",
      sid: "s-stopped",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(unsubscribed).toEqual(["s-stopped"]);
    // A viewer currently attached to the deleted sid must be notified with a
    // `session.removed` frame — not just have the relay subscription dropped
    // (which alone leaves the frontend to discover the deletion only on its
    // next `hello` snapshot).
    expect(removed).toEqual([
      { sid: "s-stopped", msg: { t: "session.removed", sid: "s-stopped" } },
    ]);
  });

  test("session.prune unsubscribes each pruned sid from every relay client (rank 8)", async () => {
    const old: SessionMeta = {
      sid: "s-old",
      state: "stopped",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 1,
      last_seq: 0,
    };
    const unsubscribed: string[] = [];
    const removed: Array<{ sid: string; msg: unknown }> = [];
    const relay = {
      unsubscribe: (sid: string) => unsubscribed.push(sid),
      publishRemoved: async (sid: string, msg: unknown) => {
        removed.push({ sid, msg });
      },
    } as unknown as RelayClient;
    const { dispatcher } = makeHarness({
      sessions: [old],
      relayClients: [relay],
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "all" },
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(unsubscribed).toEqual(["s-old"]);
    expect(removed).toEqual([
      { sid: "s-old", msg: { t: "session.removed", sid: "s-old" } },
    ]);
  });

  test("session.delete on a running session kills the runner then deletes", async () => {
    const meta: SessionMeta = {
      sid: "s-running",
      state: "running",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 2,
      last_seq: 0,
    };
    const { dispatcher, calls } = makeHarness({
      sessionMeta: meta,
      runningSids: ["s-running"],
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.delete",
      sid: "s-running",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.killRunner).toEqual(["s-running"]);
    // Regression: killRunner only signals the process; the in-memory runner
    // registration must also be dropped synchronously (else activeCount/
    // listRunners leak a dead entry until the async exit handler runs).
    expect(calls.sessionUnregister).toEqual(["s-running"]);
    expect(calls.storeDeleteSession).toEqual(["s-running"]);
    expect(calls.ipcSends).toEqual([
      { t: "session.delete.ok", sid: "s-running", wasRunning: true },
    ]);
  });

  test("session.delete replies not-found when sid missing", async () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.delete",
      sid: "missing",
    });
    await Promise.resolve();
    expect(calls.storeDeleteSession).toEqual([]);
    expect(calls.ipcSends).toEqual([
      { t: "session.delete.err", sid: "missing", reason: "not-found" },
    ]);
  });

  test("session.delete replies internal when deleteSession throws", async () => {
    const meta: SessionMeta = {
      sid: "s-err",
      state: "stopped",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 2,
      last_seq: 0,
    };
    const { dispatcher, calls } = makeHarness({
      sessionMeta: meta,
      deleteSessionThrows: () => new Error("disk full"),
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.delete",
      sid: "s-err",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.ipcSends).toEqual([
      {
        t: "session.delete.err",
        sid: "s-err",
        reason: "internal",
        message: "disk full",
      },
    ]);
  });

  test("session.prune selects stopped/error sessions older than cutoff", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      mkMeta("old-stopped", "stopped", now - 10_000),
      mkMeta("new-stopped", "stopped", now - 100),
      mkMeta("old-running", "running", now - 10_000),
      mkMeta("old-error", "error", now - 10_000),
    ];
    const { dispatcher, calls } = makeHarness({ sessions });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 5_000 },
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.storeDeleteSession.sort()).toEqual([
      "old-error",
      "old-stopped",
    ]);
    expect(calls.killRunner).toEqual([]);
    const reply = calls.ipcSends[0] as {
      t: string;
      sids: string[];
      runningKilled: number;
      dryRun: boolean;
    };
    expect(reply.t).toBe("session.prune.ok");
    expect(reply.sids.sort()).toEqual(["old-error", "old-stopped"]);
    expect(reply.runningKilled).toBe(0);
    expect(reply.dryRun).toBe(false);
  });

  test("session.prune with dryRun reports selection without deleting", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      mkMeta("s1", "stopped", now - 10_000),
      mkMeta("s2", "stopped", now - 10_000),
    ];
    const { dispatcher, calls } = makeHarness({ sessions });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 5_000 },
      includeRunning: false,
      dryRun: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.storeDeleteSession).toEqual([]);
    const reply = calls.ipcSends[0] as { sids: string[]; dryRun: boolean };
    expect(reply.sids.sort()).toEqual(["s1", "s2"]);
    expect(reply.dryRun).toBe(true);
  });

  test("session.prune with includeRunning kills running sessions first", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      mkMeta("r1", "running", now - 10_000),
      mkMeta("s1", "stopped", now - 10_000),
    ];
    const { dispatcher, calls } = makeHarness({
      sessions,
      runningSids: ["r1"],
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 5_000 },
      includeRunning: true,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.killRunner).toEqual(["r1"]);
    // Same leak guard as session.delete: the killed running session's
    // in-memory registration must be unregistered, not just signaled.
    expect(calls.sessionUnregister).toEqual(["r1"]);
    expect(calls.storeDeleteSession.sort()).toEqual(["r1", "s1"]);
    const reply = calls.ipcSends[0] as { runningKilled: number };
    expect(reply.runningKilled).toBe(1);
  });

  test("session.prune with age:{kind:'all'} and includeRunning=true matches everything", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      mkMeta("r1", "running", now),
      mkMeta("s1", "stopped", now),
    ];
    const { dispatcher, calls } = makeHarness({
      sessions,
      runningSids: ["r1"],
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "all" },
      includeRunning: true,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.storeDeleteSession.sort()).toEqual(["r1", "s1"]);
  });

  test("session.prune with age:{kind:'all'} prunes a stopped session ignoring its age", async () => {
    // The session's updated_at is `now` (just created) — an olderThan filter
    // would skip it, but `kind:'all'` must select it regardless.
    const now = Date.now();
    const sessions: SessionMeta[] = [mkMeta("s-fresh", "stopped", now)];
    const { dispatcher, calls } = makeHarness({ sessions });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "all" },
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.storeDeleteSession).toEqual(["s-fresh"]);
  });

  test("session.prune with age:{kind:'olderThan',ms:...} respects the cutoff", async () => {
    // A very large ms means "older than a huge age" — recently-updated sessions
    // must NOT be deleted. This pins the data-loss guard introduced in PR-B.
    const now = Date.now();
    const recentSid = "s-recent";
    const oldSid = "s-old";
    const sessions: SessionMeta[] = [
      mkMeta(recentSid, "stopped", now - 100), // 100 ms old
      mkMeta(oldSid, "stopped", now - 100_000_000), // ~27 hours old
    ];
    const { dispatcher, calls } = makeHarness({ sessions });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 3_600_000 }, // 1 hour
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.storeDeleteSession).toEqual([oldSid]);
    // recent session must be untouched
    expect(calls.storeDeleteSession).not.toContain(recentSid);
  });

  test("session.prune with no matches still replies ok with empty sids", async () => {
    const { dispatcher, calls } = makeHarness({ sessions: [] });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 5_000 },
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const reply = calls.ipcSends[0] as {
      t: string;
      sids: string[];
      runningKilled: number;
      dryRun: boolean;
    };
    expect(reply).toEqual({
      t: "session.prune.ok",
      sids: [],
      runningKilled: 0,
      dryRun: false,
    });
  });

  test("session.prune replies internal with partialSids when a deleteSession throws mid-run", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      mkMeta("s1", "stopped", now - 10_000),
      mkMeta("s2", "stopped", now - 10_000),
      mkMeta("s3", "stopped", now - 10_000),
    ];
    const { dispatcher, calls } = makeHarness({
      sessions,
      deleteSessionThrows: (sid) => (sid === "s2" ? new Error("locked") : null),
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 5_000 },
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const reply = calls.ipcSends[0] as {
      t: string;
      reason?: string;
      partialSids?: string[];
      partialRunningKilled?: number;
    };
    expect(reply.t).toBe("session.prune.err");
    expect(reply.reason).toBe("internal");
    // s1 succeeded before s2 threw; s3 never ran. partialSids must name s1.
    expect(reply.partialSids).toEqual(["s1"]);
    // No runners were running, so no kills happened.
    expect(reply.partialRunningKilled).toBe(0);
  });

  test("session.prune err tracks partialRunningKilled alongside partialSids", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      mkMeta("r1", "running", now - 10_000),
      mkMeta("r2", "running", now - 10_000),
      mkMeta("r3", "stopped", now - 10_000),
    ];
    const { dispatcher, calls } = makeHarness({
      sessions,
      runningSids: ["r1", "r2"],
      // killRunner for r2 succeeds; then deleteSession(r2) throws.
      deleteSessionThrows: (sid) => (sid === "r2" ? new Error("locked") : null),
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      age: { kind: "olderThan", ms: 5_000 },
      includeRunning: true,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const reply = calls.ipcSends[0] as {
      t: string;
      partialSids?: string[];
      partialRunningKilled?: number;
    };
    expect(reply.t).toBe("session.prune.err");
    // r1 fully processed; r2 killed but delete threw; r3 never reached.
    expect(reply.partialSids).toEqual(["r1"]);
    // r1 + r2 were both killed — partialRunningKilled can exceed partialSids.
    expect(reply.partialRunningKilled).toBe(2);
  });

  test("hello creates session row, registers runner, and notifies relays", () => {
    const seenSubscribes: string[] = [];
    const seenStates: unknown[] = [];
    const relay = {
      subscribe: (sid: string) => seenSubscribes.push(sid),
      publishState: async (_sid: string, state: unknown) => {
        seenStates.push(state);
      },
    } as unknown as RelayClient;
    const meta: SessionMeta = {
      sid: "s1",
      state: "running",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 1,
      last_seq: 0,
    };
    const { dispatcher, calls } = makeHarness({
      sessionMeta: meta,
      relayClients: [relay],
    });
    const hello: IpcHello = {
      t: "hello",
      sid: "s1",
      cwd: "/cwd",
      pid: 42,
    };
    dispatcher.dispatchIpc(makeRunner(), hello);
    expect(calls.storeCreateSession).toEqual([
      ["s1", "/cwd", undefined, undefined],
    ]);
    expect(calls.sessionRegister).toEqual([
      ["s1", 42, "/cwd", undefined, undefined],
    ]);
    expect(seenSubscribes).toEqual(["s1"]);
    expect(seenStates.length).toBe(1);
  });

  test("rec appends to session db, sends ack, and fans out to relays and observer", () => {
    let appendedSeq = 0;
    const sessionDb = {
      append: () => {
        appendedSeq = 7;
        return appendedSeq;
      },
    } as unknown as SessionDb;
    const relayRecs: unknown[] = [];
    const relay = {
      publishRecord: async (rec: unknown) => {
        relayRecs.push(rec);
      },
    } as unknown as RelayClient;

    const { dispatcher, calls } = makeHarness({
      sessionDb,
      relayClients: [relay],
    });
    const rec: IpcRec = {
      t: "rec",
      sid: "s1",
      kind: "io",
      ts: 123,
      payload: Buffer.from("hi").toString("base64"),
    };
    dispatcher.dispatchIpc(makeRunner("s1"), rec);

    // ack sent
    const ack = calls.ipcSends[0] as IpcAck;
    expect(ack.t).toBe("ack");
    expect(ack.seq).toBe(7);
    // relay and observer called
    expect(relayRecs.length).toBe(1);
    expect(calls.recordObserver.length).toBe(1);
    expect(calls.pushNotifier.length).toBe(1);
    expect(calls.storeUpdateLastSeq).toEqual([["s1", 7]]);
  });

  test("rec for unknown session logs and does not ack", () => {
    const { dispatcher, calls } = makeHarness({ sessionDb: undefined });
    const rec: IpcRec = {
      t: "rec",
      sid: "missing",
      kind: "io",
      ts: 0,
      payload: "",
    };
    dispatcher.dispatchIpc(makeRunner(), rec);
    expect(calls.ipcSends).toEqual([]);
    expect(calls.storeUpdateLastSeq).toEqual([]);
  });

  test("bye updates session state and notifies relays", () => {
    const relayStates: unknown[] = [];
    const relay = {
      publishState: async (_sid: string, s: unknown) => {
        relayStates.push(s);
      },
    } as unknown as RelayClient;
    const meta: SessionMeta = {
      sid: "s1",
      state: "stopped",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 1,
      last_seq: 0,
    };
    const { dispatcher, calls } = makeHarness({
      sessionMeta: meta,
      relayClients: [relay],
    });
    const bye: IpcBye = { t: "bye", sid: "s1", exitCode: 0 };
    dispatcher.dispatchIpc(makeRunner(), bye);
    expect(calls.storeUpdateState).toEqual([["s1", "stopped"]]);
    expect(calls.sessionUnregister).toEqual(["s1"]);
    expect(relayStates.length).toBe(1);
  });

  test("bye with nonzero exit sets error state", () => {
    const { dispatcher, calls } = makeHarness();
    const bye: IpcBye = { t: "bye", sid: "s1", exitCode: 1 };
    dispatcher.dispatchIpc(makeRunner(), bye);
    expect(calls.storeUpdateState).toEqual([["s1", "error"]]);
  });

  // Fix #2 regression: a user-initiated Stop/restart sends a non-zero
  // synthetic exitCode (130/143 from SIGINT/SIGTERM, -1 from IPC socket
  // teardown) that is NOT claude's real process exit status. Before this fix,
  // handleBye read that as a crash and set state "error" (red dot in the
  // app), even though the stop was fully expected. `reason: "signal"` must
  // always win over exitCode.
  test("bye with reason=signal and nonzero exitCode is 'stopped', not 'error'", () => {
    const { dispatcher, calls } = makeHarness();
    const bye: IpcBye = {
      t: "bye",
      sid: "s1",
      exitCode: 143,
      reason: "signal",
    };
    dispatcher.dispatchIpc(makeRunner(), bye);
    expect(calls.storeUpdateState).toEqual([["s1", "stopped"]]);
  });

  test("bye with reason=exit and nonzero exitCode is still 'error' (genuine crash)", () => {
    const { dispatcher, calls } = makeHarness();
    const bye: IpcBye = { t: "bye", sid: "s1", exitCode: 1, reason: "exit" };
    dispatcher.dispatchIpc(makeRunner(), bye);
    expect(calls.storeUpdateState).toEqual([["s1", "error"]]);
  });

  test("bye with reason absent and nonzero exitCode falls back to 'error' (wire back-compat)", () => {
    const { dispatcher, calls } = makeHarness();
    const bye: IpcBye = { t: "bye", sid: "s1", exitCode: 1 };
    dispatcher.dispatchIpc(makeRunner(), bye);
    expect(calls.storeUpdateState).toEqual([["s1", "error"]]);
  });

  test("bye with reason absent and exitCode=0 is 'stopped' (wire back-compat)", () => {
    const { dispatcher, calls } = makeHarness();
    const bye: IpcBye = { t: "bye", sid: "s1", exitCode: 0 };
    dispatcher.dispatchIpc(makeRunner(), bye);
    expect(calls.storeUpdateState).toEqual([["s1", "stopped"]]);
  });

  test("stale bye from the old runner does not corrupt a restarted session", () => {
    // session.restart kills the old Runner (pid=100) and spawns a new one
    // (pid=200) for the same sid. If the old Runner's SIGTERM bye (pid=100,
    // exitCode!=0) arrives AFTER the new generation's hello has registered,
    // processing it would mark the live session "error" and unregister the
    // freshly-registered new Runner — orphaning a running PTY. The generation
    // guard must drop the stale bye.
    const { dispatcher, calls } = makeHarness();

    // New generation registers (the daemon processed the new Runner's hello).
    const hello: IpcHello = { t: "hello", sid: "s1", cwd: "/cwd", pid: 200 };
    dispatcher.dispatchIpc(makeRunner(), hello);
    expect(calls.sessionRegister).toEqual([
      ["s1", 200, "/cwd", undefined, undefined],
    ]);

    // Old generation's stale bye lands afterwards.
    const staleBye: IpcBye = { t: "bye", sid: "s1", exitCode: 143, pid: 100 };
    dispatcher.dispatchIpc(makeRunner(), staleBye);

    // The stale bye is ignored: the live session is NOT flipped to "error" and
    // the new Runner is NOT unregistered. (hello drives state via createSession,
    // not updateSessionState, so the guard's job here is to not append
    // ["s1","error"] and not unregister the freshly-registered new Runner.)
    expect(calls.storeUpdateState).toEqual([]);
    expect(calls.sessionUnregister).toEqual([]);
  });

  test("matching bye from the current runner is processed normally", () => {
    // The companion to the stale-bye guard: a bye whose pid matches the
    // currently-registered Runner is the legitimate end-of-session signal and
    // must still tear the session down.
    const { dispatcher, calls } = makeHarness();

    const hello: IpcHello = { t: "hello", sid: "s1", cwd: "/cwd", pid: 200 };
    dispatcher.dispatchIpc(makeRunner(), hello);

    const bye: IpcBye = { t: "bye", sid: "s1", exitCode: 0, pid: 200 };
    dispatcher.dispatchIpc(makeRunner(), bye);

    expect(calls.storeUpdateState).toEqual([["s1", "stopped"]]);
    expect(calls.sessionUnregister).toEqual(["s1"]);
  });

  test("daemon→runner message types (ack/input/etc.) are ignored silently", () => {
    const { dispatcher, calls } = makeHarness();
    const stray: IpcMessage = { t: "ack", sid: "s1", seq: 0 };
    dispatcher.dispatchIpc(makeRunner(), stray);
    expect(calls.ipcSends).toEqual([]);
    expect(calls.storeCreateSession).toEqual([]);
  });

  test("handleRunnerDisconnect delegates to onCliDisconnect", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.handleRunnerDisconnect(makeRunner());
    expect(calls.cliDisconnect).toBe(1);
  });

  test("doctor.probe replies with relay health from live clients", () => {
    // Build a minimal fake RelayClient with the public surface the handler uses.
    const fakeClient = {
      daemonId: "d1",
      relayUrl: "wss://relay.example.com",
      isConnected: () => true,
      getPeerCount: () => 2,
      isThrottled: () => false,
    } as unknown as RelayClient;

    const { dispatcher, calls } = makeHarness({ relayClients: [fakeClient] });
    const runner = makeRunner();
    dispatcher.dispatchIpc(runner, { t: "doctor.probe" });

    expect(calls.ipcSends).toEqual([
      {
        t: "doctor.probe.ok",
        relays: [
          {
            daemonId: "d1",
            relayUrl: "wss://relay.example.com",
            connected: true,
            peerCount: 2,
            throttled: false,
          },
        ],
      },
    ]);
  });

  test("doctor.probe surfaces the throttled flag for a peerless (idle) pairing", () => {
    // A dead/idle pairing: reconnecting but no frontend ever joined, so the
    // client has backed off (isThrottled → true) and reports disconnected. The
    // handler must carry `throttled: true` so the CLI can render this as idle
    // rather than "relay unreachable or auth failed".
    const idleClient = {
      daemonId: "d-idle",
      relayUrl: "wss://relay.example.com",
      isConnected: () => false,
      getPeerCount: () => 0,
      isThrottled: () => true,
    } as unknown as RelayClient;

    const { dispatcher, calls } = makeHarness({ relayClients: [idleClient] });
    const runner = makeRunner();
    dispatcher.dispatchIpc(runner, { t: "doctor.probe" });

    expect(calls.ipcSends).toEqual([
      {
        t: "doctor.probe.ok",
        relays: [
          {
            daemonId: "d-idle",
            relayUrl: "wss://relay.example.com",
            connected: false,
            peerCount: 0,
            throttled: true,
          },
        ],
      },
    ]);
  });

  test("doctor.probe replies with empty relays when no pairings", () => {
    const { dispatcher, calls } = makeHarness({ relayClients: [] });
    const runner = makeRunner();
    dispatcher.dispatchIpc(runner, { t: "doctor.probe" });
    expect(calls.ipcSends).toEqual([{ t: "doctor.probe.ok", relays: [] }]);
  });

  // CLI passthrough service-daemon path: input/resize forwarding
  // The dispatcher must forward `input` / `resize` messages from any IPC
  // connection (including a CLI passthrough client) to the runner identified
  // by `msg.sid`. This is the mechanism that lets `passthroughViaServiceDaemon`
  // relay local stdin and resize events to the runner without the CLI opening
  // its own relay WebSocket (architecture invariant: only the daemon opens relay WS).
  test("input message is forwarded to the runner for matching sid", () => {
    const { dispatcher, calls } = makeHarness();
    // "present" is the sid that makeHarness's findRunnerBySid resolves.
    dispatcher.dispatchIpc(makeRunner(), {
      t: "input",
      sid: "present",
      data: "aGVsbG8=", // base64("hello")
    });
    expect(calls.ipcSends).toEqual([
      { t: "input", sid: "present", data: "aGVsbG8=" },
    ]);
  });

  test("input message is silently dropped when no runner found for sid", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchIpc(makeRunner(), {
      t: "input",
      sid: "unknown-sid",
      data: "dGVzdA==",
    });
    // No IPC send — runner not found, no error reply (fire-and-forget).
    expect(calls.ipcSends).toEqual([]);
  });

  test("resize message is forwarded to the runner for matching sid", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchIpc(makeRunner(), {
      t: "resize",
      sid: "present",
      cols: 200,
      rows: 50,
    });
    expect(calls.ipcSends).toEqual([
      { t: "resize", sid: "present", cols: 200, rows: 50 },
    ]);
  });

  test("resize message is silently dropped when no runner found for sid", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchIpc(makeRunner(), {
      t: "resize",
      sid: "unknown-sid",
      cols: 80,
      rows: 24,
    });
    expect(calls.ipcSends).toEqual([]);
  });
});

describe("IpcCommandDispatcher.dispatchRelayControl", () => {
  test("hello replies on the meta channel with session list", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const meta: SessionMeta = {
      sid: "s1",
      state: "running",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 1,
      last_seq: 0,
    };
    const { dispatcher } = makeHarness({ sessionMeta: meta });
    const msg: RelayControlMessage = { t: "hello", v: 1 };
    dispatcher.dispatchRelayControl(fakeRelay(out), msg, "front-1");
    // publishToPeer is fire-and-forget; settle queued microtasks.
    await Promise.resolve();
    expect(out.length).toBe(1);
    expect(out[0]?.frontendId).toBe("front-1");
    expect(out[0]?.sid).toBe("__meta__");
    // Legacy pairing (peerPctB64 → undefined): the on-demand hello omits pct.
    expect("pct" in (out[0]?.msg as { d: Record<string, unknown> }).d).toBe(
      false,
    );
  });

  test("on-demand hello carries the pct when the peer is confirmed", async () => {
    // The on-demand `case \"hello\"` (relay-side) must mirror the auto-hello in
    // relay-manager's onFrontendJoined — both builders carry the tag, or an
    // on-demand hello would downgrade the app's confirmed state.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness();
    const relay = {
      publishToPeer: async (frontendId: string, sid: string, msg: unknown) => {
        out.push({ frontendId, sid, msg });
      },
      peerPctB64: (fid: string) =>
        fid === "front-1" ? "cGN0LWJhc2U2NA==" : undefined,
    } as unknown as RelayClient;
    dispatcher.dispatchRelayControl(relay, { t: "hello", v: 1 }, "front-1");
    await Promise.resolve();
    const d = (out[0]?.msg as { d: { pct?: string } }).d;
    expect(d.pct).toBe("cGN0LWJhc2U2NA==");
  });

  test("attach on known sid replies with state", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const meta: SessionMeta = {
      sid: "s1",
      state: "running",
      cwd: "/cwd",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 1,
      last_seq: 0,
    };
    const { dispatcher } = makeHarness({ sessionMeta: meta });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "attach", sid: "s1" },
      "f1",
    );
    await Promise.resolve();
    const m = out[0]?.msg as { t: string };
    expect(m.t).toBe("state");
  });

  test("attach on unknown sid replies with NOT_FOUND err", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "attach", sid: "missing" },
      "f1",
    );
    await Promise.resolve();
    const m = out[0]?.msg as { t: string; e?: string };
    expect(m.t).toBe("err");
    expect(m.e).toBe("NOT_FOUND");
  });

  test("ping replies pong on the control channel", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness();
    dispatcher.dispatchRelayControl(fakeRelay(out), { t: "ping" }, "f1");
    await Promise.resolve();
    expect(out.length).toBe(1);
    expect(out[0]?.sid).toBe("__control__");
    expect((out[0]?.msg as { t: string }).t).toBe("pong");
  });

  test("session.create calls the createSession injector", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay([]),
      { t: "session.create", cwd: "/cwd", sid: "new" },
      "f1",
    );
    expect(calls.createSession).toEqual([
      ["new", "/cwd", { cols: undefined, rows: undefined }],
    ]);
  });

  test("session.create forwards cols/rows to the createSession injector", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay([]),
      { t: "session.create", cwd: "/cwd", sid: "new", cols: 150, rows: 50 },
      "f1",
    );
    expect(calls.createSession).toEqual([
      ["new", "/cwd", { cols: 150, rows: 50 }],
    ]);
  });

  test("session.create subscribes relay clients to the new sid immediately (no hello race)", async () => {
    // M5: the relay must be subscribed to the new sid the moment the create is
    // accepted — NOT only after the runner's IPC hello round-trips. Otherwise
    // early app→daemon frames for the new sid are dropped by the relay.
    const seenSubscribes: string[] = [];
    const relayClient = {
      subscribe: (sid: string) => seenSubscribes.push(sid),
    } as unknown as RelayClient;
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({ relayClients: [relayClient] });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.create", cwd: "/cwd", sid: "new" },
      "f1",
    );
    await Promise.resolve();
    // Subscribed before any runner hello (no IPC roundtrip in this test).
    expect(seenSubscribes).toEqual(["new"]);
  });

  test("session.create replies session.create.ok to the originating frontend on success", async () => {
    // M6: a synchronous success ack mirrors the existing error reply, so the
    // app can optimistically attach without waiting for the state broadcast.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.create", cwd: "/cwd", sid: "new" },
      "f1",
    );
    await Promise.resolve();
    const ack = out.find(
      (o) => (o.msg as { t?: string }).t === "session.create.ok",
    );
    expect(ack).toBeDefined();
    expect(ack?.frontendId).toBe("f1");
    expect(ack?.sid).toBe("new");
    expect((ack?.msg as { sid?: string }).sid).toBe("new");
  });

  test("session.create replies err SESSION_ERROR and does not subscribe when createSession throws", async () => {
    const seenSubscribes: string[] = [];
    const relayClient = {
      subscribe: (sid: string) => seenSubscribes.push(sid),
    } as unknown as RelayClient;
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({
      relayClients: [relayClient],
      createSessionThrows: () => new Error("boom"),
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.create", cwd: "/cwd", sid: "bad" },
      "f1",
    );
    await Promise.resolve();
    const m = out[0]?.msg as { t: string; e?: string; m?: string };
    expect(m.t).toBe("err");
    expect(m.e).toBe("SESSION_ERROR");
    expect(m.m).toBe("boom");
    // On failure we must NOT subscribe and must NOT send a success ack.
    expect(seenSubscribes).toEqual([]);
    expect(
      out.some((o) => (o.msg as { t?: string }).t === "session.create.ok"),
    ).toBe(false);
  });

  test("session.create with a path-traversal sid is rejected BEFORE createSession/subscribe (rank 3)", async () => {
    // Frontend-supplied sid reaches Store's join(storeDir,'sessions',sid+'.sqlite').
    // A crafted `../../evil` must be rejected by assertSafeSid at the dispatch arm
    // with ZERO side-effects: createSession is never invoked (no arbitrary-path
    // file create/unlink), no relay subscription leaks, and an err is returned.
    // This is stronger than the createSession-throws case above — here the
    // createSession injector must never even be CALLED.
    const seenSubscribes: string[] = [];
    const relayClient = {
      subscribe: (sid: string) => seenSubscribes.push(sid),
    } as unknown as RelayClient;
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness({ relayClients: [relayClient] });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.create", cwd: "/cwd", sid: "../../evil" },
      "f1",
    );
    await Promise.resolve();
    // Guard fired before the injector — no path-join ever happened.
    expect(calls.createSession).toEqual([]);
    // No subscription leaked, no success ack, and an err was sent.
    expect(seenSubscribes).toEqual([]);
    expect(
      out.some((o) => (o.msg as { t?: string }).t === "session.create.ok"),
    ).toBe(false);
    const m = out[0]?.msg as { t: string; e?: string; m?: string };
    expect(m.t).toBe("err");
    expect(m.e).toBe("SESSION_ERROR");
    expect(m.m).toMatch(/invalid sid/);
  });

  // Rank-4 regression (daemon-audit): the export handler fetches
  // `effectiveLimit + 1` rows and flags truncated only when MORE than
  // effectiveLimit came back. The pre-fix `records.length >= effectiveLimit`
  // was a false-positive AT exactly the limit — it reported truncated:true even
  // when the entire history fit, showing the user a bogus warning.
  function exportHarness(rowCount: number, limit?: number) {
    let askedLimit = -1;
    const sessionDb = {
      getRecordsFiltered: (o: { limit?: number }) => {
        askedLimit = o.limit ?? -1;
        // Honor the requested limit (the handler asks for effectiveLimit+1).
        const n = Math.min(rowCount, o.limit ?? rowCount);
        return Array.from({ length: n }, (_, i) => ({
          seq: i + 1,
          kind: "io",
          ts: i,
          ns: null,
          name: null,
          payload: new Uint8Array([i & 0xff]),
        }));
      },
    } as unknown as SessionDb;
    const meta = mkMeta("sx", "stopped", 1);
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({ sessionMeta: meta, sessionDb });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.export", sid: "sx", format: "json", limit },
      "f1",
    );
    const reply = out[0]?.msg as { t: string; format?: string; d?: string };
    const parsed = reply?.d ? JSON.parse(reply.d) : null;
    return { reply, parsed, getAskedLimit: () => askedLimit };
  }

  test("session.export reports truncated:false when EXACTLY the limit rows exist (rank 4)", () => {
    // limit=10, exactly 10 rows. Handler asks for 11, gets 10 → not truncated.
    const { reply, parsed, getAskedLimit } = exportHarness(10, 10);
    expect(reply.t).toBe("session.exported");
    expect(getAskedLimit()).toBe(11); // effectiveLimit + 1
    expect(parsed.truncated).toBe(false);
    expect(parsed.records.length).toBe(10);
  });

  test("session.export reports truncated:true when MORE than the limit rows exist (rank 4)", () => {
    // limit=10, 50 rows available. Handler asks for 11, gets 11 → truncated,
    // and the returned records are sliced back to exactly 10.
    const { reply, parsed } = exportHarness(50, 10);
    expect(reply.t).toBe("session.exported");
    expect(parsed.truncated).toBe(true);
    expect(parsed.records.length).toBe(10);
  });

  test("session.stop returns NO_RUNNER when killRunner reports false", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.stop", sid: "absent" },
      "f1",
    );
    await Promise.resolve();
    expect(calls.killRunner).toEqual(["absent"]);
    expect((out[0]?.msg as { e?: string }).e).toBe("NO_RUNNER");
  });

  test("session.restart on unknown sid replies NOT_FOUND without respawn", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.restart", sid: "missing" },
      "f1",
    );
    await Promise.resolve();
    expect(calls.killRunner).toEqual([]);
    expect(calls.createSession).toEqual([]);
    expect((out[0]?.msg as { e?: string }).e).toBe("NOT_FOUND");
  });

  // Fix #6 regression: session.restart used to killRunner() (SIGTERM only,
  // fire-and-forget) then IMMEDIATELY createSession() — the old claude PTY
  // was often still alive when the new one spawned, racing on the same sid
  // and hook socket. The fix awaits process exit before re-creating.
  test("session.restart awaits process exit before re-creating (ordering)", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const order: string[] = [];
    const meta: SessionMeta = mkMeta("s1", "running", 1);
    const { dispatcher, calls } = makeHarness({
      sessionMeta: meta,
      runners: [{ sid: "s1", hasProcess: true }],
    });
    // Wrap the harness's recorded calls to observe relative ordering: push
    // markers into `order` as each call lands, on top of the existing
    // `calls.*` arrays the harness already populates.
    const originalWaitForExit = calls.waitForExit.push.bind(calls.waitForExit);
    calls.waitForExit.push = (...items) => {
      order.push("waitForExit");
      return originalWaitForExit(...items);
    };
    const originalCreateSession = calls.createSession.push.bind(
      calls.createSession,
    );
    calls.createSession.push = (...items) => {
      order.push("createSession");
      return originalCreateSession(...items);
    };

    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.restart", sid: "s1" },
      "f1",
    );
    // The handler is `void this.handleRelaySessionRestart(...)` (fire and
    // forget from the switch), which itself awaits `waitForExit` before
    // `createSession` — flush enough microtasks for that chain to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.killRunner).toEqual(["s1"]);
    expect(order).toEqual(["waitForExit", "createSession"]);
    expect(calls.sessionUnregister).toEqual(["s1"]);
  });

  test("session.restart refuses a passthrough/registered-only session (no process handle)", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const meta: SessionMeta = mkMeta("s1", "running", 1);
    const { dispatcher, calls } = makeHarness({
      sessionMeta: meta,
      runners: [{ sid: "s1", hasProcess: false }],
    });

    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.restart", sid: "s1" },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();

    // Refused before any kill/respawn attempt — the old PTY is left alone
    // rather than double-spawned on top of.
    expect(calls.killRunner).toEqual([]);
    expect(calls.createSession).toEqual([]);
    expect((out[0]?.msg as { e?: string }).e).toBe("SESSION_ERROR");
  });

  test("session.delete on unknown sid replies session.delete.err not-found", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.delete", sid: "missing" },
      "f1",
    );
    await Promise.resolve();
    const m = out[0]?.msg as { t: string; reason?: string };
    expect(m.t).toBe("session.delete.err");
    expect(m.reason).toBe("not-found");
    expect(calls.killRunner).toEqual([]);
    expect(calls.storeDeleteSession).toEqual([]);
  });

  test("session.delete on a running session kills, unregisters, deletes, unsubscribes, and acks wasRunning=true", async () => {
    const seenUnsub: string[] = [];
    const seenRemoved: Array<{ sid: string; msg: unknown }> = [];
    const relayClient = {
      unsubscribe: (sid: string) => seenUnsub.push(sid),
      publishRemoved: async (sid: string, msg: unknown) => {
        seenRemoved.push({ sid, msg });
      },
    } as unknown as RelayClient;
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness({
      sessions: [mkMeta("s1", "running", 1)],
      runningSids: ["s1"],
      relayClients: [relayClient],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.delete", sid: "s1" },
      "f1",
    );
    await Promise.resolve();
    expect(calls.killRunner).toEqual(["s1"]);
    expect(calls.sessionUnregister).toEqual(["s1"]);
    expect(calls.storeDeleteSession).toEqual(["s1"]);
    expect(seenUnsub).toEqual(["s1"]);
    // A viewer attached to this sid on ANY relay client (not just the
    // originating frontend's) must be notified via `session.removed`.
    expect(seenRemoved).toEqual([
      { sid: "s1", msg: { t: "session.removed", sid: "s1" } },
    ]);
    const ok = out.find(
      (o) => (o.msg as { t?: string }).t === "session.delete.ok",
    );
    expect(ok?.sid).toBe("s1");
    expect((ok?.msg as { wasRunning?: boolean }).wasRunning).toBe(true);
  });

  test("session.delete on a stopped session deletes without killing, acks wasRunning=false", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness({
      sessions: [mkMeta("s2", "stopped", 1)],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.delete", sid: "s2" },
      "f1",
    );
    await Promise.resolve();
    expect(calls.killRunner).toEqual([]);
    expect(calls.sessionUnregister).toEqual([]);
    expect(calls.storeDeleteSession).toEqual(["s2"]);
    const ok = out.find(
      (o) => (o.msg as { t?: string }).t === "session.delete.ok",
    );
    expect((ok?.msg as { wasRunning?: boolean }).wasRunning).toBe(false);
  });

  test("session.delete replies session.delete.err internal when deleteSession throws", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({
      sessions: [mkMeta("s3", "stopped", 1)],
      deleteSessionThrows: () => new Error("disk full"),
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "session.delete", sid: "s3" },
      "f1",
    );
    await Promise.resolve();
    const m = out[0]?.msg as { t: string; reason?: string; message?: string };
    expect(m.t).toBe("session.delete.err");
    expect(m.reason).toBe("internal");
    expect(m.message).toBe("disk full");
  });

  const NO_REPO_MESSAGE = "No repository configured for worktree management";

  test("worktree.list without repo configured returns NO_REPO", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({ getWorktreeManager: () => null });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.list" },
      "f1",
    );
    // worktree.list is async — settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(out.length).toBe(1);
    expect((out[0]?.msg as { t: string; e?: string; m?: string }).e).toBe(
      "NO_REPO",
    );
    expect((out[0]?.msg as { t: string; e?: string; m?: string }).m).toBe(
      NO_REPO_MESSAGE,
    );
  });

  test("worktree.create without repo configured returns NO_REPO", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({ getWorktreeManager: () => null });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.create", branch: "feat/x" },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(out.length).toBe(1);
    const reply = out[0]?.msg as { t: string; e?: string; m?: string };
    expect(reply.t).toBe("err");
    expect(reply.e).toBe("NO_REPO");
    expect(reply.m).toBe(NO_REPO_MESSAGE);
  });

  test("worktree.create flattens '/' in the derived session id and path", async () => {
    // REGRESSION: a branch name can legally contain '/' (e.g. `feat/x`). The
    // derived sid was `${branch}-${ts}` → `feat/x-<ts>`, which createSession
    // joins into `storeDir/sessions/feat/x-<ts>.sqlite` — a non-existent
    // subdir, so `new Database()` throws and the session silently breaks. The
    // '/' must be flattened to '-' in both the worktree path and the sid.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const addCalls: Array<{ path: string; branch: string }> = [];
    const fakeWm = {
      add: async (path: string, branch: string) => {
        addCalls.push({ path, branch });
        return { path, branch, head: "abc123", isMain: false };
      },
    } as unknown as WorktreeManager;
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeWm,
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.create", branch: "feat/x" },
      "f1",
    );
    // worktree.create is async — let the worktree-manager promise settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The derived sid must not contain a path separator.
    const created = calls.createSession[0];
    if (!created) throw new Error("expected createSession to be called");
    const [sid] = created;
    expect(sid).not.toContain("/");
    expect(sid.startsWith("feat-x-")).toBe(true);
    // The default worktree path (no explicit path supplied) is likewise flattened.
    expect(addCalls[0]?.path.startsWith("feat-x-")).toBe(true);
    // The branch passed to git is unchanged — git accepts `feat/x`.
    expect(addCalls[0]?.branch).toBe("feat/x");
  });

  test("worktree.create sanitizes a '.'-containing branch into an allowlist-safe sid", async () => {
    // REGRESSION (orphan worktree): a branch like `release-1.2` is legal to git
    // (`git check-ref-format --branch` accepts the '.'), but the old derivation
    // only flattened '/', so the sid became `release-1.2-<ts>`. That sid then
    // failed `store.createSession`'s `assertSafeSid` allowlist ([A-Za-z0-9_-]+)
    // — but only AFTER `wm.add` had already created the worktree on disk,
    // orphaning it and surfacing a confusing "invalid sid" error. The branch is
    // now run through `sanitizeForSid`, so the sid is always allowlist-clean and
    // createSession is reached without throwing.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const addCalls: Array<{ path: string; branch: string }> = [];
    const fakeWm = {
      add: async (path: string, branch: string) => {
        addCalls.push({ path, branch });
        return { path, branch, head: "abc123", isMain: false };
      },
    } as unknown as WorktreeManager;
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeWm,
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.create", branch: "release-1.2" },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // createSession MUST be reached (proving the sid passed assertSafeSid and
    // nothing threw post-`wm.add` to orphan the worktree).
    const created = calls.createSession[0];
    if (!created) throw new Error("expected createSession to be called");
    const [sid] = created;
    // The '.' is gone — the sid is allowlist-clean and assertSafeSid-safe.
    expect(sid).not.toContain(".");
    expect(/^[A-Za-z0-9_-]+$/.test(sid)).toBe(true);
    expect(sid.startsWith("release-1-2-")).toBe(true);
    // The default worktree dir name is likewise sanitized.
    expect(addCalls[0]?.path.startsWith("release-1-2-")).toBe(true);
    // The branch handed to git is the verbatim original — git accepts the '.'.
    expect(addCalls[0]?.branch).toBe("release-1.2");
  });

  test("worktree.create rolls back the worktree when createSession throws", async () => {
    // REGRESSION (orphan worktree on store failure): `wm.add` creates the
    // worktree on disk, THEN `createSession` runs a synchronous SQLite write +
    // per-session DB open. If that throws (disk-full / SQLITE_BUSY / corrupt
    // page / sid collision), the old code surfaced WORKTREE_ERROR but left the
    // freshly-created, session-less worktree orphaned. The handler must roll the
    // worktree back (best-effort `wm.remove(..., force)`) while still reporting
    // the ORIGINAL createSession error to the frontend.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const addCalls: Array<{ path: string; branch: string }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const fakeWm = {
      add: async (path: string, branch: string) => {
        addCalls.push({ path, branch });
        return { path, branch, head: "abc123", isMain: false };
      },
      remove: async (path: string, force = false) => {
        removeCalls.push({ path, force });
      },
    } as unknown as WorktreeManager;
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeWm,
      createSessionThrows: () => new Error("disk full"),
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.create", branch: "feat/x" },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // createSession was attempted (and threw) — so the success-path push never
    // ran (createSessionThrows throws before recording the call).
    expect(calls.createSession.length).toBe(0);
    // The just-created worktree was rolled back, with force=true, at the path
    // wm.add returned.
    expect(removeCalls.length).toBe(1);
    expect(removeCalls[0]?.path).toBe(addCalls[0]?.path);
    expect(removeCalls[0]?.force).toBe(true);
    // The frontend still gets the ORIGINAL createSession failure, not a rollback
    // artifact — and never a spurious worktree.created success.
    const errFrame = out.find((o) => (o.msg as { t?: string }).t === "err");
    expect(errFrame).toBeDefined();
    const reply = errFrame?.msg as { e?: string; m?: string };
    expect(reply.e).toBe("WORKTREE_ERROR");
    expect(reply.m).toBe("disk full");
    expect(
      out.some((o) => (o.msg as { t?: string }).t === "worktree.created"),
    ).toBe(false);
  });

  test("worktree.create surfaces the original error even if rollback also fails", async () => {
    // The rollback is best-effort: if `wm.remove` itself throws (e.g. git
    // refuses), the handler must NOT let that mask the original createSession
    // error — the user-facing frame still reports the store failure.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    let removeAttempted = false;
    const fakeWm = {
      add: async (path: string, branch: string) => ({
        path,
        branch,
        head: "abc123",
        isMain: false,
      }),
      remove: async () => {
        removeAttempted = true;
        throw new Error("git worktree remove failed");
      },
    } as unknown as WorktreeManager;
    const { dispatcher } = makeHarness({
      getWorktreeManager: () => fakeWm,
      createSessionThrows: () => new Error("SQLITE_BUSY"),
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.create", branch: "feat/x" },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The rollback must have been ATTEMPTED (fix-sensitive: bare code never
    // calls remove). It threw, but that must not mask the original error.
    expect(removeAttempted).toBe(true);
    const errFrame = out.find((o) => (o.msg as { t?: string }).t === "err");
    expect(errFrame).toBeDefined();
    const reply = errFrame?.msg as { e?: string; m?: string };
    expect(reply.e).toBe("WORKTREE_ERROR");
    // The ORIGINAL error wins — not the rollback's "git worktree remove failed".
    expect(reply.m).toBe("SQLITE_BUSY");
  });

  test("worktree.remove without repo configured returns NO_REPO", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness({ getWorktreeManager: () => null });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "some/path" },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(out.length).toBe(1);
    const reply = out[0]?.msg as { t: string; e?: string; m?: string };
    expect(reply.t).toBe("err");
    expect(reply.e).toBe("NO_REPO");
    expect(reply.m).toBe(NO_REPO_MESSAGE);
  });

  // --------------------------------------------------------------------
  // worktree.remove live-session guard (refuse-non-force, kill-on-force).
  //
  // git worktree remove does NOT protect a running session whose cwd is the
  // worktree (a non-force remove succeeds against a clean worktree even with a
  // live process inside, leaving that session with an unlinked cwd). The guard
  // refuses on non-force when a LIVE runner references the worktree, and on
  // force kills those runners (awaiting exit before git touches the dir) then
  // removes. Truth source = listRunners() (live), not the store `state` column.
  // --------------------------------------------------------------------

  /** A WorktreeManager fake exposing the two methods the guard + handler use:
   *  - canonicalize: lexical normalization (resolve strips trailing '/', '..')
   *    — matches the real method's behavior for already-absolute paths.
   *  - remove: records (path, force) and lets the caller force a throw. */
  function fakeRemoveWm(
    removeCalls: Array<{ path: string; force: boolean }>,
    removeThrows?: () => Error,
  ): WorktreeManager {
    return {
      canonicalize: (p: string) => nodeResolve(p),
      remove: async (p: string, force = false) => {
        removeCalls.push({ path: p, force });
        if (removeThrows) throw removeThrows();
      },
    } as unknown as WorktreeManager;
  }

  test("worktree.remove (non-force) refuses when a live runner is on the worktree", async () => {
    // REGRESSION (#24): the old handler called wm.remove unconditionally, so a
    // non-force remove yanked the cwd out from under a running session. The
    // guard must refuse with WORKTREE_ERROR and NOT call wm.remove.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const { dispatcher } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [{ sid: "s-live", worktreePath: "/repo-wt-feat" }],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: false },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls.length).toBe(0);
    const errFrame = out.find((o) => (o.msg as { t?: string }).t === "err");
    expect(errFrame).toBeDefined();
    const reply = errFrame?.msg as { e?: string; m?: string };
    expect(reply.e).toBe("WORKTREE_ERROR");
    // The blocking sid is surfaced so the app can offer a force-remove.
    expect(reply.m).toContain("s-live");
    // Exactly ONE error frame — the guard returns (not throws), so
    // withWorktreeManager does not also publish a second WORKTREE_ERROR.
    expect(
      out.filter((o) => (o.msg as { t?: string }).t === "err").length,
    ).toBe(1);
  });

  test("worktree.remove (non-force) proceeds when no live runner is on the worktree", async () => {
    // A runner on a DIFFERENT worktree must not block the remove.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [{ sid: "s-other", worktreePath: "/repo-wt-OTHER" }],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: false },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls).toEqual([
      { path: nodeResolve("/repo-wt-feat"), force: false },
    ]);
    expect(calls.killRunner).toEqual([]);
    expect(
      out.some((o) => (o.msg as { t?: string }).t === "worktree.removed"),
    ).toBe(true);
  });

  test("worktree.remove (non-force) ignores a stale 'running' store row with no live runner", async () => {
    // The store row says 'running' but the runner already exited (listRunners
    // is empty). Truth = the live runner map, so the remove must proceed —
    // blocking on the stale row would wrongly refuse a legitimate remove.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const staleRow = mkMeta("s-stale", "running", 1);
    staleRow.worktree_path = "/repo-wt-feat";
    const { dispatcher } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      sessions: [staleRow],
      runners: [], // no live runner despite the 'running' row
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: false },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls.length).toBe(1);
    expect(out.some((o) => (o.msg as { t?: string }).t === "err")).toBe(false);
  });

  test("worktree.remove (force) kills the live runner, then removes — in order", async () => {
    // The kill→awaitExit→unregister→stopped→unsubscribe→remove ordering must
    // hold: waitForExit MUST run before wm.remove (git races a live PTY cwd).
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const unsubscribed: string[] = [];
    const relayClient = {
      unsubscribe: (sid: string) => unsubscribed.push(sid),
    } as unknown as RelayClient;
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [{ sid: "s-live", worktreePath: "/repo-wt-feat" }],
      relayClients: [relayClient],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: true },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.killRunner).toEqual(["s-live"]);
    // Regression guard: the killed runner's exit MUST be awaited before remove.
    expect(calls.waitForExit).toEqual(["s-live"]);
    expect(calls.sessionUnregister).toEqual(["s-live"]);
    expect(calls.storeUpdateState).toEqual([["s-live", "stopped"]]);
    expect(unsubscribed).toEqual(["s-live"]);
    expect(removeCalls).toEqual([
      { path: nodeResolve("/repo-wt-feat"), force: true },
    ]);
    expect(
      out.some((o) => (o.msg as { t?: string }).t === "worktree.removed"),
    ).toBe(true);
  });

  test("worktree.remove (force) refuses a passthrough runner it cannot kill", async () => {
    // A runner WITHOUT a tracked Subprocess (registered-only / passthrough) is
    // not killable by this daemon — killRunner would no-op and we'd remove the
    // dir out from under a live process. The guard must refuse instead.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [
        {
          sid: "s-passthrough",
          worktreePath: "/repo-wt-feat",
          hasProcess: false,
        },
      ],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: true },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls.length).toBe(0);
    expect(calls.killRunner).toEqual([]);
    const errFrame = out.find((o) => (o.msg as { t?: string }).t === "err");
    expect(errFrame).toBeDefined();
    const reply = errFrame?.msg as { e?: string; m?: string };
    expect(reply.e).toBe("WORKTREE_ERROR");
    expect(reply.m).toContain("s-passthrough");
  });

  test("worktree.remove matches a runner via the stored worktree_path fallback", async () => {
    // An old-protocol runner registered without worktreePath: the guard falls
    // back to the store row's worktree_path to still detect the blocker.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const row = mkMeta("s-noWtField", "running", 1);
    row.worktree_path = "/repo-wt-feat";
    const { dispatcher } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      sessions: [row],
      // runner present in the live map but with NO worktreePath field
      runners: [{ sid: "s-noWtField", worktreePath: undefined }],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: false },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls.length).toBe(0);
    const reply = out.find((o) => (o.msg as { t?: string }).t === "err")
      ?.msg as { e?: string };
    expect(reply?.e).toBe("WORKTREE_ERROR");
  });

  test("worktree.remove canonicalizes a trailing slash before matching", async () => {
    // msg.path with a trailing slash must still match the stored path — resolve
    // strips it. Without canonicalization the guard would miss the live runner.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const { dispatcher } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [{ sid: "s-live", worktreePath: "/repo-wt-feat" }],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat/", force: false },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls.length).toBe(0);
    const reply = out.find((o) => (o.msg as { t?: string }).t === "err")
      ?.msg as { e?: string };
    expect(reply?.e).toBe("WORKTREE_ERROR");
  });

  test("worktree.remove (force) surfaces a kill failure and does NOT remove", async () => {
    // If killRunner throws, the re-throw lets withWorktreeManager publish a
    // WORKTREE_ERROR and wm.remove is never reached (safe direction: the
    // worktree stays on disk rather than being removed under a half-killed
    // session).
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [{ sid: "s-live", worktreePath: "/repo-wt-feat" }],
      killRunnerThrows: () => new Error("kill failed"),
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: true },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.killRunner).toEqual(["s-live"]);
    expect(removeCalls.length).toBe(0);
    const reply = out.find((o) => (o.msg as { t?: string }).t === "err")
      ?.msg as { e?: string; m?: string };
    expect(reply?.e).toBe("WORKTREE_ERROR");
    expect(reply?.m).toBe("kill failed");
  });

  test("worktree.remove with no sessions at all proceeds cleanly", async () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const removeCalls: Array<{ path: string; force: boolean }> = [];
    const { dispatcher, calls } = makeHarness({
      getWorktreeManager: () => fakeRemoveWm(removeCalls),
      runners: [],
    });
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "worktree.remove", path: "/repo-wt-feat", force: false },
      "f1",
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeCalls.length).toBe(1);
    expect(calls.killRunner).toEqual([]);
    expect(
      out.some((o) => (o.msg as { t?: string }).t === "worktree.removed"),
    ).toBe(true);
  });

  test("resize forwards to the runner IPC when found", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay([]),
      { t: "resize", sid: "present", cols: 80, rows: 24 },
      "f1",
    );
    const sent = calls.ipcSends[0] as { t: string; cols?: number };
    expect(sent.t).toBe("resize");
    expect(sent.cols).toBe(80);
  });

  test("resize on unknown sid replies NO_RUNNER instead of silently dropping", async () => {
    // A resize to a dead session must NACK — otherwise the frontend believes
    // it landed. Mirrors session.stop's identical no-runner NACK.
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "resize", sid: "absent", cols: 80, rows: 24 },
      "f1",
    );
    await Promise.resolve();
    expect(calls.ipcSends).toEqual([]);
    const m = out[0]?.msg as { t: string; e?: string; m?: string };
    expect(m.t).toBe("err");
    expect(m.e).toBe("NO_RUNNER");
  });

  test("detach is a no-op", () => {
    const out: Array<{ frontendId: string; sid: string; msg: unknown }> = [];
    const { dispatcher } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay(out),
      { t: "detach", sid: "s1" },
      "f1",
    );
    expect(out).toEqual([]);
  });
});
