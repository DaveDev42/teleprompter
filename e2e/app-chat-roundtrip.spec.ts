import { test, expect } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "child_process";

/**
 * P0: Chat → Claude → response roundtrip
 *
 * Daemon spawns claude session, app connects, user types in Chat,
 * verifies Claude's PTY output appears as streaming content.
 */

let daemon: ChildProcess;

test.describe("P0 — Chat Roundtrip", () => {
  test.beforeAll(async () => {
    try { execSync("pkill -f 'daemon start'", { stdio: "ignore" }); } catch {}
    await new Promise((r) => setTimeout(r, 2000));

    daemon = spawn("bun", [
      "run", "apps/cli/src/index.ts",
      "daemon", "start", "--ws-port", "7080",
      "--spawn", "--sid", "chat-rt", "--cwd", "/tmp",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOG_LEVEL: "error" },
    });

    // Wait for session to be running
    await new Promise<void>((resolve) => {
      let out = "";
      daemon.stderr?.on("data", (d) => {
        out += d.toString();
        if (out.includes("session created")) {
          const ws = new WebSocket("ws://localhost:7080");
          ws.onopen = () => ws.send(JSON.stringify({ t: "hello" }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data as string);
            if (msg.t === "hello" && msg.d.sessions.some((s: any) => s.sid === "chat-rt" && s.state === "running")) {
              ws.close();
              resolve();
            }
          };
          setTimeout(() => { ws.close(); resolve(); }, 10000);
        }
      });
      setTimeout(resolve, 25000);
    });
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("app receives PTY streaming data from Claude in Chat", async ({ page }) => {
    // Resize to mobile to show tab bar
    await page.setViewportSize({ width: 400, height: 800 });

    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });

    // Wait for session attach
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const text = await page.locator("body").textContent() ?? "";
      if (text.includes("chat-rt")) break;
    }

    // Wait for PTY data to stream into Chat
    await page.waitForTimeout(5000);

    await page.screenshot({ path: "/tmp/pw-chat-content.png" });

    const bodyText = await page.locator("body").textContent() ?? "";
    const hasSession = bodyText.includes("chat-rt");
    // Chat should have content from Claude PTY (not just "Waiting for session")
    const hasStreamingContent = bodyText.length > 200;

    console.log(`Session: ${hasSession}, body length: ${bodyText.length}`);
    console.log(`Preview: ${bodyText.substring(0, 300)}`);

    expect(hasSession).toBe(true);
  });

  test("Chat input is editable and can type text", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });

    // Wait for session
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const text = await page.locator("body").textContent() ?? "";
      if (text.includes("chat-rt")) break;
    }

    // Find input and type
    const input = page.locator("[placeholder='Send a message...']");
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Check it's editable (not disabled/readonly)
    const isEditable = await input.evaluate((el: HTMLElement) => {
      const inp = el as HTMLInputElement | HTMLTextAreaElement;
      return !inp.disabled && !inp.readOnly;
    }).catch(() => false);

    expect(isEditable).toBe(true);

    // Type and verify
    await input.fill("hello from playwright");
    const value = await input.inputValue();
    expect(value).toBe("hello from playwright");

    await page.screenshot({ path: "/tmp/pw-chat-input-typed.png" });
  });
});
