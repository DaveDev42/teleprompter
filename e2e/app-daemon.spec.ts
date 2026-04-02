import { expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";

let daemon: ChildProcess;

test.describe("App Web — Daemon Connected", () => {
  test.beforeAll(async () => {
    // Start daemon in background
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
        "pw-test",
        "--cwd",
        "/tmp",
      ],
      {
        stdio: "pipe",
        env: { ...process.env, LOG_LEVEL: "error" },
      },
    );

    // Wait for daemon to be ready
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

  test("connects to daemon and shows session", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Wait for WS connection — session should appear in list
    await expect(page.locator("text=pw-test")).toBeVisible({ timeout: 10_000 });
  });

  test("shows session info after connection", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Wait for WS to connect and session to appear
    await expect(page.locator("text=pw-test")).toBeVisible({ timeout: 10_000 });

    // Should not still say "No active sessions"
    await expect(page.locator("text=No active sessions")).not.toBeVisible();
  });
});
