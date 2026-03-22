import { IpcServer } from "./ipc/server";
import { Vault } from "./vault";
import { SessionManager, type SpawnRunnerOptions } from "./session/session-manager";
import { ClientRegistry } from "./transport/client-registry";
import { WsServer } from "./transport/ws-server";
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

export class Daemon {
  private ipcServer: IpcServer;
  private vault: Vault;
  private sessionManager = new SessionManager();
  private clientRegistry = new ClientRegistry();
  private wsServer: WsServer;

  constructor(vaultDir?: string) {
    this.vault = new Vault(vaultDir);

    this.ipcServer = new IpcServer({
      onConnect: (_runner) => {
        console.log("[Daemon] runner connected");
      },
      onDisconnect: (runner) => {
        if (runner.sid) {
          console.log(`[Daemon] runner disconnected sid=${runner.sid}`);
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
    });
  }

  private socketPath: string = "";

  start(socketPath?: string): string {
    this.socketPath = this.ipcServer.start(socketPath);
    console.log(`[Daemon] started`);
    return this.socketPath;
  }

  startWs(port: number): void {
    this.wsServer.start(port);
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
    console.log(`[Daemon] session created sid=${msg.sid}`);

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
      console.error(`[Daemon] unknown session sid=${msg.sid}`);
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
  }

  private handleBye(msg: IpcBye): void {
    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.vault.updateSessionState(msg.sid, state);
    this.sessionManager.unregisterRunner(msg.sid);
    console.log(
      `[Daemon] session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`,
    );

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

  stop(): void {
    this.wsServer.stop();
    this.ipcServer.stop();
    this.vault.close();
    console.log("[Daemon] stopped");
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
