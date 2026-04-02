import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

/**
 * P0: Session resume after daemon restart
 *
 * 1. Start daemon + session -> app connects
 * 2. Kill daemon -> app shows disconnected
 * 3. Restart daemon -> app auto-reconnects + resumes
 */

let daemon: ChildProcess;

function startDaemon(): ChildProcess {
  return spawn(
    "bun",
    [
      "run",
      "apps/cli/src/index.ts",
      "daemon",
      "start",
      "--ws-port",
      "7080",
      "--spawn",
      "--sid",
      "resume-test",
      "--cwd",
      "/tmp",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOG_LEVEL: "error" },
    },
  );
}

function waitForDaemonReady(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let out = "";
    proc.stderr?.on("data", (d) => {
      out += d.toString();
      if (out.includes("session created")) setTimeout(resolve, 2000);
    });
    setTimeout(resolve, 15000);
  });
}

test.describe("P0 — Session Resume", () => {
  test.beforeAll(async () => {
    try {
      execSync("pkill -f 'daemon start'", { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("app reconnects after daemon restart", async ({ page }) => {
    // 1. Start daemon
    daemon = startDaemon();
    await waitForDaemonReady(daemon);

    // 2. App connects
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Wait for session to appear in list
    await expect(page.locator("text=resume-test")).toBeVisible({
      timeout: 15_000,
    });

    await page.screenshot({ path: "/tmp/pw-resume-1-connected.png" });

    // 3. Kill daemon
    daemon.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));

    await page.screenshot({ path: "/tmp/pw-resume-2-disconnected.png" });

    // 4. Restart daemon
    daemon = startDaemon();
    await waitForDaemonReady(daemon);

    // 5. App should auto-reconnect — session reappears
    await expect(page.locator("text=resume-test")).toBeVisible({
      timeout: 30_000,
    });

    await page.screenshot({ path: "/tmp/pw-resume-3-reconnected.png" });
  });
});
