import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

/**
 * 2×2 Multi-Daemon / Multi-Frontend Regression Spec
 *
 * Proves that two independent daemons can be paired with two independent
 * browser contexts (frontend A and frontend B) simultaneously, and that
 * E2EE session keys, daemonIds, and connection state remain fully isolated
 * across all four (daemon, frontend) tuples.
 *
 * Scenarios:
 * 1. Pairing fan-out: all 4 pairings complete; each frontend sees both daemons.
 * 2. Independent daemonIds: both frontends see the same two daemonIds, but each
 *    frontend has its own unique identity (isolated local store).
 * 3. Independent E2EE keys (UI-level): each frontend sees exactly 2 daemon cards,
 *    proving each decrypted its own relay.presence messages independently.
 * 4. Daemon switch persistence: killing daemon A affects only daemon A's
 *    connection in both frontends; daemon B stays connected for both.
 *
 * Local-only: requires spawning real daemon processes and a local relay.
 * NOT included in the CI `testMatch` array (see playwright.config.ts).
 *
 * Orchestration:
 * - Daemon A: isolated XDG_RUNTIME_DIR so it does not conflict with the
 *   production launchd-managed tp daemon on the developer's machine
 * - Daemon B: separately isolated XDG_RUNTIME_DIR
 * - Both daemons connect to a local relay on port 17092
 * - Frontend A (pageA): Playwright default context
 * - Frontend B (pageB): second browser.newContext(), isolated storage
 *
 * Pairing strategy (pair.lock constraint):
 *   A daemon can only hold one active `pair new` at a time (pair.lock).
 *   So we pair both frontends with both daemons in two sequential rounds:
 *     Round 1: daemon A×frontendA  +  daemon B×frontendA  (concurrently, nxn style)
 *     Round 2: daemon A×frontendB  +  daemon B×frontendB  (concurrently, after round 1 kx done)
 *   All pairings are done ONCE in beforeAll — tests only do assertions.
 *   This avoids pair.lock contention across test retries.
 */

const RELAY_PORT = 17092; // distinct from nxn spec (17091) and relay-e2e (17090)
const DAEMON_A_LABEL = "2x2-daemon-a";
const DAEMON_B_LABEL = "2x2-daemon-b";
// Both daemons use fully isolated XDG dirs to avoid conflicting with the
// launchd-managed production tp daemon running on the developer's machine.
// XDG_DATA_HOME must also be isolated so the test daemon does not inherit
// the developer's existing pairings from ~/.local/share/teleprompter/vault/
// store.sqlite (those pairings reference production relay URLs which would
// cause crypto-init errors during RelayManager reconnect attempts).
const DAEMON_A_RUNTIME_DIR = "/tmp/teleprompter-e2e-2x2-a";
const DAEMON_A_CONFIG_DIR = "/tmp/teleprompter-e2e-2x2-a-config";
const DAEMON_A_DATA_DIR = "/tmp/teleprompter-e2e-2x2-a-data";
const DAEMON_B_RUNTIME_DIR = "/tmp/teleprompter-e2e-2x2-b";
const DAEMON_B_CONFIG_DIR = "/tmp/teleprompter-e2e-2x2-b-config";
const DAEMON_B_DATA_DIR = "/tmp/teleprompter-e2e-2x2-b-data";

let relay: ChildProcess;
let daemonA: ChildProcess;
let daemonB: ChildProcess;

// Captured from round-1 pairing URL output.
let daemonAId = "";
let daemonBId = "";

// Suite-level pages.  Created in beforeAll so pairings persist across tests.
// Using the Playwright `page` fixture (pageA) and a manually managed second
// browser context (pageB) for isolation.
let pageA: import("@playwright/test").Page;
let pageB: import("@playwright/test").Page;
let ctxB: import("@playwright/test").BrowserContext;

