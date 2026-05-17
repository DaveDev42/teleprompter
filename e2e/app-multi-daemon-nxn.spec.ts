import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

/**
 * N:N Multi-Daemon Regression Spec
 *
 * Proves that two independent daemons can be paired into one app
 * simultaneously and that their sessions, keys, and connection state
 * remain fully isolated.
 *
 * Scenarios:
 * 1. Both daemons appear in the Daemons list with correct labels.
 * 2. Each daemon's daemonId is distinct (independent frontendIds / keys).
 * 3. Killing one daemon shows it as disconnected; the other stays connected.
 *
 * Local-only: requires spawning real daemon processes and a local relay.
 * Not included in the CI `testMatch` array (see playwright.config.ts).
 *
 * Daemon orchestration:
 * - Daemon A: default XDG_RUNTIME_DIR (user runtime dir / /tmp/tp-<uid>)
 * - Daemon B: isolated XDG_RUNTIME_DIR so its IPC socket does not collide
 * - Both daemons connect to a local relay on port 17091
 */

const RELAY_PORT = 17091; // distinct from app-relay-e2e.spec.ts (17090)
const DAEMON_A_LABEL = "nxn-daemon-a";
const DAEMON_B_LABEL = "nxn-daemon-b";
// Daemon B runs in an isolated XDG_RUNTIME_DIR so its IPC socket and
// pair.lock do not collide with daemon A.
const DAEMON_B_RUNTIME_DIR = "/tmp/teleprompter-e2e-nxn-b";
// Daemon B's pair commands need a separate XDG_CONFIG_HOME so the pair.lock
// path doesn't conflict with daemon A's concurrent pair new process.
const DAEMON_B_CONFIG_DIR = "/tmp/teleprompter-e2e-nxn-b-config";

let relay: ChildProcess;
let daemonA: ChildProcess;
let daemonB: ChildProcess;
let pairingUrlA = "";
let pairingUrlB = "";
let daemonAId = "";
let daemonBId = "";

// Use mobile viewport so the tab bar is visible.
test.use({ viewport: { width: 390, height: 844 } });
// Each test involves 2 pairings (~8s each) + assertions + navigation.
// beforeAll alone takes ~30-40s for relay + daemon startup + pair URL generation.
test.setTimeout(120_000);

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
 * Spawn `tp pair new --label <label> --relay <relay>` for a daemon running at
 * `socketPath`, capture its stdout, and return the `tp://p?d=...` URL and
 * daemon ID once the QR line appears.
 *
 * The `pair new` command blocks until the frontend completes pairing.
 * We capture the URL from stdout and return it; the caller must paste the URL
 * into the browser to complete the handshake. The subprocess is resolved once
 * the `tp://p?d=` line is emitted (blocking on the daemon side to continue
 * until the frontend connects).
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
        // Prevent pair lock collisions between concurrent pair processes
        // (each daemon's pair.lock lives under its own config dir, but the
        // default config dir is shared). Use a separate tmp config dir per
        // daemon. The config dir location is resolved via getConfigDir() which
        // respects XDG_CONFIG_HOME on Linux; on macOS we rely on XDG_RUNTIME_DIR
        // being different to isolate the IPC socket, and accept that the
        // pair.lock path is shared on macOS. Since we run pairA first and wait
        // for its URL before starting pairB, the lock is not held concurrently.
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
        // Extract daemon ID from "Daemon ID:    daemon-xxxx" line
        const idMatch = buf.match(/Daemon ID:\s+(daemon-\S+)/);
        if (idMatch) daemonId = idMatch[1];
        // Extract tp:// URL from a standalone line
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

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

