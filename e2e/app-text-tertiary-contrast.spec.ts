import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: tp-text-tertiary was #a1a1aa on light tp-bg (#ffffff) and
// #71717a on dark tp-bg (#09090b). Per WCAG 2.1 SC 1.4.3 (AA), normal
// body text needs ≥4.5:1 contrast — the light variant measured 2.56:1
// and the dark variant 4.12:1, both failing. Since this token backs
// section headings (Settings Appearance/Voice/About), badge metadata
// and other parseable text, the values were nudged darker (light) and
// lighter (dark) to clear AA.
//
// We pin the raw token values rather than running a full contrast
// calculation because the math is mechanical and a refactor that
// regresses contrast will almost certainly do so by editing the token.

async function readRgb(
  page: import("@playwright/test").Page,
  name: string,
): Promise<[number, number, number]> {
  // Resolve the variable through getComputedStyle on a probe element so
  // the browser normalizes hex shorthand, named colors, and rgb()
  // notation into rgb(r, g, b). Avoids us re-implementing CSS color
  // parsing.
  const rgb = await page.evaluate((varName) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${varName})`;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  }, name);
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`Could not parse color from ${name}: ${rgb}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const sRGB = c / 255;
    return sRGB <= 0.03928 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrast(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe("tp-text-tertiary contrast meets WCAG AA", () => {
  test("light mode tp-text-tertiary on tp-bg ≥ 4.5:1", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Force light mode by clearing any persisted dark class.
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
    });

    const fg = await readRgb(page, "--tp-text-tertiary");
    const bg = await readRgb(page, "--tp-bg");
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("dark mode tp-text-tertiary on tp-bg ≥ 4.5:1", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
    });

    const fg = await readRgb(page, "--tp-text-tertiary");
    const bg = await readRgb(page, "--tp-bg");
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