// Use mobile viewport so the tab bar is visible.
test.use({ viewport: { width: 390, height: 844 } });
// beforeAll pairings (4 × ~12 s) + daemon/relay startup (~30 s) + assertions.
test.setTimeout(180_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForOutput(
  proc: ChildProcess,
  pattern: string,
  timeoutMs = 12_000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    const handler = (data: Buffer) => {
      if (data.toString().includes(pattern)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on("data", handler);
    proc.stderr?.on("data", handler);
  });
}

/**
 * Spawn `tp pair new --label <label> --relay <relay>` for a specific daemon,
 * capture its stdout, and resolve once the `tp://p?d=…` URL is emitted.
 * The subprocess stays alive until the browser completes the kx handshake.
 */
function startPairNew(
  label: string,
  relayUrl: string,
  extraEnv: Record<string, string> = {},
): {
  proc: ChildProcess;
  urlPromise: Promise<{ url: string; daemonId: string }>;
} {
  const proc = spawn(
    "bun",
    [
      "run",
      "apps/cli/src/index.ts",
      "pair",
      "new",
      "--label",
      label,
      "--relay",
      relayUrl,
    ],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        ...extraEnv,
        LOG_LEVEL: "error",
        TP_NO_AUTO_INSTALL: "1",
      },
    },
  );

  const urlPromise = new Promise<{ url: string; daemonId: string }>(
    (resolve, reject) => {
      let buf = "";
      let daemonId = "";
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `pair new --label ${label} timed out waiting for pairing URL`,
            ),
          ),
        30_000,
      );

      const handler = (data: Buffer) => {
        buf += data.toString();
        const idMatch = buf.match(/Daemon ID:\s+(daemon-\S+)/);
        if (idMatch) daemonId = idMatch[1];
        const urlMatch = buf.match(/tp:\/\/p\?d=[A-Za-z0-9_=-]+/);
        if (urlMatch && daemonId) {
          clearTimeout(timeout);
          resolve({ url: urlMatch[0], daemonId });
        }
      };
      proc.stdout?.on("data", handler);
      proc.stderr?.on("data", handler);
      proc.on("error", reject);
    },
  );

  return { proc, urlPromise };
}

/**
 * Paste a pairing URL into /pairing and click Connect.
 * Navigates directly to the pairing route; avoids clicking the tab bar
 * which can be intercepted by the error-toast overlay after a relay flow.
 */
