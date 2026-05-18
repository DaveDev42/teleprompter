import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: on a hard reload with `tp_app_theme=dark` in localStorage, the
// page used to render a frame with light CSS variables (because the `.dark`
// class on <html> was only applied by a React useEffect after the async
// theme store finished loading). Dark-mode users saw a visible flash.
//
// Fix: scripts/inject-theme-bootstrap.ts injects an inline <script> into
// dist/index.html's <head> that reads localStorage synchronously and stamps
// `.dark` on <html> before the React bundle parses. This spec proves the
// class is on <html> as soon as the page is reachable, without waiting for
// any React effect to fire.

test.describe("Theme FOUC — dark class is stamped before React mounts", () => {
  test("hard reload with stored dark preference paints dark immediately", async ({
    page,
  }) => {
    // Seed localStorage. We can't set it before the first navigation (no
    // origin yet), so we visit once, write the key, then navigate again —
    // that second navigation is the one the bootstrap must handle.
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("tp_app_theme", "dark");
    });

    // Navigate without waiting for the React bundle to fully execute.
    // `domcontentloaded` fires after <head> scripts run synchronously but
    // before the deferred main bundle has finished — which is exactly the
    // window where FOUC manifests.
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const className = await page.evaluate(() =>
      document.documentElement.className.trim(),
    );
    expect(className.split(/\s+/)).toContain("dark");
  });

  test("hard reload with stored light preference does not stamp dark", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("tp_app_theme", "light");
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const hasDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDark).toBe(false);
  });

  test("bootstrap script is present in served index.html", async ({ page }) => {
    // Static guard: the served index.html literally contains the marker
    // script tag. If a future build pipeline change drops the injection
    // step, this fails before the runtime checks would.
    const response = await page.goto("/");
    expect(response).toBeTruthy();
    const html = await response?.text();
    expect(html).toContain('id="tp-theme-bootstrap"');
    expect(html).toContain("tp_app_theme");
  });
});
