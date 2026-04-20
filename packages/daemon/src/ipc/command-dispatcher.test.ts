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
  sessionRegister: Array<[string, number, string, string?, string?]>;
  sessionUnregister: string[];
  killRunner: string[];
  createSession: Array<[string, string, SpawnRunnerOptions?]>;
  pairBegin: IpcPairBegin[];
  pairCancel: IpcPairCancel[];
  cliDisconnect: number;
  pushNotifier: unknown[];
  recordObserver: Array<[string, string, Buffer, string | undefined]>;
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
    sessionDb?: SessionDb;
    relayClients?: RelayClient[];
  } = {},
) {
  const calls: Calls = {
    ipcSends: [],
    storeCreateSession: [],
    storeUpdateState: [],
    storeUpdateLastSeq: [],
    sessionRegister: [],
    sessionUnregister: [],
    killRunner: [],
    createSession: [],
    pairBegin: [],
    pairCancel: [],
    cliDisconnect: 0,
    pushNotifier: [],
    recordObserver: [],
  };

  const fakeSessions: SessionMeta[] = opts.sessionMeta
    ? [opts.sessionMeta]
    : [];

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
    getSession: (sid) =>
      opts.sessionMeta && opts.sessionMeta.sid === sid
        ? opts.sessionMeta
        : undefined,
    getSessionDb: () => fakeDb,
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
