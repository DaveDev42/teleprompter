import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Feature: "+" button in Sessions tab header opens NewSessionModal to let the
// user start a new Claude Code session from the app without needing to run `tp`
// on the daemon machine.
//
// Design 3: "+" in header → bottom-sheet NewSessionModal → createSession on the
// per-daemon relay client. Worktree-create deferred to a follow-up PR.
//
// All tests here are CI-eligible (no daemon required). Protocol round-trip
// (session appearing in the list after createSession) is covered by the
// daemon-backed local project.

const SESSIONS_KEY = "tp_sessions_v1";
const PAIRINGS_KEY = "tp_pairings_v3";

// Minimal dummy base64 key material — the deserialiser only decodes fields, no
// crypto validation at load time, so 3-zero-byte arrays are fine for rendering.
const DUMMY_KEY = "AAAA";

function makePairing(id: string, label?: string) {
  return {
    daemonId: `new-session-daemon-${id}`,
    relayUrl: "wss://relay.example.com",
    relayToken: "token-fixture",
    registrationProof: "proof-fixture",
    daemonPublicKey: DUMMY_KEY,
    frontendPublicKey: DUMMY_KEY,
    frontendSecretKey: DUMMY_KEY,
    frontendId: `frontend-${id}`,
    pairingSecret: DUMMY_KEY,
    pairedAt: Date.now(),
    label: label ?? null,
    labelSource: label ? "user" : undefined,
  };
}

/** Seed localStorage with a single paired daemon. */
async function seedSinglePairing(
  context: import("@playwright/test").BrowserContext,
  label?: string,
) {
  await context.addInitScript(
    ({ pairKey, pairVal, sessKey }) => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("tp_")) localStorage.removeItem(k);
        }
        localStorage.setItem(pairKey, JSON.stringify(pairVal));
        // Empty sessions list
        localStorage.setItem(sessKey, JSON.stringify({}));
      } catch {
        // ignore
      }
    },
    {
      pairKey: PAIRINGS_KEY,
      pairVal: [makePairing("alpha", label)],
      sessKey: SESSIONS_KEY,
    },
  );
}

/** Seed localStorage with two paired daemons. */
async function seedTwoPairings(
  context: import("@playwright/test").BrowserContext,
) {
  await context.addInitScript(
    ({ pairKey, pairVal, sessKey }) => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("tp_")) localStorage.removeItem(k);
        }
        localStorage.setItem(pairKey, JSON.stringify(pairVal));
        localStorage.setItem(sessKey, JSON.stringify({}));
      } catch {
        // ignore
      }
    },
    {
      pairKey: PAIRINGS_KEY,
      pairVal: [makePairing("alpha", "Alpha"), makePairing("beta", "Beta")],
      sessKey: SESSIONS_KEY,
    },
  );
}

test.describe("New-session UI — header button", () => {
  test('"+" button is visible in Sessions tab header in normal mode', async ({
    context,
    page,
  }) => {
    await seedSinglePairing(context);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const btn = page.getByTestId("sessions-new-button");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveRole("button");
    await expect(btn).toHaveAccessibleName("New session");
  });

  test('"+" button is keyboard-reachable (tabIndex 0)', async ({
    context,
    page,
  }) => {
    await seedSinglePairing(context);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const btn = page.getByTestId("sessions-new-button");
    const tabIndex = await btn.getAttribute("tabindex");
    expect(tabIndex).not.toBe("-1");
  });

  test('"+" button opens the NewSessionModal', async ({ context, page }) => {
    await seedSinglePairing(context);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-new-button").click();

    // Modal heading visible
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toBeVisible({ timeout: 5000 });
  });

  test('"+" button is hidden in edit mode', async ({ context, page }) => {
    await seedSinglePairing(context);

    // Seed a stopped session so Edit mode is fully active
    await context.addInitScript(
      ({ key, val }) => {
        localStorage.setItem(key, JSON.stringify(val));
      },
      {
        key: SESSIONS_KEY,
        val: {
          "new-session-daemon-alpha": [
            {
              sid: "stopped-123",
              cwd: "/tmp/foo",
              state: "stopped",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastSeq: 0,
            },
          ],
        },
      },
    );

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("sessions-edit-button").click();

    // "+" button must not be visible in edit mode (it's in the normal-mode branch)
    await expect(page.getByTestId("sessions-new-button")).toHaveCount(0);
  });
});