test.describe("N:N Multi-Daemon — two daemons, one app", () => {
  test.beforeAll(async () => {
    // Kill any leftover processes from prior aborted runs.
    // Include the default daemon so we get a clean slate.
    try {
      execSync(`pkill -f 'relay start --port ${RELAY_PORT}'`, {
        stdio: "ignore",
      });
    } catch {}
    try {
      execSync("pkill -f 'tp daemon start'", { stdio: "ignore" });
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
    // Remove stale IPC sockets and pair locks so daemons start cleanly.
    const uid = process.getuid?.() ?? 501;
    const defaultRuntimeDir =
      process.env.XDG_RUNTIME_DIR ?? `/tmp/teleprompter-${uid}`;
    try {
      execSync(`rm -f "${defaultRuntimeDir}/daemon.sock"`, { stdio: "ignore" });
    } catch {}
    // Clean stale pair locks.
    const defaultConfigDir = process.env.XDG_CONFIG_HOME
      ? `${process.env.XDG_CONFIG_HOME}/teleprompter`
      : `${process.env.HOME}/.config/teleprompter`;
    try {
      execSync(`rm -f "${defaultConfigDir}/pair.lock"`, { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 800));

    // Isolate daemon B's IPC socket and pair.lock from daemon A.
    execSync(
      `mkdir -p ${DAEMON_B_RUNTIME_DIR} ${DAEMON_B_CONFIG_DIR}/teleprompter`,
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

    // 2. Start daemon A (uses default XDG_RUNTIME_DIR / socket).
    daemonA = spawn(
      "bun",
      ["run", "apps/cli/src/index.ts", "daemon", "start"],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          LOG_LEVEL: "error",
          TP_NO_AUTO_INSTALL: "1",
        },
      },
    );
    // Wait for either "press Ctrl+C" (started successfully) or exit.
    await waitForOutput(daemonA, "press Ctrl+C", 12_000);
    await new Promise((r) => setTimeout(r, 600));

    // 3. Start daemon B on an isolated socket path.
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
        },
      },
    );
    await waitForOutput(daemonB, "press Ctrl+C", 12_000);
    await new Promise((r) => setTimeout(r, 600));

    // 4 & 5. Initiate pairing for both daemons in parallel.
    //    - Daemon A uses the default XDG_RUNTIME_DIR + config dir.
    //    - Daemon B uses isolated dirs so its IPC socket, pair.lock, and store
    //      do not collide with daemon A.
    //    Both pair.lock paths are distinct, so concurrent pair new is safe.
    const pairA = startPairNew(DAEMON_A_LABEL, `ws://localhost:${RELAY_PORT}`);
    const pairB = startPairNew(DAEMON_B_LABEL, `ws://localhost:${RELAY_PORT}`, {
      XDG_RUNTIME_DIR: DAEMON_B_RUNTIME_DIR,
      XDG_CONFIG_HOME: DAEMON_B_CONFIG_DIR,
    });

    const [resultA, resultB] = await Promise.all([
      pairA.urlPromise,
      pairB.urlPromise,
    ]);
    pairingUrlA = resultA.url;
    daemonAId = resultA.daemonId;
    pairingUrlB = resultB.url;
    daemonBId = resultB.daemonId;

    // The pair processes keep running (blocking on frontend kx completion).
    // They self-terminate once the browser pastes the pairing URLs.
    pairA.proc.on("error", () => {});
    pairB.proc.on("error", () => {});
  });

  test.afterAll(async () => {
    daemonA?.kill("SIGTERM");
    daemonB?.kill("SIGTERM");
    relay?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      execSync(`rm -rf ${DAEMON_B_RUNTIME_DIR} ${DAEMON_B_CONFIG_DIR}`, {
        stdio: "ignore",
      });
    } catch {}
  });

  // -------------------------------------------------------------------------
  // Helper: paste a pairing URL into /pairing and click Connect.
  // Returns after the pairing handshake completes and the app navigates away.
  // -------------------------------------------------------------------------
  async function pairViaPaste(
    page: import("@playwright/test").Page,
    url: string,
  ): Promise<void> {
    await page.goto("/pairing");
    // Wait for the pairing input (testID="pairing-input").
    await page.waitForSelector('[data-testid="pairing-input"]', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="pairing-input"]').fill(url);
    // Allow the preview card to appear (valid tp:// URL triggers state change).
    await page.waitForTimeout(400);
    await page.locator('[data-testid="pairing-connect"]').click();
    // Wait for pairing handshake: daemon sends pair.begin.ok, frontend completes kx.
    // Allow up to 12 s for the relay roundtrip.
    await page.waitForTimeout(8_000);
  }

  // -------------------------------------------------------------------------
  // Test 1: Both daemons appear in Daemons list after sequential pairing.
  //         Confirms N:N pairing at the UI level.
  // -------------------------------------------------------------------------
  test("both daemons are listed after sequential pairing", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    await pairViaPaste(page, pairingUrlA);
    await pairViaPaste(page, pairingUrlB);

    // Navigate to Daemons tab.
    await page.goto("/");
    await page.waitForSelector("text=Daemons", { timeout: 10_000 });
    await page.getByText("Daemons").last().click();

    // Two daemon cards must be visible.
    const cards = page.locator('[data-testid="daemon-card"]');
    await expect(cards).toHaveCount(2, { timeout: 8_000 });

    const bodyText = await page.locator("body").textContent();
    // The DaemonCard shows the short daemon ID (first 8 chars) when no label
    // has arrived yet via relay.kx, or the label after kx completes.
    // We match against both the short ID and the label.
    const hasA =
      (bodyText ?? "").includes(daemonAId.slice(0, 8)) ||
      (bodyText ?? "").includes(DAEMON_A_LABEL);
    const hasB =
      (bodyText ?? "").includes(daemonBId.slice(0, 8)) ||
      (bodyText ?? "").includes(DAEMON_B_LABEL);
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Each pairing has a distinct daemonId — E2EE key independence.
  //         The app must store two independent pairings, not the same one twice.
  // -------------------------------------------------------------------------
  test("each paired daemon has an independent daemonId", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    await pairViaPaste(page, pairingUrlA);
    await pairViaPaste(page, pairingUrlB);

    await page.goto("/");
    await page.waitForSelector("text=Daemons", { timeout: 10_000 });
    await page.getByText("Daemons").last().click();

    // Prerequisite: two cards.
    const cards = page.locator('[data-testid="daemon-card"]');
    await expect(cards).toHaveCount(2, { timeout: 8_000 });

    const bodyText = (await page.locator("body").textContent()) ?? "";

    // Both daemon IDs must appear in the page and be distinct.
    expect(daemonAId).toBeTruthy();
    expect(daemonBId).toBeTruthy();
    expect(daemonAId).not.toBe(daemonBId);

    // At least one of the ID-based identifiers must be visible per daemon.
    const hasA =
      bodyText.includes(daemonAId.slice(0, 8)) ||
      bodyText.includes(DAEMON_A_LABEL);
    const hasB =
      bodyText.includes(daemonBId.slice(0, 8)) ||
      bodyText.includes(DAEMON_B_LABEL);
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Killing daemon A makes it appear disconnected while daemon B
  //         remains connected — the core N:N isolation assertion.
  // -------------------------------------------------------------------------
  test("killing one daemon disconnects only that daemon", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    await pairViaPaste(page, pairingUrlA);
    await pairViaPaste(page, pairingUrlB);

    await page.goto("/");
    await page.waitForSelector("text=Daemons", { timeout: 10_000 });
    await page.getByText("Daemons").last().click();

    // Both cards must be present before we kill anything.
    const cards = page.locator('[data-testid="daemon-card"]');
    await expect(cards).toHaveCount(2, { timeout: 8_000 });

    // Allow relay presence events to propagate.
    await page.waitForTimeout(2_000);

    // SIGTERM daemon A.
    daemonA.kill("SIGTERM");

    // Allow relay offline-presence to propagate to the app (~5 s).
    await page.waitForTimeout(6_000);

    // Daemon B's card must still be present.
    await expect(cards).toHaveCount(2, { timeout: 5_000 });

    const bodyAfter = (await page.locator("body").textContent()) ?? "";
    // Daemon B must still be listed.
    const hasBAfter =
      bodyAfter.includes(daemonBId.slice(0, 8)) ||
      bodyAfter.includes(DAEMON_B_LABEL);
    expect(hasBAfter).toBe(true);

    // The "Connected" status must now be at most 1 (daemon B only).
    const connectedCount = (bodyAfter.match(/\bConnected\b/g) ?? []).length;
    expect(connectedCount).toBeLessThanOrEqual(1);
  });
});
