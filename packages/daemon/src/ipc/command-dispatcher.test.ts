import { describe, expect, test } from "bun:test";
import type {
  IpcAck,
  IpcBye,
  IpcHello,
  IpcMessage,
  IpcPairBegin,
  IpcPairCancel,
  IpcRec,
  RelayControlMessage,
} from "@teleprompter/protocol";
import { FrameDecoder, QueuedWriter } from "@teleprompter/protocol";
import type { PushNotifier } from "../push/push-notifier";
import type {
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
  storeCreateSession: Array<[string, string, string?, string?]>;
  storeUpdateState: Array<[string, string]>;
  storeUpdateLastSeq: Array<[string, number]>;
  storeDeleteSession: string[];
  sessionRegister: Array<[string, number, string, string?, string?]>;
  sessionUnregister: string[];
  killRunner: string[];
  createSession: Array<[string, string, SpawnRunnerOptions?]>;
  pairBegin: IpcPairBegin[];
  pairCancel: IpcPairCancel[];
  cliDisconnect: number;
  pushNotifier: unknown[];
  recordObserver: Array<[string, string, Buffer, string | undefined]>;
  removePairing: string[];
  renamePairing: Array<[string, string | null]>;
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
    sessionDb?: SessionDb;
    relayClients?: RelayClient[];
    pairings?: Array<{ daemonId: string }>;
    removePairingResult?: (daemonId: string) => Promise<number>;
    renamePairingResult?: (
      daemonId: string,
      label: string | null,
    ) => Promise<number>;
    runningSids?: string[];
    deleteSessionThrows?: (sid: string) => Error | null;
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
        label: null,
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

  const sessionManager: Pick<
    SessionManager,
    "registerRunner" | "unregisterRunner" | "killRunner"
  > = {
    registerRunner: (sid, pid, cwd, worktreePath, claudeVersion) => {
      calls.sessionRegister.push([sid, pid, cwd, worktreePath, claudeVersion]);
    },
    unregisterRunner: (sid) => {
      calls.sessionUnregister.push(sid);
    },
    killRunner: (sid) => {
      calls.killRunner.push(sid);
      if (runningSet.has(sid)) {
        runningSet.delete(sid);
        return true;
      }
      return sid === "present";
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
      label: "Office Mac",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.renamePairing).toEqual([["d1", "Office Mac"]]);
    expect(calls.ipcSends).toEqual([
      {
        t: "pair.rename.ok",
        daemonId: "d1",
        label: "Office Mac",
        notifiedPeers: 1,
      },
    ]);
  });

  test("pair.rename with label=null (clear) round-trips through reply", async () => {
    const { dispatcher, calls } = makeHarness({
      pairings: [{ daemonId: "d1" }],
      renamePairingResult: async () => 0,
    });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "pair.rename",
      daemonId: "d1",
      label: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.renamePairing).toEqual([["d1", null]]);
    expect(calls.ipcSends).toEqual([
      { t: "pair.rename.ok", daemonId: "d1", label: null, notifiedPeers: 0 },
    ]);
  });

  test("pair.rename replies pair.rename.err not-found when pairing missing", async () => {
    const { dispatcher, calls } = makeHarness({ pairings: [] });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "pair.rename",
      daemonId: "missing",
      label: "x",
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
      olderThanMs: 5_000,
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
      olderThanMs: 5_000,
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
      olderThanMs: 5_000,
      includeRunning: true,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.killRunner).toEqual(["r1"]);
    expect(calls.storeDeleteSession.sort()).toEqual(["r1", "s1"]);
    const reply = calls.ipcSends[0] as { runningKilled: number };
    expect(reply.runningKilled).toBe(1);
  });

  test("session.prune with olderThanMs=null and includeRunning=true matches everything", async () => {
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
      olderThanMs: null,
      includeRunning: true,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.storeDeleteSession.sort()).toEqual(["r1", "s1"]);
  });

  test("session.prune with no matches still replies ok with empty sids", async () => {
    const { dispatcher, calls } = makeHarness({ sessions: [] });
    dispatcher.dispatchIpc(makeRunner(), {
      t: "session.prune",
      olderThanMs: 5_000,
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
      olderThanMs: 5_000,
      includeRunning: false,
      dryRun: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const reply = calls.ipcSends[0] as {
      t: string;
      reason?: string;
      partialSids?: string[];
    };
    expect(reply.t).toBe("session.prune.err");
    expect(reply.reason).toBe("internal");
    // s1 succeeded before s2 threw; s3 never ran. partialSids must name s1.
    expect(reply.partialSids).toEqual(["s1"]);
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
    expect(calls.createSession).toEqual([["new", "/cwd", undefined]]);
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
    expect((out[0]?.msg as { e?: string }).e).toBe("NO_REPO");
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

  test("resize on unknown sid is a no-op", () => {
    const { dispatcher, calls } = makeHarness();
    dispatcher.dispatchRelayControl(
      fakeRelay([]),
      { t: "resize", sid: "absent", cols: 80, rows: 24 },
      "f1",
    );
    expect(calls.ipcSends).toEqual([]);
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
