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

  test("root pnpm.overrides.@expo/dom-webview SDK-major matches apps/app's expo SDK", () => {
    const root = JSON.parse(readFileSync("package.json", "utf-8")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const app = JSON.parse(readFileSync("apps/app/package.json", "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const override = root.pnpm?.overrides?.["@expo/dom-webview"];
    const expoRange = app.dependencies?.["expo"];
    expect(override).toBeDefined();
    expect(expoRange).toBeDefined();
    // @expo/dom-webview versions its major in lockstep with the Expo SDK
    // (dom-webview 56.x ↔ Expo SDK 56). It's an override (not a direct dep)
    // pinning a transitive native module that @expo/log-box loads on device.
    // If the SDK is bumped (e.g. 55 → 56) but this override is left stale at
    // the old SDK major, the old native module's Kotlin/Swift references a
    // class removed in the new expo-modules-core (e.g. AnyTypeProvider) and
    // the Android dev build crashes into DevLauncherErrorActivity on launch
    // — invisible to type-check, RN-Web e2e, AND iOS (the iOS surface differs).
    // Found during Q3 Android native verification (override stuck at 55.0.5
    // after the SDK 56 upgrade). This guard ties the override's major to the
    // app's expo major so a future SDK bump can't silently leave it behind.
    const overrideMajor = (override as string).match(/^\D*(\d+)\./)?.[1];
    const expoMajor = (expoRange as string).match(/(\d+)\./)?.[1];
    expect(overrideMajor).toBeDefined();
    expect(expoMajor).toBeDefined();
    expect(overrideMajor).toBe(expoMajor);
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

  test("apps/app excludes the SDK-56-frozen expo packages from expo-doctor", () => {
    const pkg = JSON.parse(readFileSync("apps/app/package.json", "utf-8")) as {
      expo?: { install?: { exclude?: string[] } };
    };
    const exclude = pkg.expo?.install?.exclude ?? [];
    // These 9 are pinned to exactly what the installed expo@56.0.8's
    // bundledNativeModules.json declares. expo-doctor's "Check that packages
    // match versions required by installed Expo SDK" compares against a NEWER
    // npm patch (expo@56.0.9) and false-flags every one of them, failing
    // eas-gate on every PR that touches apps/app. They must NOT be bumped
    // (bumping ahead of the pinned SDK is cloud-unsafe — see
    // docs/local-verification-queue.md); exclude is the doctor-only escape
    // hatch. Same pattern as react/react-dom above. If any is removed without
    // also bumping the pin to match a newer installed expo SDK, eas-gate
    // breaks minutes later in CI — this catches it at test-time instead.
    for (const name of [
      "@expo/metro-runtime",
      "expo",
      "expo-build-properties",
      "expo-constants",
      "expo-dev-client",
      "expo-notifications",
      "expo-router",
      "expo-sharing",
      "expo-updates",
    ]) {
      expect(exclude).toContain(name);
    }
  });
});
