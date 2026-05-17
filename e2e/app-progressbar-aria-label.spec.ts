import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: react-native-web's `ActivityIndicator` renders as
// `<div role="progressbar" aria-valuemin="0" aria-valuemax="1">` but
// does NOT propagate any accessible name — no aria-label,
// aria-labelledby, or aria-valuenow. ARIA 1.2 §6.3.20 requires
// role=progressbar to have an accessible name; without one, NVDA /
// JAWS / VoiceOver announce "progress bar" with no context, leaving
// the user unable to determine what is loading.
//
// `accessibilityLabel` doesn't reach the inner progressbar div on web
// (RN Web's ActivityIndicator wrapper swallows it), so the aria-label
// must be passed imperatively as a prop spread for web. Native AT
// reads accessibilityLabel from the underlying View.
//
// WCAG 4.1.2 (Name, Role, Value, Level A).
//
// Two usages exist in the app:
//   - apps/app/app/pairing/index.tsx — pairing loading view
//   - apps/app/app/(tabs)/settings.tsx — OTA update status
//
// The pairing flow is reachable in CI (no daemon needed) using the
// same minimal-payload technique as `app-pairing-loading-announce`.
// The settings spinner only mounts under live OTA state, so guard it
// with a source-level invariant.

test.describe("ActivityIndicator progressbar accessible name", () => {
  test("pairing loading ActivityIndicator exposes aria-label on progressbar", async ({
    page,
  }) => {
    await page.goto("/pairing");
    await page.waitForLoadState("networkidle");

    const url = await page.evaluate(() => {
      const did = "daemon-test-progressbar-label";
      const didBytes = new TextEncoder().encode(did);
      const buf = new Uint8Array(2 + 1 + 1 + didBytes.length + 1 + 32 + 32);
      let o = 0;
      buf.set(new TextEncoder().encode("tp"), o);
      o += 2;
      buf[o++] = 3; // version
      buf[o++] = didBytes.length;
      buf.set(didBytes, o);
      o += didBytes.length;
      buf[o++] = 0; // relayLen=0 → default relay
      o += 64; // ps(32) + pk(32) zeros (decoder accepts; ECDH later)
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const b64 = btoa(bin)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      return `tp://p?d=${b64}`;
    });

    // Capture the progressbar element the moment it mounts inside the
    // loading container. The pairing flow holds the loading branch
    // briefly while sodium init + key derive run; observing the mount
    // is more reliable than polling.
    const capturePromise = page.evaluate(() => {
      return new Promise<{ label: string | null; role: string | null }>(
        (resolve) => {
          const check = () => {
            const container = document.querySelector(
              '[data-testid="pairing-loading-status"]',
            );
            if (!container) return false;
            const bar = container.querySelector('[role="progressbar"]');
            if (!bar) return false;
            resolve({
              label: bar.getAttribute("aria-label"),
              role: bar.getAttribute("role"),
            });
            return true;
          };
          if (check()) return;
          const obs = new MutationObserver(() => {
            if (check()) obs.disconnect();
          });
          obs.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            obs.disconnect();
            resolve({ label: null, role: null });
          }, 10_000);
        },
      );
    });

    const textarea = page.locator("textarea");
    await textarea.fill(url);
    await page.getByRole("button", { name: /Connect|Confirm pairing/ }).click();

    const captured = await capturePromise;
    expect(captured.role).toBe("progressbar");
    expect(captured.label, "progressbar accessible name").toBeTruthy();
    expect(captured.label).toBe("Processing pairing data");
  });

  // OTA update spinner only mounts under live `useOtaUpdate` state
  // (checking / downloading), which is impossible to seed in CI
  // (Expo OTA needs an EAS update channel). Assert source-level that
  // the ActivityIndicator carries the web-only aria-label spread.
  test("settings OTA ActivityIndicator carries aria-label spread in source", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/app/(tabs)/settings.tsx"),
      "utf8",
    );

    // Strip JSX/line comments so prose doesn't trip the regex.
    let body = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    body = body.replace(/\/\*[\s\S]*?\*\//g, "");
    body = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // Find the ActivityIndicator opening tag.
    const tagStart = body.indexOf("<ActivityIndicator");
    expect(tagStart, "<ActivityIndicator in settings.tsx").toBeGreaterThan(-1);

    // Walk to the closing `/>` at JSX brace depth 0.
    const fromTag = body.slice(tagStart);
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < fromTag.length; i++) {
      const ch = fromTag[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "/" && depth === 0 && fromTag[i + 1] === ">") {
        endIdx = i + 1;
        break;
      }
    }
    expect(endIdx, "ActivityIndicator self-close").toBeGreaterThan(-1);
    const openTag = fromTag.slice(0, endIdx + 1);

    // Both accessibilityLabel (native) and aria-label spread (web)
    // must be present.
    expect(openTag, "accessibilityLabel on ActivityIndicator").toMatch(
      /accessibilityLabel\s*=/,
    );
    expect(openTag, "web-only aria-label spread on ActivityIndicator").toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,400}?["']aria-label["']\s*:/,
    );
  });

  // Same source-level invariant for the pairing ActivityIndicator — a
  // belt-and-suspenders guard so a future refactor that breaks the
  // imperative spread (e.g., removing the Platform.OS gate) is caught
  // without depending on the live-flow timing of the test above.
  test("pairing ActivityIndicator carries aria-label spread in source", () => {
    const source = readFileSync(
      resolve(__dirname, "../apps/app/app/pairing/index.tsx"),
      "utf8",
    );

    let body = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    body = body.replace(/\/\*[\s\S]*?\*\//g, "");
    body = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    const tagStart = body.indexOf("<ActivityIndicator");
    expect(tagStart, "<ActivityIndicator in pairing/index.tsx").toBeGreaterThan(
      -1,
    );

    const fromTag = body.slice(tagStart);
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < fromTag.length; i++) {
      const ch = fromTag[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "/" && depth === 0 && fromTag[i + 1] === ">") {
        endIdx = i + 1;
        break;
      }
    }
    expect(endIdx, "ActivityIndicator self-close").toBeGreaterThan(-1);
    const openTag = fromTag.slice(0, endIdx + 1);

    expect(openTag, "accessibilityLabel on ActivityIndicator").toMatch(
      /accessibilityLabel\s*=/,
    );
    expect(openTag, "web-only aria-label spread on ActivityIndicator").toMatch(
      /Platform\.OS\s*===\s*["']web["'][\s\S]{0,400}?["']aria-label["']\s*:/,
    );
  });
});
