import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

/**
 * Regression guards for cross-package version invariants surfaced by
 * PRs #447 (react-dom alignment to fix web hydration) and #452
 * (expo-doctor exclude). These invariants live in package.json files,
 * which TypeScript and the test suite otherwise never inspect — so the
 * only way they get violated is silently, and the failure shows up
 * minutes later in CI (e2e blank page, eas-gate expo-doctor mismatch).
 */
describe("manifest invariants", () => {
  test("root pnpm.overrides.react matches pnpm.overrides.react-dom", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = pkg.pnpm?.overrides ?? {};
    expect(overrides["react"]).toBeDefined();
    expect(overrides["react-dom"]).toBeDefined();
    // If these drift apart again, the web bundle re-hits React error #527
    // (server-rendering→client-rendering fallback) and every e2e spec sees
    // a blank <body>. PR #447 was the fix; this guards against re-drift.
    expect(overrides["react-dom"]).toBe(overrides["react"] as string);
  });

  test("root pnpm.overrides.react matches apps/app's pinned react", () => {
    const root = JSON.parse(readFileSync("package.json", "utf-8")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const app = JSON.parse(readFileSync("apps/app/package.json", "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const override = root.pnpm?.overrides?.["react"];
    const appReact = app.dependencies?.["react"];
    expect(override).toBeDefined();
    expect(appReact).toBeDefined();
    // React enforces an EXACT-version match between `react` and the
    // `react-native-renderer` bundled inside react-native. apps/app pins
    // `react` to the version react-native@0.85.3's renderer was built
    // against (19.2.3); if the root override drifts to a different patch
    // (e.g. 19.2.6), the native dev build red-screens with "Incompatible
    // React versions" — invisible to type-check and RN-Web e2e because it
    // only manifests in the native renderer. Found during Q4 native
    // verification; this guard keeps the override pinned to the app's react.
    expect(override).toBe(appReact as string);
  });

  test("apps/app declares expo.install.exclude for react and react-dom", () => {
    const pkg = JSON.parse(readFileSync("apps/app/package.json", "utf-8")) as {
      expo?: { install?: { exclude?: string[] } };
    };
    const exclude = pkg.expo?.install?.exclude ?? [];
    // If either name is removed, expo-doctor's "Patch version mismatches"
    // check trips (root override pins react to a patch Expo SDK 56's
    // bundledNativeModules doesn't expect) and eas-gate fails on every PR
    // that touches apps/app. PR #452 was the
    // fix; this guards against accidental removal during dependency updates.
    expect(exclude).toContain("react");
    expect(exclude).toContain("react-dom");
  });
});
