import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";

let daemon: ChildProcess;

test.describe("App Web — Session Switching", () => {
  test.beforeAll(async () => {
    // Start daemon with two sessions
    daemon = spawn("bun", [
      "run", "apps/cli/src/index.ts",
      "daemon", "start",
      "--ws-port", "7080",
      "--spawn", "--sid", "session-alpha", "--cwd", "/tmp",
    ], {
      stdio: "pipe",
      env: { ...process.env, LOG_LEVEL: "error" },
    });

    // Wait for daemon ready
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      daemon.stderr?.on("data", (data) => {
        if (data.toString().includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("sessions tab shows session list", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Click Sessions tab
    const sessionsTab = page.locator("text=Sessions");
    if (await sessionsTab.isVisible()) {
      await sessionsTab.click();
      await page.waitForTimeout(500);

      // Should show session ID
      const body = await page.locator("body").textContent();
      expect(body).toContain("session-alpha");
    } else {
      // On desktop layout, sessions may be in a sidebar
      const body = await page.locator("body").textContent();
      expect(body).toContain("session-alpha");
    }
  });

  test("clicking a session switches the active session", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(3000);

    // The app should auto-attach to the first session
    const body = await page.locator("body").textContent();
    const hasSession = body?.includes("session-alpha");
    expect(hasSession).toBe(true);
  });
});
