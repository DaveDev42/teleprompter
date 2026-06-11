import { expect, type Page, test } from "@playwright/test";

/**
 * Gamepad navigation (web): use-gamepad-nav.ts polls navigator.getGamepads()
 * and maps D-pad/A/B/LB/RB onto focus moves, activation, Escape, and
 * bottom-tab cycling. The Gamepad API needs real hardware, so the stub
 * below replaces getGamepads via addInitScript (same pattern as the
 * mediaDevices stub in app-pairing-scan-web-camera.spec.ts) — this also
 * side-steps Chromium's user-gesture requirement for pad exposure.
 *
 * Standard mapping indices under test: 0=A, 1=B, 4=LB, 5=RB, 13=D-pad down.
 */

declare global {
  interface Window {
    __setGamepadButtons: (pressed: number[]) => void;
    __disconnectGamepad: () => void;
  }
}

const GAMEPAD_STUB = `
  (() => {
    const pads = [null, null, null, null];
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => pads,
    });
    window.__setGamepadButtons = (pressed) => {
      pads[0] = {
        id: "Stub Gamepad (STANDARD GAMEPAD)",
        index: 0,
        connected: true,
        mapping: "standard",
        timestamp: 0,
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: pressed.includes(i),
          touched: pressed.includes(i),
          value: pressed.includes(i) ? 1 : 0,
        })),
        axes: [0, 0, 0, 0],
      };
    };
    window.__disconnectGamepad = () => {
      pads[0] = null;
    };
  })();
`;

/** Connect the stub pad and fire the event the hook starts polling on. */
async function connectGamepad(page: Page) {
  await page.evaluate(() => {
    window.__setGamepadButtons([]);
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  // Poll loop is up once the focus-ring class lands on <html>.
  await expect(page.locator("html")).toHaveClass(/tp-gamepad-nav/);
}

/** Wait until the rAF poll loop has processed at least one full frame. */
async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
}

/** One edge-triggered press+release of a single button. */
async function pressButton(page: Page, button: number) {
  await page.evaluate((b) => window.__setGamepadButtons([b]), button);
  await settleFrames(page);
  await page.evaluate(() => window.__setGamepadButtons([]));
  await settleFrames(page);
}

test.describe("Gamepad Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(GAMEPAD_STUB);
    await page.goto("/");
    await page.getByTestId("tab-sessions").waitFor({ timeout: 30_000 });
  });

  test("connect shows a toast and enables the focus ring class; disconnect clears it", async ({
    page,
  }) => {
    await connectGamepad(page);

    const toast = page.getByTestId("toast-live-region");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Controller connected");

    await page.evaluate(() => {
      window.__disconnectGamepad();
      window.dispatchEvent(new Event("gamepaddisconnected"));
    });
    await expect(page.locator("html")).not.toHaveClass(/tp-gamepad-nav/);
  });

  test("RB/LB cycle the bottom tabs with wrap-around", async ({ page }) => {
    await connectGamepad(page);

    await pressButton(page, 5); // RB
    await expect(page).toHaveURL(/\/daemons$/);

    await pressButton(page, 5); // RB
    await expect(page).toHaveURL(/\/settings$/);

    await pressButton(page, 5); // RB wraps settings → sessions
    await expect(page).toHaveURL(/\/$/);

    await pressButton(page, 4); // LB wraps sessions → settings
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("D-pad down moves focus off <body> onto a real control", async ({
    page,
  }) => {
    await connectGamepad(page);

    await pressButton(page, 13); // D-pad down
    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      isBody: document.activeElement === document.body,
    }));
    expect(focused.isBody).toBe(false);
    expect(focused.tag).not.toBe("");
  });

  test("A activates the focused control and B closes a dialog", async ({
    page,
  }) => {
    await connectGamepad(page);

    // Open the shortcut help dialog via its keyboard binding; the modal's
    // initial-focus timer lands on the only focusable, the Done button.
    await page.keyboard.press("?");
    const modal = page.getByTestId("shortcut-help-modal");
    await expect(modal).toBeVisible();
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") === "Done" ||
        document.activeElement?.textContent === "Done",
    );

    await pressButton(page, 0); // A clicks the focused Done button
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("?");
    await expect(modal).toBeVisible();

    await pressButton(page, 1); // B → synthetic Escape closes the dialog
    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });

  test("LB/RB are suppressed while a dialog is open", async ({ page }) => {
    await connectGamepad(page);

    await page.keyboard.press("?");
    const modal = page.getByTestId("shortcut-help-modal");
    await expect(modal).toBeVisible();

    await pressButton(page, 5); // RB must not navigate under a modal
    await expect(page).toHaveURL(/\/$/);
    await expect(modal).toBeVisible();

    await pressButton(page, 1); // B closes it
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Registry released — RB navigates again.
    await pressButton(page, 5);
    await expect(page).toHaveURL(/\/daemons$/);
  });

  test("help dialog lists the controller bindings", async ({ page }) => {
    await page.keyboard.press("?");
    const modal = page.getByTestId("shortcut-help-modal");
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Game controller")).toBeVisible();
    await expect(modal.getByText("D-pad")).toBeVisible();
  });
});
