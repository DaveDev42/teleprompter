import { IpcServer } from "./ipc/server";
import { Vault } from "./vault";
import { SessionManager } from "./session/session-manager";
import type {
  IpcHello,
  IpcRec,
  IpcBye,
  Namespace,
  RecordKind,
} from "@teleprompter/protocol";

export class Daemon {
  private ipcServer: IpcServer;
  private vault: Vault;
  private sessionManager = new SessionManager();

  constructor(vaultDir?: string) {
    this.vault = new Vault(vaultDir);

    this.ipcServer = new IpcServer({
      onConnect: (runner) => {
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
  }

  start(socketPath?: string): string {
    const path = this.ipcServer.start(socketPath);
    console.log(`[Daemon] started`);
    return path;
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
  }

  private handleBye(msg: IpcBye): void {
    const state = msg.exitCode === 0 ? "stopped" : "error";
    this.vault.updateSessionState(msg.sid, state);
    this.sessionManager.unregisterRunner(msg.sid);
    console.log(
      `[Daemon] session ended sid=${msg.sid} exitCode=${msg.exitCode} state=${state}`,
    );
  }

  stop(): void {
    this.ipcServer.stop();
    this.vault.close();
    console.log("[Daemon] stopped");
  }
}