test.describe("New-session modal — heading and aria", () => {
  test.beforeEach(async ({ context }) => {
    await seedSinglePairing(context, "My Daemon");
  });

  async function openModal(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("sessions-new-button").click();
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toBeVisible({ timeout: 5000 });
  }

  test("dialog heading is role=heading level=2", async ({ page }) => {
    await openModal(page);
    const heading = page.getByRole("heading", {
      name: "New Session",
      level: 2,
    });
    await expect(heading).toBeVisible();
  });

  test("dialog has aria-labelledby pointing at the heading", async ({
    page,
  }) => {
    await openModal(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const labelledBy = await dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBe("new-session-modal-title");
  });

  test("Start button is aria-disabled when cwd is empty", async ({ page }) => {
    await openModal(page);
    const startBtn = page.getByTestId("new-session-start");
    await expect(startBtn).toHaveAttribute("aria-disabled", "true");
  });

  test("Start button is no longer aria-disabled when cwd is non-empty", async ({
    page,
  }) => {
    await openModal(page);
    await page.getByTestId("new-session-cwd-input").fill("/tmp/my-project");
    const startBtn = page.getByTestId("new-session-start");
    await expect(startBtn).not.toHaveAttribute("aria-disabled", "true");
  });

  test("cwd TextInput receives autofocus on modal open", async ({ page }) => {
    await openModal(page);
    const input = page.getByTestId("new-session-cwd-input");
    await expect(input).toBeFocused();
  });

  test("empty cwd submit shows inline error and keeps modal open", async ({
    page,
  }) => {
    await openModal(page);
    // Trigger handleStart via keyboard Enter in the input (maps to onSubmitEditing).
    // With an empty cwd the guard fires immediately and sets the inline error.
    const input = page.getByTestId("new-session-cwd-input");
    await input.press("Enter");

    // Error text appears
    const error = page.getByTestId("new-session-error");
    await expect(error).toBeVisible();

    // Modal still open
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toBeVisible();
  });

  test("typing in cwd clears the inline error", async ({ page }) => {
    await openModal(page);
    // Trigger error via Enter with empty input
    await page.getByTestId("new-session-cwd-input").press("Enter");
    await expect(page.getByTestId("new-session-error")).toBeVisible();

    // Now type something — onChange handler sets error back to null
    await page.getByTestId("new-session-cwd-input").fill("/tmp/project");
    await expect(page.getByTestId("new-session-error")).toHaveCount(0);
  });

  test("Cancel button closes the modal", async ({ page }) => {
    await openModal(page);
    await page.getByRole("button", { name: "Cancel new session" }).click();
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toHaveCount(0);
  });

  test("Escape key closes the modal", async ({ page }) => {
    await openModal(page);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toHaveCount(0);
  });
});

test.describe("New-session modal — 1 daemon static row", () => {
  test("shows static daemon row with status dot and label", async ({
    context,
    page,
  }) => {
    await seedSinglePairing(context, "Alpha");
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("sessions-new-button").click();
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toBeVisible({ timeout: 5000 });

    // No radiogroup — single daemon uses a static row
    const radioGroup = page.getByRole("radiogroup");
    await expect(radioGroup).toHaveCount(0);

    // "On: Alpha" text visible somewhere in the modal
    await expect(page.getByText(/Alpha/)).toBeVisible();
  });
});

test.describe("New-session modal — N≥2 daemon radiogroup", () => {
  test.beforeEach(async ({ context }) => {
    await seedTwoPairings(context);
  });

  async function openModal(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("sessions-new-button").click();
    await expect(
      page.getByRole("heading", { name: "New Session", level: 2 }),
    ).toBeVisible({ timeout: 5000 });
  }

  test("shows a radiogroup with one radio per daemon", async ({ page }) => {
    await openModal(page);
    const radios = page.getByRole("radio");
    await expect(radios).toHaveCount(2);
  });

  test("first radio is aria-checked=true (pre-selected)", async ({ page }) => {
    await openModal(page);
    const radios = page.getByRole("radio");
    // First radio selected by default
    await expect(radios.first()).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "false");
  });

  test("offline radios are visually dimmed (opacity-40) and remain unselected", async ({
    page,
  }) => {
    await openModal(page);
    const radios = page.getByRole("radio");
    // In the test environment no daemon is connected (relay connection store is
    // in-memory and not seeded), so both radios are offline/dimmed.
    // Verify opacity-40 dimming class is applied on the second radio.
    const second = radios.nth(1);
    const cls = await second.getAttribute("class");
    expect(cls).toContain("opacity-40");

    // Offline radio must remain unselected (aria-checked="false")
    await expect(second).toHaveAttribute("aria-checked", "false");
    // The first (pre-selected) radio stays selected
    await expect(radios.first()).toHaveAttribute("aria-checked", "true");
  });

  test("daemon labels (Alpha, Beta) appear in radiogroup", async ({ page }) => {
    await openModal(page);
    await expect(page.getByRole("radio", { name: "Alpha" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Beta" })).toBeVisible();
  });
});
