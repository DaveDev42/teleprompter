import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Daemon } from "./daemon";
import { SessionManager } from "./session/session-manager";
import type { WsServerMessage } from "@teleprompter/protocol";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("connect failed"));
    setTimeout(() => reject(new Error("timeout")), 3000);
  });
}

function waitMsg(
  ws: WebSocket,
  pred: (m: WsServerMessage) => boolean,
): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (pred(msg)) {
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("waitMsg timeout"));
    }, 5000);
  });
}

describe("Daemon worktree WS protocol", () => {
  let daemon: Daemon;
  let repoDir: string;
  let wsPort: number;

  beforeEach(async () => {
    // Create a temp git repo
    repoDir = await mkdtemp(join(tmpdir(), "tp-wt-ws-"));
    await $`git -C ${repoDir} init -b main`.quiet();
    await $`git -C ${repoDir} config user.email "test@test.com"`.quiet();
    await $`git -C ${repoDir} config user.name "Test"`.quiet();
    await $`git -C ${repoDir} config commit.gpgsign false`.quiet();
    await $`touch ${repoDir}/README.md`.quiet();
    await $`git -C ${repoDir} add .`.quiet();
    await $`git -C ${repoDir} commit -m "init"`.quiet();

    // Don't actually spawn runners in test
    SessionManager.setRunnerCommand(["true"]);

    daemon = new Daemon();
    daemon.start();
    daemon.startWs(0);
    daemon.setRepoRoot(repoDir);

    // Get the actual WS port
    // Access via the internal wsServer port
    wsPort = (daemon as any).wsServer.port;
  });

  afterEach(async () => {
    daemon.stop();
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  });

  test("worktree.list returns main worktree", async () => {
    const ws = await connectWs(wsPort);
    ws.send(JSON.stringify({ t: "hello" }));
    await waitMsg(ws, (m) => m.t === "hello");

    ws.send(JSON.stringify({ t: "worktree.list" }));
    const reply = await waitMsg(ws, (m) => m.t === "worktree.list");

    expect(reply.t).toBe("worktree.list");
    const worktrees = (reply as any).d;
    expect(worktrees.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  test("session.create and session.stop via WS", async () => {
    const ws = await connectWs(wsPort);
    ws.send(JSON.stringify({ t: "hello" }));
    await waitMsg(ws, (m) => m.t === "hello");

    // Create a session
    ws.send(
      JSON.stringify({
        t: "session.create",
        cwd: repoDir,
        sid: "test-ws-session",
      }),
    );

    // Should get a state update for the new session
    // (the runner won't actually connect since we use `true` as command)
    await Bun.sleep(200);

    // Stop should not error even if runner exited
    ws.send(JSON.stringify({ t: "session.stop", sid: "test-ws-session" }));
    await Bun.sleep(100);

    ws.close();
  });

  test("worktree.list errors when no repo configured", async () => {
    // Create a new daemon without repo
    const d2 = new Daemon();
    d2.start();
    d2.startWs(0);
    const p2 = (d2 as any).wsServer.port;

    const ws = await connectWs(p2);
    ws.send(JSON.stringify({ t: "hello" }));
    await waitMsg(ws, (m) => m.t === "hello");

    ws.send(JSON.stringify({ t: "worktree.list" }));
    const err = await waitMsg(ws, (m) => m.t === "err");
    expect((err as any).e).toBe("NO_REPO");

    ws.close();
    d2.stop();
  });
});
