import { expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";

let daemon: ChildProcess;

test.describe("Real E2E — Claude PTY → Browser", () => {
  test.beforeAll(async () => {
    // Kill any leftover daemon from other test files
    const { execSync } = require("child_process");
    try {
      execSync("pkill -f 'daemon start'", { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));

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
        "real-test",
        "--cwd",
        "/tmp",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LOG_LEVEL: "error" },
      },
    );

    // Wait for session to be created AND running
    await new Promise<void>((resolve) => {
      let output = "";
      daemon.stderr?.on("data", (d) => {
        output += d.toString();
        if (output.includes("session created")) {
          // Verify session is visible via WS before proceeding
          const ws = new WebSocket("ws://localhost:7080");
          ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1 }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data as string);
            if (msg.t === "hello") {
              const running = msg.d.sessions.find(
                (s: { sid: string; state: string }) =>
                  s.sid === "real-test" && s.state === "running",
              );
              if (running) {
                ws.close();
                resolve();
              }
            }
          };
          setTimeout(() => {
            ws.close();
            resolve();
          }, 10000);
        }
      });
      setTimeout(resolve, 25000);
    });
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("Chat tab connects and shows session ID", async ({ page }) => {
    // Capture browser console for debugging
    page.on("console", (msg) => {
      if (msg.text().includes("useDaemon")) {
        console.log(`[BROWSER] ${msg.text()}`);
      }
    });

    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Poll until session ID appears — first load has Metro bundling overhead
    let hasSession = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator("body").textContent()) ?? "";
      if (text.includes("real-test")) {
        hasSession = true;
        break;
      }
      // If stuck on "Waiting", reload to trigger fresh WS hello
      if (i === 15 && text.includes("Waiting for session")) {
        await page.reload();
        await page.waitForSelector("text=Teleprompter", { timeout: 10_000 });
      }
    }

    await page.screenshot({ path: "/tmp/pw-chat-session.png" });

    const bodyText = (await page.locator("body").textContent()) ?? "";
    // Must not be stuck on "Connecting to Daemon..."
    expect(bodyText.includes("Connecting to Daemon...")).toBe(false);
    // Session ID should be visible
    expect(hasSession).toBe(true);
  });

  test("Terminal tab shows ghostty-web with session header", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Wait for session to attach
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator("body").textContent()) ?? "";
      if (text.includes("real-test")) break;
    }

    // Navigate to terminal
    const termTab = page.locator("text=Terminal").first();
    if (await termTab.isVisible().catch(() => false)) {
      await termTab.click();
    } else {
      await page.goto("/terminal");
    }
    await page.waitForTimeout(3000);

    await page.screenshot({ path: "/tmp/pw-terminal-session.png" });

    // ghostty-web renders to canvas, not DOM elements
    const canvasVisible = await page
      .locator("canvas")
      .isVisible()
      .catch(() => false);
    const hasHeader = await page
      .locator("text=real-test")
      .isVisible()
      .catch(() => false);
    expect(canvasVisible || hasHeader).toBe(true);
  });

  test("Chat input is editable when connected", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Wait for session to attach (input becomes editable)
    let editable = false;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const input = page.locator("[placeholder='Send a message...']");
      const isVisible = await input.isVisible().catch(() => false);
      if (isVisible) {
        const disabled = await input.getAttribute("disabled");
        const readonly = await input.getAttribute("readonly");
        if (!disabled && !readonly) {
          editable = true;
          break;
        }
      }
    }

    await page.screenshot({ path: "/tmp/pw-chat-editable.png" });
    expect(editable).toBe(true);
  });
});
