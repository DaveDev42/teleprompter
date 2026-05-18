import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";

/**
 * Regression: chat resume de-dup after relay disconnect/reconnect (PR #461)
 *
 * Bug: on rapid relay disconnect/reconnect the useEffect in [sid].tsx
 * re-fired `client.resume(sid, 0)` each time `connected` flipped false→true.
 * Because cursor=0 asks for the full 10-frame relay cache, the same records
 * got replayed and re-processed → duplicate chat messages on flaky links.
 *
 * Fix (PR #461): a `resumedSidsRef` Set guards the effect so that
 * `resume(sid, 0)` is called at most once per sid per component mount.
 * Subsequent reconnects are handled inside RelayClient's `relay.auth.ok`
 * branch (auto-resume at lastSeq, not 0), which is idempotent and correct.
 *
 * What we measure:
 * `resume(sid, cursor)` calls `sendEncrypted({ t:"resume", sid, c:cursor })`
 * which produces a plaintext `{ t:"relay.pub", sid:"<session-sid>", ... }`
 * WS frame.  A WebSocket.prototype.send spy injected before the app boots
 * counts how many `relay.pub` frames are sent for the test session's sid on
 * each connect/reconnect cycle.
 *
 * Expected counts (per reconnect cycle):
 *   Fixed   (PR #461 present): 1 — only the RelayClient auto-resume
 *                              at lastSeq from relay.auth.ok fires.
 *   Broken  (guard removed)  : 2 — auto-resume + React effect both fire.
 *
 * Disconnect strategy:
 *   Rather than restarting relay or daemon processes (which require process-
 *   level coordination and can be brittle), we inject a WebSocket constructor
 *   interceptor that collects all WS instances into window.__tp_ws_all.
 *   `page.evaluate` then calls ws.close() on each instance to force the
 *   frontend's relay connection to drop.  The RelayClient's scheduleReconnect
 *   kicks in and re-establishes the connection within 1-2 s, running through
 *   relay.auth → relay.auth.ok → auto-resume.  This is exactly the path where
 *   the React-effect de-dup bug manifests.
 *
 * Steps:
 * 1. Start a local relay + daemon with a known session id.
 * 2. Inject a WS spy via page.addInitScript before the app loads (captures
 *    both all WS instances and outgoing relay.pub counts).
 * 3. Pair the app to the daemon.
 * 4. Navigate to the session view and wait for the first relay.pub to the
 *    session sid (confirming initial resume(sid,0) fired once).
 * 5. Force-close the WS 3 times, waiting for reconnect each time.
 * 6. After each reconnect, assert the relay.pub count for SESSION_ID
 *    increased by exactly 1 (not 2+).
 *
 * Local-only: requires spawning real daemon + relay processes.
 * NOT registered in the playwright.config.ts `ci` testMatch array.
 *
 * Port 17093 — distinct from app-relay-e2e.spec.ts (17090),
 * app-multi-daemon-nxn.spec.ts (17091), app-roundtrip.spec.ts (17092).
 */

const RELAY_PORT = 17093;
const SESSION_ID = "resume-dedup-test";
const DAEMON_LABEL = "resume-dedup-daemon";

let relay: ChildProcess;
let daemon: ChildProcess;
let pairingUrl = "";

// Mobile viewport so the tab bar is visible.
test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForOutput(
  proc: ChildProcess,
  pattern: string,
  timeoutMs = 15_000,
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

function startPairNew(
  label: string,
  relayUrl: string,
): { proc: ChildProcess; urlPromise: Promise<{ url: string }> } {
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
        LOG_LEVEL: "error",
        TP_NO_AUTO_INSTALL: "1",
      },
    },
  );

  const urlPromise = new Promise<{ url: string }>((resolve, reject) => {
    let buf = "";
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
      const urlMatch = buf.match(/tp:\/\/p\?d=[A-Za-z0-9_=-]+/);
      if (urlMatch) {
        clearTimeout(timeout);
        resolve({ url: urlMatch[0] });
      }
    };
    proc.stdout?.on("data", handler);
    proc.stderr?.on("data", handler);
    proc.on("error", reject);
  });

  return { proc, urlPromise };
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

