import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import { $ } from "bun";

describe("tp status", () => {
  let daemon: Daemon;
  let wsPort: number;

  beforeEach(() => {
    SessionManager.setRunnerCommand(["true"]);
    daemon = new Daemon();
    daemon.start();
    daemon.startWs(0);
    wsPort = (daemon as any).wsServer.port;
  });

  afterEach(() => {
    daemon.stop();
  });

  test("shows session count when daemon is running", async () => {
    const result =
      await $`bun run apps/cli/src/index.ts status ${wsPort}`.text();
    expect(result).toContain("Daemon Status");
    expect(result).toContain("Sessions:");
  });

  test("shows session details after session creation", async () => {
    // Create a session (runner won't connect since command is `true`)
    daemon.createSession("status-test", "/tmp");
    await Bun.sleep(200);

    const result =
      await $`bun run apps/cli/src/index.ts status ${wsPort}`.text();
    expect(result).toContain("Daemon Status");
  });
});
