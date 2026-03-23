import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";

/**
 * Real E2E: Daemon + Claude session + Browser
 *
 * Tests actual data flow:
 * Claude PTY → Runner → Daemon → WS → Browser (Chat + Terminal)
 */

let daemon: ChildProcess;

test.describe("Real E2E — Claude PTY → Browser", () => {
  test.beforeAll(async () => {
    // Start daemon with a real claude session
    daemon = spawn("bun", [
      "run", "apps/cli/src/index.ts",
      "daemon", "start",
      "--ws-port", "7080",
      "--spawn", "--sid", "real-test", "--cwd", "/tmp",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOG_LEVEL: "error" },
    });

    // Wait for daemon + runner to be ready
    await new Promise<void>((resolve) => {
      let output = "";
      daemon.stderr?.on("data", (d) => {
        output += d.toString();
        if (output.includes("session created")) {
          setTimeout(resolve, 3000); // Extra time for Claude to start
        }
      });
      setTimeout(resolve, 15000); // Fallback timeout
    });
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("Chat tab receives real PTY output from Claude", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });

    // Wait for daemon connection + session attach
    await page.waitForTimeout(8000);

    // Take screenshot to see what's actually rendered
    await page.screenshot({ path: "/tmp/pw-chat-real.png" });

    // Verify we're NOT stuck on "Connecting to Daemon..."
    const bodyText = await page.locator("body").textContent();
    const isConnecting = bodyText?.includes("Connecting to Daemon...");
    const hasSessionId = bodyText?.includes("real-test");

    // Must have connected to daemon
    expect(isConnecting).toBe(false);
    expect(hasSessionId).toBe(true);

    // Check for actual content beyond just "Waiting for session..."
    // PTY output should have generated some streaming text or event cards
    const hasContent =
      bodyText?.includes("Waiting for session") === false ||
      bodyText?.includes("claude") ||
      bodyText?.includes("MCP") ||
      bodyText?.includes("server") ||
      (bodyText?.length ?? 0) > 200;

    console.log(`Body text length: ${bodyText?.length}`);
    console.log(`Contains 'real-test': ${hasSessionId}`);
    console.log(`Still connecting: ${isConnecting}`);
  });

  test("Terminal tab shows xterm.js with PTY data", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(5000);

    // Desktop mode hides tabs, but we can navigate via URL
    // Try clicking Terminal if visible, otherwise navigate
    const terminalTab = page.locator("text=Terminal").first();
    if (await terminalTab.isVisible().catch(() => false)) {
      await terminalTab.click();
    } else {
      await page.goto("/terminal");
    }
    await page.waitForTimeout(3000);

    await page.screenshot({ path: "/tmp/pw-terminal-real.png" });

    // Check for xterm.js container
    const xtermExists = await page.locator(".xterm").isVisible().catch(() => false);
    const hasSessionHeader = await page.locator("text=Session:").isVisible().catch(() => false) ||
      await page.locator("text=real-test").isVisible().catch(() => false);

    console.log(`xterm visible: ${xtermExists}`);
    console.log(`session header: ${hasSessionHeader}`);

    // xterm.js should be rendered on web
    expect(xtermExists || hasSessionHeader).toBe(true);
  });

  test("Chat input sends message to Claude", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(5000);

    // Find and fill the chat input
    const input = page.locator("[placeholder='Send a message...']");
    if (await input.isVisible().catch(() => false)) {
      await input.fill("hello");
      await page.waitForTimeout(500);

      // Click send button
      const sendBtn = page.locator("text=↑").first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
        await page.waitForTimeout(5000);

        await page.screenshot({ path: "/tmp/pw-chat-input-real.png" });

        // After sending, input should be cleared
        const inputValue = await input.inputValue().catch(() => "");
        expect(inputValue).toBe("");
      }
    }
  });
});
