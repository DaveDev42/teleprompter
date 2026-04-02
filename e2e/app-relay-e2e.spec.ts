import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

/**
 * Full relay E2E: Runner -> Daemon -> Relay -> App (via Playwright)
 *
 * Tests the complete pipeline:
 * 1. Start local relay server
 * 2. Generate pairing data (via tp pair)
 * 3. Start daemon connected to relay
 * 4. App pairs via manual paste -> relay E2EE connection
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

    // 2. Start relay
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

    // 3. Start daemon A
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

    // 4. Generate pairing data for daemon B
    pairingJsonB = extractPairingJson(
      execSync(
        `bun run apps/cli/src/index.ts pair --relay ws://localhost:${RELAY_PORT} --daemon-id relay-e2e-B`,
        { encoding: "utf-8" },
      ),
    );

    // 5. Start daemon B on a different WS port
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

  async function pairWithDaemon(
    page: import("@playwright/test").Page,
    json: string,
  ) {
    // Navigate to Daemons tab
    await page.locator("text=Daemons").last().click();
    await page
      .waitForSelector("text=No daemons connected", {
        timeout: 5_000,
      })
      .catch(() => {});

    // Click manual pairing link or "+" button
    const manualLink = page.locator("text=enter pairing data manually");
    if (await manualLink.isVisible().catch(() => false)) {
      await manualLink.click();
    } else {
      // Use the "+" button if daemons already paired
      await page.locator("text=+").first().click();
    }

    // Wait for pairing screen
    await page.waitForSelector("[placeholder*='ps']", { timeout: 10_000 });

    // Fill and submit — use exact match to avoid "No daemons connected" false positive
    await page.locator("[placeholder*='ps']").fill(json);
    await page.locator("text=/^Connect$/").click();
    await page.waitForTimeout(5000);
  }

  test("app pairs with daemon A via relay", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    await pairWithDaemon(page, pairingJsonA);

    // Verify daemon appears in Daemons tab
    await page.locator("text=Daemons").last().click();
    await expect(page.locator("text=relay-e2e-A").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("N:N — app shows two paired daemons simultaneously", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    // Pair daemon A
    await pairWithDaemon(page, pairingJsonA);

    // Pair daemon B via direct URL to avoid modal issues
    await page.goto("/pairing");
    await page.waitForSelector("[placeholder*='ps']", { timeout: 10_000 });
    await page.locator("[placeholder*='ps']").fill(pairingJsonB);
    await page.locator("text=/^Connect$/").click();
    await page.waitForTimeout(5000);

    // Verify BOTH daemons in Daemons tab
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });
    await page.locator("text=Daemons").last().click();

    const body = await page.locator("body").textContent();
    expect(body).toContain("relay-e2e-A");
    expect(body).toContain("relay-e2e-B");
  });

  test("diagnostics shows pairing and E2EE info", async ({ page }) => {
    // Pair via direct URL
    await page.goto("/pairing");
    await page.waitForSelector("[placeholder*='ps']", { timeout: 15_000 });
    await page.locator("[placeholder*='ps']").fill(pairingJsonA);
    await page.locator("text=/^Connect$/").click();
    await page.waitForTimeout(5000);

    // Go to Settings -> Diagnostics
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });
    await page.locator("text=Settings").last().click();
    await page.waitForSelector("text=Diagnostics", { timeout: 5_000 });
    await page.locator("text=Diagnostics").first().click();
    await page
      .waitForSelector("text=E2EE CRYPTO", { timeout: 5_000 })
      .catch(() => {});

    const diagText = await page.locator("body").textContent();
    expect(diagText).toContain("E2EE CRYPTO");
    expect(diagText).toContain("paired");
  });
});
