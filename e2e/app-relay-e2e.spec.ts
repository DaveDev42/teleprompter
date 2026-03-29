import { test, expect } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "child_process";

/**
 * Full relay E2E: Runner → Daemon → Relay → App (via Playwright)
 *
 * Tests the complete pipeline:
 * 1. Start local relay server
 * 2. Generate pairing data (via tp pair)
 * 3. Start daemon connected to relay
 * 4. App pairs via manual paste → relay E2EE connection
 * 5. Verify app shows daemon session via relay
 */

let relay: ChildProcess;
let daemon: ChildProcess;
let pairingJson: string;
const RELAY_PORT = 17090;

// Use mobile viewport so tab bar is visible
test.use({ viewport: { width: 390, height: 844 } });

test.describe("Full Relay E2E — Runner → Daemon → Relay → App", () => {
  test.beforeAll(async () => {
    // Kill any stale processes
    try { execSync("pkill -f 'relay start --port 17090'", { stdio: "ignore" }); } catch {}
    try { execSync("pkill -f 'relay-e2e'", { stdio: "ignore" }); } catch {}
    await new Promise((r) => setTimeout(r, 1000));

    // 1. Generate pairing data
    const pairOutput = execSync(
      `bun run apps/cli/src/index.ts pair --relay ws://localhost:${RELAY_PORT} --daemon-id relay-e2e`,
      { encoding: "utf-8" },
    );
    // Extract JSON pairing data from output
    const jsonMatch = pairOutput.match(/\{[^}]*"ps"[^}]*\}/);
    if (!jsonMatch) throw new Error("Failed to extract pairing JSON from tp pair output");
    pairingJson = jsonMatch[0];

    // 2. Start relay with --register-pairing
    relay = spawn("bun", [
      "run", "apps/cli/src/index.ts",
      "relay", "start", "--port", String(RELAY_PORT), "--register-pairing",
    ], {
      stdio: "pipe",
      env: { ...process.env, LOG_LEVEL: "error" },
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      const handler = (data: Buffer) => {
        if (data.toString().includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      relay.stdout?.on("data", handler);
      relay.stderr?.on("data", handler);
    });

    // 3. Start daemon connected to relay (reads pairing.json saved by tp pair)
    daemon = spawn("bun", [
      "run", "apps/cli/src/index.ts",
      "daemon", "start",
      "--ws-port", "7080",
      "--spawn", "--sid", "relay-e2e-session", "--cwd", "/tmp",
    ], {
      stdio: "pipe",
      env: { ...process.env, LOG_LEVEL: "error" },
    });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 8000);
      const handler = (data: Buffer) => {
        const text = data.toString();
        if (text.includes("connected to relay") || text.includes("press Ctrl+C")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      daemon.stdout?.on("data", handler);
      daemon.stderr?.on("data", handler);
    });

    await new Promise((r) => setTimeout(r, 2000));
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    relay?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("app pairs via relay and shows daemon in settings", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(2000);

    // Navigate to Settings tab (mobile viewport → tab bar visible)
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);

    // Click "Pair with Daemon"
    await page.locator("text=Pair with Daemon").click();

    // Wait for pairing screen to load
    await page.waitForSelector("text=Paste pairing data", { timeout: 10_000 });

    // Fill pairing JSON — use placeholder to target the correct textarea
    const textarea = page.locator("[placeholder*='ps']");
    await textarea.fill(pairingJson);
    await page.waitForTimeout(300);

    // Click "Connect"
    await page.locator("text=Connect").click();

    // Wait for crypto operations + relay connection (may take a few seconds on web WASM)
    await page.waitForTimeout(5000);

    // Should navigate back to main screen — go to Settings to verify
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);

    // The paired daemons list should contain our daemon ID
    const body = await page.locator("body").textContent();
    expect(body).toContain("relay-e2e");
  });

  test("diagnostics shows relay and E2EE info after pairing", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(2000);

    // Go to Settings
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);

    // Pair if not already paired (pairing persists in localStorage)
    const bodyText = await page.locator("body").textContent();
    if (!bodyText?.includes("relay-e2e")) {
      await page.locator("text=Pair with Daemon").click();
      await page.waitForSelector("text=Paste pairing data", { timeout: 10_000 });
      await page.locator("[placeholder*='ps']").fill(pairingJson);
      await page.waitForTimeout(300);
      await page.locator("text=Connect").click();
      await page.waitForTimeout(5000);
      await page.locator("text=Settings").last().click();
      await page.waitForTimeout(500);
    }

    // Open Diagnostics
    await page.locator("text=Diagnostics").click();
    await page.waitForTimeout(500);

    const diagText = await page.locator("body").textContent();
    expect(diagText).toContain("relay-e2e");
    expect(diagText).toContain("E2EE CRYPTO");
    expect(diagText).toContain("paired");
  });
});
