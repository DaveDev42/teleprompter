import { expect, test } from "@playwright/test";
import { type ChildProcess, execSync, spawn } from "child_process";
import { waitForDaemonReady } from "./lib/daemon-readiness";

/**
 * P0: a session created AFTER the app connected appears once the user refreshes.
 *
 * Reproduces the reported bug end-to-end: the session list is push-driven, and
 * a resume reconnect skips kx so the daemon's kx-triggered `onFrontendJoined`
 * hello never re-fires — a session started while the app was already connected
 * stayed invisible. The fix makes the app request the full list on (re)connect
 * AND exposes a manual refresh button that does the same. Here we drive the
 * manual path: connect, spawn a new session, click Refresh, assert it shows.
 *
 * Daemon-backed → `local` project only (needs a real relay round-trip).
 */

let daemonA: ChildProcess;
let daemonB: ChildProcess;

function startDaemonSession(sid: string): ChildProcess {
  return spawn(
    "bun",
    [
      "run",
      "apps/cli/src/index.ts",
      "daemon",
      "start",
      "--spawn",
      "--sid",
      sid,
      "--cwd",
      "/tmp",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOG_LEVEL: "error" },
    },
  );
}

test.describe("P0 — Sessions refresh (live)", () => {
  test.beforeAll(async () => {
    try {
      execSync("pkill -f 'daemon start'", { stdio: "ignore" });
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  });

  test.afterAll(async () => {
    daemonA?.kill("SIGTERM");
    daemonB?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("a session created after connect appears after Refresh", async ({
    page,
  }) => {
    // 1. Daemon + first session, app connects and sees it.
    daemonA = startDaemonSession("refresh-live-a");
    await waitForDaemonReady();

    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/");
    await page.waitForSelector("text=Sessions", { timeout: 30_000 });
    await expect(page.locator("text=refresh-live-a")).toBeVisible({
      timeout: 15_000,
    });

    // 2. Create a SECOND session on the same daemon while the app is connected.
    //    (The daemon process supervises whichever session it was told to spawn;
    //    a second `--spawn` on the same runtime registers another runner.)
    daemonB = startDaemonSession("refresh-live-b");
    await new Promise((r) => setTimeout(r, 3000));

    // 3. Press the manual Refresh button — this fires requestSessionList(),
    //    which makes the daemon re-publish its full list.
    const refresh = page.getByTestId("sessions-refresh-button");
    await refresh.click();

    // 3a. The in-flight refresh announces aria-busy=true to assistive tech for
    //     the ~1.2s spin, then settles back to false. With a daemon connected
    //     `sent > 0`, so handleRefresh sets refreshing=true (unlike the
    //     daemon-free CI spec, which short-circuits at sent===0). WCAG 4.1.2.
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toHaveAttribute("aria-busy", "false", {
      timeout: 5_000,
    });

    // 4. The new session reconciles into the list.
    await expect(page.locator("text=refresh-live-b")).toBeVisible({
      timeout: 15_000,
    });
  });
});
