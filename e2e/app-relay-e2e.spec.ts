import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

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
let daemonA: ChildProcess;
let daemonB: ChildProcess;
let pairingJsonA: string;
let pairingJsonB: string;
const RELAY_PORT = 17090;

// Use mobile viewport so tab bar is visible
test.use({ viewport: { width: 390, height: 844 } });

function extractPairingJson(output: string): string {
  const match = output.match(/\{[^}]*"ps"[^}]*\}/);
  if (!match) throw new Error("Failed to extract pairing JSON");
  return match[0];
}

function waitForOutput(
  proc: ChildProcess,
  pattern: string,
  timeoutMs = 8000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), timeoutMs);
    const handler = (data: Buffer) => {
      if (data.toString().includes(pattern)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    proc.stdout?.on("data", handler);
    proc.stderr?.on("data", handler);
  });
}

test.describe("Full Relay E2E — Runner → Daemon → Relay → App", () => {
  test.beforeAll(async () => {
    try {
      execSync("pkill -f 'relay start --port 17090'", { stdio: "ignore" });
    } catch {}
    try {
      execSync("pkill -f 'relay-e2e'", { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));

    // 1. Generate pairing data for daemon A
    pairingJsonA = extractPairingJson(
      execSync(
        `bun run apps/cli/src/index.ts pair --relay ws://localhost:${RELAY_PORT} --daemon-id relay-e2e-A`,
        { encoding: "utf-8" },
      ),
    );

    // 2. Start relay (registers daemon A's token from pairing.json)
    relay = spawn(
      "bun",
      [
        "run",
        "apps/cli/src/index.ts",
        "relay",
        "start",
        "--port",
        String(RELAY_PORT),
        "--register-pairing",
      ],
      { stdio: "pipe", env: { ...process.env, LOG_LEVEL: "error" } },
    );
    await waitForOutput(relay, "listening");

    // 3. Start daemon A (connects to relay via saved pairing.json)
    daemonA = spawn(
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
        "session-A",
        "--cwd",
        "/tmp",
      ],
      { stdio: "pipe", env: { ...process.env, LOG_LEVEL: "error" } },
    );
    await waitForOutput(daemonA, "press Ctrl+C");
    await new Promise((r) => setTimeout(r, 1000));

    // 4. Generate pairing data for daemon B (different daemon-id, same relay)
    pairingJsonB = extractPairingJson(
      execSync(
        `bun run apps/cli/src/index.ts pair --relay ws://localhost:${RELAY_PORT} --daemon-id relay-e2e-B`,
        { encoding: "utf-8" },
      ),
    );

    // 5. Register daemon B's token on the running relay
    //    (relay CLI --register-pairing only loads the latest pairing.json,
    //     but daemon B self-registers via relay.register on connect)
    // 6. Start daemon B on a different WS port
    daemonB = spawn(
      "bun",
      [
        "run",
        "apps/cli/src/index.ts",
        "daemon",
        "start",
        "--ws-port",
        "7081",
        "--spawn",
        "--sid",
        "session-B",
        "--cwd",
        "/tmp",
      ],
      { stdio: "pipe", env: { ...process.env, LOG_LEVEL: "error" } },
    );
    await waitForOutput(daemonB, "press Ctrl+C");
    await new Promise((r) => setTimeout(r, 1000));
  });

  test.afterAll(async () => {
    daemonA?.kill("SIGTERM");
    daemonB?.kill("SIGTERM");
    relay?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  async function pairWithDaemon(page: any, json: string) {
    // Navigate to Settings
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);

    // Click the "Pair with Daemon" button
    await page.locator("text=Pair with Daemon").first().click();
    await page.waitForTimeout(1000);

    // Wait for pairing screen — look for the placeholder text on the textarea
    await page.waitForSelector("[placeholder*='ps']", { timeout: 10_000 });

    // Fill and submit
    await page.locator("[placeholder*='ps']").fill(json);
    await page.waitForTimeout(300);
    await page.locator("text=Connect").first().click();
    await page.waitForTimeout(5000);
  }

  test("app pairs with daemon A via relay", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(2000);

    await pairWithDaemon(page, pairingJsonA);

    // Go to Settings to verify
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);
    const body = await page.locator("body").textContent();
    expect(body).toContain("relay-e2e-A");
  });

  test("N:N — app shows two paired daemons simultaneously", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(2000);

    // Pair daemon A via UI
    await pairWithDaemon(page, pairingJsonA);
    await page.waitForTimeout(1000);

    // For daemon B, navigate directly to pairing URL to avoid modal re-open issues
    await page.goto("/pairing");
    await page.waitForSelector("[placeholder*='ps']", { timeout: 10_000 });
    await page.locator("[placeholder*='ps']").fill(pairingJsonB);
    await page.waitForTimeout(300);
    await page.locator("text=Connect").first().click();
    await page.waitForTimeout(5000);

    // Navigate to Settings and verify BOTH daemons
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(2000);
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);

    const body = await page.locator("body").textContent();
    expect(body).toContain("relay-e2e-A");
    expect(body).toContain("relay-e2e-B");
    expect(body).toContain("Paired Daemons (2)");
  });

  test("diagnostics shows pairing and E2EE info", async ({ page }) => {
    // Pair via direct URL navigation
    await page.goto("/pairing");
    await page.waitForSelector("[placeholder*='ps']", { timeout: 15_000 });
    await page.locator("[placeholder*='ps']").fill(pairingJsonA);
    await page.waitForTimeout(300);
    await page.locator("text=Connect").first().click();
    await page.waitForTimeout(5000);

    // Go to Settings → Diagnostics
    await page.goto("/");
    await page.waitForSelector("text=Teleprompter", { timeout: 30_000 });
    await page.waitForTimeout(2000);
    await page.locator("text=Settings").last().click();
    await page.waitForTimeout(500);
    await page.locator("text=Diagnostics").first().click();
    await page.waitForTimeout(500);

    const diagText = await page.locator("body").textContent();
    expect(diagText).toContain("E2EE CRYPTO");
    expect(diagText).toContain("paired");
  });
});