test.describe("Chat resume de-dup after relay disconnect/reconnect (PR #461)", () => {
  test.beforeAll(async () => {
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

    // Remove stale IPC socket so the daemon starts cleanly.
    const uid = process.getuid?.() ?? 501;
    const defaultRuntimeDir =
      process.env.XDG_RUNTIME_DIR ?? `/tmp/teleprompter-${uid}`;
    try {
      execSync(`rm -f "${defaultRuntimeDir}/daemon.sock"`, { stdio: "ignore" });
    } catch {}
    // Clean stale pair lock.
    const defaultConfigDir = process.env.XDG_CONFIG_HOME
      ? `${process.env.XDG_CONFIG_HOME}/teleprompter`
      : `${process.env.HOME}/.config/teleprompter`;
    try {
      execSync(`rm -f "${defaultConfigDir}/pair.lock"`, { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 800));

    // 1. Start local relay.
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

    // 2. Start daemon (spawns a session with a known sid).
    daemon = spawn(
      "bun",
      [
        "run",
        "apps/cli/src/index.ts",
        "daemon",
        "start",
        "--spawn",
        "--sid",
        SESSION_ID,
        "--cwd",
        "/tmp",
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          LOG_LEVEL: "error",
          TP_NO_AUTO_INSTALL: "1",
        },
      },
    );
    await waitForOutput(daemon, "press Ctrl+C", 20_000);
    await new Promise((r) => setTimeout(r, 800));

    // 3. Initiate pairing against the local relay.
    const pair = startPairNew(DAEMON_LABEL, `ws://localhost:${RELAY_PORT}`);
    const result = await pair.urlPromise;
    pairingUrl = result.url;
    // The pair process blocks until the frontend completes kx.
    pair.proc.on("error", () => {});
  });

  test.afterAll(async () => {
    daemon?.kill("SIGTERM");
    relay?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
  });

  // -------------------------------------------------------------------------
  // Helper: paste a pairing URL into /pairing and click Connect.
  // -------------------------------------------------------------------------
  async function pairViaPaste(
    page: import("@playwright/test").Page,
    url: string,
  ): Promise<void> {
    await page.goto("/pairing");
    await page.waitForSelector('[data-testid="pairing-input"]', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="pairing-input"]').fill(url);
    await page.waitForTimeout(400);
    await page.locator('[data-testid="pairing-connect"]').click();
    // Allow pairing handshake (relay roundtrip) to complete.
    await page.waitForTimeout(8_000);
  }

  // -------------------------------------------------------------------------
  // Core regression test
  //
  // Strategy: inject a WebSocket constructor spy + send spy before the app
  // loads.  The constructor spy collects all WS instances so we can force-
  // close them from page.evaluate.  The send spy counts outgoing relay.pub
  // frames addressed to SESSION_ID.
  //
  // `resume(sid, cursor)` → sendEncrypted({ t:"resume", sid, c:cursor })
  // → plaintext relay.pub: { t:"relay.pub", sid:"<session-sid>", ct, seq:0 }.
  //
  // Forcing all WS instances closed simulates the relay dropping the frontend
  // connection.  RelayClient's ws.onclose fires → scheduleReconnect (1s) →
  // new WS → relay.auth → relay.auth.ok → auto-resume (1 relay.pub) and,
  // without the fix, the React useEffect also fires (2nd relay.pub).
  //
  // Expected (fixed):  1 per reconnect — auto-resume only.
  // Expected (broken): 2 per reconnect — auto-resume + React effect.
  // -------------------------------------------------------------------------
  test("resume(sid,0) fires at most once per sid across reconnect cycles", async ({
    page,
  }) => {
    // Install interceptors before any page load.
    await page.addInitScript((sid: string) => {
      const w = window as Window & {
        __tp_pub_counts: Record<string, number>;
        __tp_ws_all: WebSocket[];
      };
      w.__tp_pub_counts = {};
      w.__tp_ws_all = [];

      // Intercept WebSocket.prototype.send to both count relay.pub frames
      // and collect each WS instance for later forced-close.
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        // Collect each unique instance on first send.
        if (!w.__tp_ws_all.includes(this)) {
          w.__tp_ws_all.push(this);
        }
        try {
          if (typeof data === "string") {
            const msg = JSON.parse(data) as {
              t?: string;
              sid?: string;
            };
            if (msg.t === "relay.pub" && msg.sid === sid) {
              w.__tp_pub_counts[sid] = (w.__tp_pub_counts[sid] ?? 0) + 1;
            }
          }
        } catch {
          // never break the actual send
        }
        return origSend.apply(this, [data] as Parameters<typeof origSend>);
      };
    }, SESSION_ID);

    // Navigate and pair.
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });

    await pairViaPaste(page, pairingUrl);

    // Navigate to the session view.
    await page.goto(`/session/${SESSION_ID}`);
    await page.waitForLoadState("networkidle");

    // Poll until the initial relay.pub to SESSION_ID arrives.
    // This confirms the first resume(sid, 0) fired (from the React effect on
    // the first connected=true transition).  Allow up to 20 s.
    let initialCount = 0;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      initialCount = await page.evaluate(
        (sid: string) =>
          (window as Window & { __tp_pub_counts: Record<string, number> })
            .__tp_pub_counts[sid] ?? 0,
        SESSION_ID,
      );
      if (initialCount > 0) break;
    }
    // Confirm the initial resume(sid,0) was observed.
    expect(initialCount).toBeGreaterThan(0);

    // -----------------------------------------------------------------------
    // Flap cycles: force-close all WS instances → wait for reconnect →
    // assert per-cycle relay.pub delta is exactly 1 (auto-resume only).
    // -----------------------------------------------------------------------
    for (let cycle = 1; cycle <= 3; cycle++) {
      const countBefore = await page.evaluate(
        (sid: string) =>
          (window as Window & { __tp_pub_counts: Record<string, number> })
            .__tp_pub_counts[sid] ?? 0,
        SESSION_ID,
      );

      // Force-close all open WebSocket connections held by the app.
      // This simulates a network interruption that drops the relay connection.
      // RelayClient's ws.onclose fires → scheduleReconnect (1s base) →
      // new WS → relay.auth → relay.auth.ok.
      await page.evaluate(() => {
        const w = window as Window & { __tp_ws_all: WebSocket[] };
        for (const ws of w.__tp_ws_all) {
          if (ws.readyState === WebSocket.OPEN) {
            // 3000+ codes are allowed in browser WebSocket.close().
            ws.close(3000, "test-induced flap");
          }
        }
        // Reset the list so the next cycle only closes fresh connections.
        w.__tp_ws_all = [];
      });

      // Brief pause so ws.onclose has fired and scheduleReconnect has queued.
      await page.waitForTimeout(500);

      // Wait for the frontend to reconnect and emit exactly 1 relay.pub
      // to SESSION_ID.  Allow up to 20 s for the full auth + kx + resume cycle.
      let reconnected = false;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(500);
        const current = await page.evaluate(
          (sid: string) =>
            (window as Window & { __tp_pub_counts: Record<string, number> })
              .__tp_pub_counts[sid] ?? 0,
          SESSION_ID,
        );
        if (current > countBefore) {
          reconnected = true;
          break;
        }
      }
      expect(reconnected).toBe(true);

      const countAfter = await page.evaluate(
        (sid: string) =>
          (window as Window & { __tp_pub_counts: Record<string, number> })
            .__tp_pub_counts[sid] ?? 0,
        SESSION_ID,
      );
      const increase = countAfter - countBefore;

      // With the fix (PR #461): exactly 1 relay.pub per cycle.
      //   - 1 comes from RelayClient.relay.auth.ok auto-resume at lastSeq.
      // Without the fix: 2 per cycle — the React useEffect also fires
      //   resume(sid, 0) once `connected` transitions false→true.
      expect(increase).toBeLessThanOrEqual(1);
    }
  });
});
