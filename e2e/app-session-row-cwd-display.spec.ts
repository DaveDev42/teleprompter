import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: session row titles used to show only the last path segment of
// cwd ("/tmp" rendered as "tmp", "/Users/dave/Projects/x" as just "x"), which
// collapsed distinct directories to the same label and dropped the path
// context entirely. The agreed display rule (see formatCwd in
// apps/app/src/lib/session-ux.ts):
//   - a path under the user's home is abbreviated with `~`
//     (/Users/dave/Projects/teleprompter → ~/Projects/teleprompter)
//   - any other absolute path is shown verbatim (/tmp/x → /tmp/x)
// formatCwd infers the home prefix from the POSIX convention because the
// daemon never transmits its home path. This spec pins the rendered title so a
// future tweak to that logic can't silently regress the display.

const SESSIONS_KEY = "tp_sessions_v1";

function makeSessionPayload() {
  const now = Date.now();
  return {
    "daemon-cwd": [
      {
        // macOS home subpath → abbreviated with ~
        sid: "cwd-home-mac",
        cwd: "/Users/qa-tester/Projects/teleprompter",
        state: "running",
        createdAt: now - 60_000,
        updatedAt: now - 5_000,
        lastSeq: 3,
      },
      {
        // Linux home subpath → abbreviated with ~
        sid: "cwd-home-linux",
        cwd: "/home/ci-runner/work/app",
        state: "stopped",
        createdAt: now - 120_000,
        updatedAt: now - 30_000,
        lastSeq: 8,
      },
      {
        // Non-home absolute path → shown verbatim (NOT basename "x")
        sid: "cwd-absolute",
        cwd: "/tmp/dogfood-offline/x",
        state: "stopped",
        createdAt: now - 180_000,
        updatedAt: now - 90_000,
        lastSeq: 2,
      },
    ],
  };
}

test.describe("Session row cwd display", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(
      ({ key, payload }) => {
        try {
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith("tp_")) localStorage.removeItem(k);
          }
          localStorage.setItem(key, JSON.stringify(payload));
        } catch {
          // ignore
        }
      },
      { key: SESSIONS_KEY, payload: makeSessionPayload() },
    );
  });

  test("home subpaths abbreviate to ~/… and other paths stay absolute", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // macOS home: /Users/qa-tester/Projects/teleprompter → ~/Projects/teleprompter
    await expect(page.getByTestId("session-row-cwd-home-mac")).toContainText(
      "~/Projects/teleprompter",
    );

    // Linux home: /home/ci-runner/work/app → ~/work/app
    await expect(page.getByTestId("session-row-cwd-home-linux")).toContainText(
      "~/work/app",
    );

    // Non-home: /tmp/dogfood-offline/x stays absolute, NOT the basename "x".
    const absoluteRow = page.getByTestId("session-row-cwd-absolute");
    await expect(absoluteRow).toContainText("/tmp/dogfood-offline/x");
  });

  test("the home-relative title appears in the row's accessible name", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Normal-mode rows are role=button with an explicit aria-label that folds
    // the desc + state + relative time. The desc must be the home-relative
    // path so screen-reader users get the same path context sighted users see.
    const macRow = page.getByTestId("session-row-cwd-home-mac");
    const label = await macRow.getAttribute("aria-label");
    expect(label).toContain("~/Projects/teleprompter");
  });
});
