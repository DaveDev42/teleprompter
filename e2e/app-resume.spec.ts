import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

/**
 * P0: Session resume after daemon restart
 *
 * 1. Start daemon + session → app connects
 * 2. Kill daemon → app shows disconnected
 * 3. Restart daemon → app auto-reconnects + resumes
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
    await new Promise<void>((resolve) => {
      let out = "";
      daemon.stderr?.on("data", (d) => {
        out += d.toString();
        if (out.includes("session created")) setTimeout(resolve, 3000);
      });
      setTimeout(resolve, 15000);
    });

    // 2. App connects
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });

    // Wait for connection
    let connected = false;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator("body").textContent()) ?? "";
      if (!text.includes("Connecting to Daemon")) {
        connected = true;
        break;
      }
    }
    expect(connected).toBe(true);

    await page.screenshot({ path: "/tmp/pw-resume-1-connected.png" });

    // 3. Kill daemon
    daemon.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));

    // 4. App should show disconnected
    await page.waitForTimeout(2000);
    const bodyAfterKill = (await page.locator("body").textContent()) ?? "";
    await page.screenshot({ path: "/tmp/pw-resume-2-disconnected.png" });

    console.log(
      `After kill: ${bodyAfterKill.includes("Connecting") ? "Disconnected (reconnecting)" : "Still shows content"}`,
    );

    // 5. Restart daemon
    daemon = startDaemon();
    await new Promise<void>((resolve) => {
      let out = "";
      daemon.stderr?.on("data", (d) => {
        out += d.toString();
        if (out.includes("session created")) setTimeout(resolve, 3000);
      });
      setTimeout(resolve, 15000);
    });

    // 6. App should auto-reconnect — check for session sid reappearing
    let reconnected = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator("body").textContent()) ?? "";
      // Consider reconnected if we see session content and no "Connecting" banner
      if (
        text.includes("resume-test") &&
        !text.includes("Connecting to Daemon")
      ) {
        reconnected = true;
        break;
      }
    }

    await page.screenshot({ path: "/tmp/pw-resume-3-reconnected.png" });

    console.log(`Reconnected: ${reconnected}`);
    expect(reconnected).toBe(true);
  });
});