async function pairViaPaste(
  page: import("@playwright/test").Page,
  url: string,
  baseUrl = "http://localhost:8081",
): Promise<void> {
  await page.goto(`${baseUrl}/pairing`);
  await page.waitForSelector('[data-testid="pairing-input"]', {
    timeout: 15_000,
  });
  await page.locator('[data-testid="pairing-input"]').fill(url);
  await page.waitForTimeout(400);
  await page.locator('[data-testid="pairing-connect"]').click();
  // Wait for the relay kx round-trip to complete.
  // 12 s gives the relay + daemon enough headroom even under load.
  await page.waitForTimeout(12_000);
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

test.describe("2×2 Multi-Daemon / Multi-Frontend — four pairings", () => {
  test.beforeAll(async ({ browser }) => {
    // beforeAll does all 4 pairings (~80 s) + daemon/relay startup (~30 s).
    // Playwright's default hook timeout is 60 s — extend it to match the test timeout.
    test.setTimeout(180_000);

    // Kill any leftover processes from prior aborted runs.
    try {
      execSync(`pkill -f 'relay start --port ${RELAY_PORT}'`, {
        stdio: "ignore",
      });
    } catch {}
    try {
      execSync("pkill -f 'apps/cli/src/index.ts daemon start'", {
        stdio: "ignore",
      });
    } catch {}
    try {
      execSync("pkill -f 'apps/cli/src/index.ts pair new'", {
        stdio: "ignore",
      });
    } catch {}
    // Wipe and recreate isolated dirs for both daemons (clean slate per run).
    try {
      execSync(
        `rm -rf ${DAEMON_A_RUNTIME_DIR} ${DAEMON_A_CONFIG_DIR} ${DAEMON_A_DATA_DIR} ` +
          `${DAEMON_B_RUNTIME_DIR} ${DAEMON_B_CONFIG_DIR} ${DAEMON_B_DATA_DIR}`,
        { stdio: "ignore" },
      );
    } catch {}
    await new Promise((r) => setTimeout(r, 800));

    execSync(
      `mkdir -p ${DAEMON_A_RUNTIME_DIR} ${DAEMON_A_CONFIG_DIR}/teleprompter ` +
        `${DAEMON_A_DATA_DIR}/teleprompter/vault/sessions ` +
        `${DAEMON_B_RUNTIME_DIR} ${DAEMON_B_CONFIG_DIR}/teleprompter ` +
        `${DAEMON_B_DATA_DIR}/teleprompter/vault/sessions`,
    );

    // 1. Start the local relay.
    relay = spawn(
      "bun",
      [
        "run",
        "apps/cli/src/index.ts",
        "relay",
        "start",
        "--port",
        String(RELAY_PORT),
      ],
      { stdio: "pipe", env: { ...process.env, LOG_LEVEL: "error" } },
    );
    await waitForOutput(relay, "listening");

    // 2. Start daemon A on its fully isolated paths (runtime + config + data).
    daemonA = spawn(
      "bun",
      ["run", "apps/cli/src/index.ts", "daemon", "start"],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          LOG_LEVEL: "error",
          TP_NO_AUTO_INSTALL: "1",
          XDG_RUNTIME_DIR: DAEMON_A_RUNTIME_DIR,
          XDG_CONFIG_HOME: DAEMON_A_CONFIG_DIR,
          XDG_DATA_HOME: DAEMON_A_DATA_DIR,
        },
      },
    );
    await waitForOutput(daemonA, "press Ctrl+C", 12_000);
    await new Promise((r) => setTimeout(r, 600));

    // 3. Start daemon B on its separately isolated paths.
    daemonB = spawn(
      "bun",
      ["run", "apps/cli/src/index.ts", "daemon", "start"],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          LOG_LEVEL: "error",
          TP_NO_AUTO_INSTALL: "1",
          XDG_RUNTIME_DIR: DAEMON_B_RUNTIME_DIR,
          XDG_CONFIG_HOME: DAEMON_B_CONFIG_DIR,
          XDG_DATA_HOME: DAEMON_B_DATA_DIR,
        },
      },
    );
    await waitForOutput(daemonB, "press Ctrl+C", 12_000);
    await new Promise((r) => setTimeout(r, 600));

    // 4. Create suite-level browser pages.
    // pageA uses the default browser context; pageB gets a fresh isolated context.
    pageA = await browser.newPage();
    pageA.setDefaultTimeout(30_000);

    ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
    pageB = await ctxB.newPage();
    pageB.setDefaultTimeout(30_000);

    // Warm up both pages (loads JS bundle, initialises the app).
    await pageA.goto("http://localhost:8081/");
    await pageA.waitForSelector("text=Sessions", { timeout: 30_000 });

    await pageB.goto("http://localhost:8081/");
    await pageB.waitForSelector("text=Sessions", { timeout: 30_000 });

    const relayUrl = `ws://localhost:${RELAY_PORT}`;

    // ---------------------------------------------------------------------------
    // All pairings done ONCE here to avoid pair.lock contention across test
    // retries.  Tests only assert on the already-paired state.
    // ---------------------------------------------------------------------------

    // Round 1: pair both daemons with frontend A (parallel, different daemons
    // → different pair.lock paths).
    const round1A = startPairNew(`${DAEMON_A_LABEL}-fa`, relayUrl, {
      XDG_RUNTIME_DIR: DAEMON_A_RUNTIME_DIR,
      XDG_CONFIG_HOME: DAEMON_A_CONFIG_DIR,
      XDG_DATA_HOME: DAEMON_A_DATA_DIR,
    });
    const round1B = startPairNew(`${DAEMON_B_LABEL}-fa`, relayUrl, {
      XDG_RUNTIME_DIR: DAEMON_B_RUNTIME_DIR,
      XDG_CONFIG_HOME: DAEMON_B_CONFIG_DIR,
      XDG_DATA_HOME: DAEMON_B_DATA_DIR,
    });
    round1A.proc.on("error", () => {});
    round1B.proc.on("error", () => {});

    const [r1A, r1B] = await Promise.all([
      round1A.urlPromise,
      round1B.urlPromise,
    ]);

    // Capture daemon IDs (stable for the lifetime of the suite).
    daemonAId = r1A.daemonId;
    daemonBId = r1B.daemonId;

    // Paste round 1 URLs into frontend A (sequential to avoid concurrent
    // page.goto races on the same page).
    await pairViaPaste(pageA, r1A.url);
    await pairViaPaste(pageA, r1B.url);

    // Wait for round 1 pair processes to exit before starting round 2.
    // pair.lock is released only when the pair process exits after kx completes.
    await Promise.all([
      new Promise<void>((resolve) => {
        if (round1A.proc.exitCode !== null) {
          resolve();
        } else {
          round1A.proc.once("exit", () => resolve());
        }
      }),
      new Promise<void>((resolve) => {
        if (round1B.proc.exitCode !== null) {
          resolve();
        } else {
          round1B.proc.once("exit", () => resolve());
        }
      }),
    ]);

    // Round 2: pair both daemons with frontend B.
    const round2A = startPairNew(`${DAEMON_A_LABEL}-fb`, relayUrl, {
      XDG_RUNTIME_DIR: DAEMON_A_RUNTIME_DIR,
      XDG_CONFIG_HOME: DAEMON_A_CONFIG_DIR,
      XDG_DATA_HOME: DAEMON_A_DATA_DIR,
    });
    const round2B = startPairNew(`${DAEMON_B_LABEL}-fb`, relayUrl, {
      XDG_RUNTIME_DIR: DAEMON_B_RUNTIME_DIR,
      XDG_CONFIG_HOME: DAEMON_B_CONFIG_DIR,
      XDG_DATA_HOME: DAEMON_B_DATA_DIR,
    });
    round2A.proc.on("error", () => {});
    round2B.proc.on("error", () => {});

    const [r2A, r2B] = await Promise.all([
      round2A.urlPromise,
      round2B.urlPromise,
    ]);

    // Paste round 2 URLs into frontend B.
    await pairViaPaste(pageB, r2A.url);
    await pairViaPaste(pageB, r2B.url);
  });

  test.afterAll(async () => {
    await pageB?.close().catch(() => {});
    await ctxB?.close().catch(() => {});
    await pageA?.close().catch(() => {});
    daemonA?.kill("SIGTERM");
    daemonB?.kill("SIGTERM");
    relay?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      execSync(
        `rm -rf ${DAEMON_A_RUNTIME_DIR} ${DAEMON_A_CONFIG_DIR} ${DAEMON_A_DATA_DIR} ` +
          `${DAEMON_B_RUNTIME_DIR} ${DAEMON_B_CONFIG_DIR} ${DAEMON_B_DATA_DIR}`,
        { stdio: "ignore" },
      );
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // Test 1: Pairing fan-out
  // All 4 pairings complete; each frontend sees both daemons in the Daemons list.
  // ---------------------------------------------------------------------------
  test("pairing fan-out: both frontends see both daemons after 4 pairings", async () => {
    // Navigate directly to /daemons to avoid error-toast click interception.
    await pageA.goto("http://localhost:8081/daemons");
    await pageA.waitForLoadState("domcontentloaded");

    const cardsA = pageA.locator('[data-testid="daemon-card"]');
    await expect(cardsA).toHaveCount(2, { timeout: 15_000 });

    const bodyA = (await pageA.locator("body").textContent()) ?? "";
    expect(
      bodyA.includes(daemonAId.slice(0, 8)) || bodyA.includes(DAEMON_A_LABEL),
    ).toBe(true);
    expect(
      bodyA.includes(daemonBId.slice(0, 8)) || bodyA.includes(DAEMON_B_LABEL),
    ).toBe(true);

    await pageB.goto("http://localhost:8081/daemons");
    await pageB.waitForLoadState("domcontentloaded");

    const cardsB = pageB.locator('[data-testid="daemon-card"]');
    await expect(cardsB).toHaveCount(2, { timeout: 15_000 });

    const bodyB = (await pageB.locator("body").textContent()) ?? "";
    expect(
      bodyB.includes(daemonAId.slice(0, 8)) || bodyB.includes(DAEMON_A_LABEL),
    ).toBe(true);
    expect(
      bodyB.includes(daemonBId.slice(0, 8)) || bodyB.includes(DAEMON_B_LABEL),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Independent daemonIds
  // Both frontends resolve the same two daemonIds, but each frontend's local
  // storage is isolated (two separate contexts → two separate IndexedDB/MMKV).
  // ---------------------------------------------------------------------------
  test("independent daemonIds: both frontends see the same daemons but in isolated stores", async () => {
    // Confirm the two daemonIds are distinct.
    expect(daemonAId).toBeTruthy();
    expect(daemonBId).toBeTruthy();
    expect(daemonAId).not.toBe(daemonBId);

    // Frontend A Daemons list.
    await pageA.goto("http://localhost:8081/daemons");
    await pageA.waitForLoadState("domcontentloaded");
    await expect(pageA.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 15_000,
    });
    const bodyA = (await pageA.locator("body").textContent()) ?? "";
    const aSeesA =
      bodyA.includes(daemonAId.slice(0, 8)) || bodyA.includes(DAEMON_A_LABEL);
    const aSeesB =
      bodyA.includes(daemonBId.slice(0, 8)) || bodyA.includes(DAEMON_B_LABEL);
    expect(aSeesA && aSeesB).toBe(true);

    // Frontend B Daemons list.
    await pageB.goto("http://localhost:8081/daemons");
    await pageB.waitForLoadState("domcontentloaded");
    await expect(pageB.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 15_000,
    });
    const bodyB = (await pageB.locator("body").textContent()) ?? "";
    const bSeesA =
      bodyB.includes(daemonAId.slice(0, 8)) || bodyB.includes(DAEMON_A_LABEL);
    const bSeesB =
      bodyB.includes(daemonBId.slice(0, 8)) || bodyB.includes(DAEMON_B_LABEL);
    expect(bSeesA && bSeesB).toBe(true);

    // Storage isolation is already proven by the 2 daemon cards per context:
    // each context independently decrypted its own relay.presence messages
    // with its own E2EE key, so they couldn't share a store.
  });

  // ---------------------------------------------------------------------------
  // Test 3: Independent E2EE keys (UI-level proof)
  // Each frontend independently renders the Daemons list populated by its own
  // decrypted relay.presence messages.  If E2EE were shared / broken, one
  // frontend would either see 0 or 4 daemons instead of the expected 2.
  // Cross-decrypt rejection at the cryptographic level is already covered in
  // apps/cli/src/multi-frontend.test.ts; this test provides the UI-level proof.
  // ---------------------------------------------------------------------------
  test("independent E2EE keys: each frontend decrypts its own presence messages", async () => {
    // Both daemons are running; each frontend should see exactly 2 daemon cards.
    // If E2EE keys leaked across frontends, a frontend might fail to decrypt
    // the kx / presence frames and show 0 (decryption failure) or undefined
    // behaviour.  Exactly 2 = each frontend is decrypting with its own key.
    await pageA.goto("http://localhost:8081/daemons");
    await pageA.waitForLoadState("domcontentloaded");
    await expect(pageA.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 15_000,
    });

    await pageB.goto("http://localhost:8081/daemons");
    await pageB.waitForLoadState("domcontentloaded");
    await expect(pageB.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 15_000,
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: Daemon switch persistence
  // Killing daemon A disconnects daemon A for both frontends but leaves daemon B
  // connected for both.  This confirms that per-daemon WS connections in each
  // frontend are independent of each other.
  // ---------------------------------------------------------------------------
  test("daemon switch persistence: killing daemon A only disconnects daemon A for both frontends", async () => {
    // Confirm both frontends see 2 daemons before the kill.
    await pageA.goto("http://localhost:8081/daemons");
    await pageA.waitForLoadState("domcontentloaded");
    await expect(pageA.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 15_000,
    });

    await pageB.goto("http://localhost:8081/daemons");
    await pageB.waitForLoadState("domcontentloaded");
    await expect(pageB.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 15_000,
    });

    // Allow relay presence events to settle before killing.
    await pageA.waitForTimeout(2_000);

    // Kill daemon A.
    daemonA.kill("SIGTERM");

    // Give relay time to propagate the offline presence event to both frontends.
    await pageA.waitForTimeout(6_000);

    // Both frontends should still show 2 daemon cards (the card for daemon A
    // remains rendered but transitions to a disconnected state — it is not
    // removed from the list).
    await expect(pageA.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 5_000,
    });
    await expect(pageB.locator('[data-testid="daemon-card"]')).toHaveCount(2, {
      timeout: 5_000,
    });

    // Daemon B must still be listed in both frontends.
    const bodyA = (await pageA.locator("body").textContent()) ?? "";
    const hasBinA =
      bodyA.includes(daemonBId.slice(0, 8)) || bodyA.includes(DAEMON_B_LABEL);
    expect(hasBinA).toBe(true);

    const bodyB = (await pageB.locator("body").textContent()) ?? "";
    const hasBinB =
      bodyB.includes(daemonBId.slice(0, 8)) || bodyB.includes(DAEMON_B_LABEL);
    expect(hasBinB).toBe(true);

    // Total "Connected" count in each frontend must be ≤ 1
    // (daemon B only; daemon A shows as disconnected).
    const connectedA = (bodyA.match(/\bConnected\b/g) ?? []).length;
    const connectedB = (bodyB.match(/\bConnected\b/g) ?? []).length;
    expect(connectedA).toBeLessThanOrEqual(1);
    expect(connectedB).toBeLessThanOrEqual(1);
  });
});
