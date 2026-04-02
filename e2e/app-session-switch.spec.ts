import { expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";

let daemon: ChildProcess;

test.describe("App Web — Session Switching", () => {
  test.beforeAll(async () => {
    // Start daemon with a session
    daemon = spawn(
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
        "session-alpha",
        "--cwd",
        "/tmp",
      ],
      {
        stdio: "pipe",
        env: { ...process.env, LOG_LEVEL: "error" },
      },
    );

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
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // The daemon spawns a session — it should appear in the Sessions list
    await expect(page.locator("text=session-alpha")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking a session navigates to session view", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Wait for session to appear
    await expect(page.locator("text=session-alpha")).toBeVisible({
      timeout: 10_000,
    });

    // Click the session row
    await page.locator("text=session-alpha").click();

    // Should navigate to session detail page
    await expect(page.locator("text=Chat")).toBeVisible({ timeout: 5_000 });
  });
});
