/**
 * Regression guard: libsodium init must NOT surface an unhandled
 * `WebAssembly.RuntimeError` on Hermes (React Native).
 *
 * The bug (PR #573 fallout): on Hermes there is no native WebAssembly, so
 * libsodium's emscripten output runs its primary (native-wasm) module first,
 * which calls the UNAWAITED `createWasm()`:
 *
 *     var wasmExports; createWasm(); run();   // fire-and-forget
 *
 * `createWasm() → instantiateArrayBuffer() → await WebAssembly.instantiate()`
 * hits crypto-polyfill's stub, whose `instantiate` rejects, so the catch runs
 * `abort(reason)`. `abort()` first calls `Module.onAbort` (which rejects the
 * OUTER `Module.ready` promise → its `.catch(() => useBackupModule())` runs the
 * wasm2js fallback, so crypto WORKS), but then unconditionally does
 * `var e = new WebAssembly.RuntimeError(what); throw e`. That throw rejects the
 * fire-and-forget `createWasm()` promise, which nothing awaits → an UNHANDLED
 * REJECTION that Hermes (in __DEV__) surfaces via
 * `HermesInternal.enablePromiseRejectionTracker`'s `onUnhandled` →
 * ExceptionsManager → LogBox:
 *   Uncaught (in promise): "WebAssembly.RuntimeError: Aborted(Error: WebAssembly
 *   is not available on this runtime). Build with -sASSERTIONS for more info."
 *
 * Verified against node_modules/libsodium/dist/modules/libsodium.js (the file
 * Metro bundles via the package `main`/`require` field): the primary module
 * reads `globalThis.WebAssembly` (no local shim); its `Module` is libsodium's own
 * exports object (NOT `globalThis.Module`, so `Module.instantiateWasm` cannot be
 * injected from the polyfill); and `abort()`'s `throw` is unconditional. Hence
 * the rejection is unavoidable by reshaping `globalThis.WebAssembly` — removing
 * the stub merely swaps the named `WebAssembly.RuntimeError` for
 * `ReferenceError: WebAssembly is not defined` (still unhandled). The fix KEEPS
 * the stub (pinning the rejection to a known name+message).
 *
 * The fix (this is the part these tests pin):
 * Three prior attempts all failed on-device against RN 0.85.3 New Architecture,
 * each blocked by a READ-ONLY native global in the rejection-report chain:
 *   - reassigning `HermesInternal.enablePromiseRejectionTracker` to wrap
 *     `onUnhandled` threw `TypeError: Cannot assign to read-only property` (it is
 *     a non-writable host property);
 *   - calling enable() eagerly was overwritten by RN/Expo's later registration;
 *   - wrapping `global.RN$handleException` (the report sink that
 *     `ExceptionsManager.handleException` gates on) was a SILENT no-op — that
 *     global is installed by native C++ via `defineReadOnlyGlobal`
 *     (`ReactInstance.cpp` → `Object.defineProperty` with only `value`, i.e.
 *     non-writable + non-configurable), so the JS assignment never takes and the
 *     report still fired on-device (RuntimeError present, read-only crash gone).
 *
 * The working fix CALLS (does not reassign) `enablePromiseRejectionTracker`
 * again, LAST. Hermes keeps a SINGLE tracker hook — last-call-wins — and the
 * property is read-only but the FUNCTION is callable. `@expo/metro-runtime`
 * relies on exactly this (it re-registers the tracker in
 * `getModulesRunBeforeMainModule`, after RN's `polyfillPromise`), which is why
 * our re-register from the app entry (`apps/app/index.ts` line 1) lands last and
 * wins. Our `onUnhandled` drops EXACTLY the libsodium-init rejection (matched by
 * `isLibsodiumInitRejection`) and delegates every other rejection to a faithful
 * copy of the default report — `new Error('Uncaught (in promise…)',
 * { cause: rejection })` routed through the public `global.ErrorUtils.reportError`
 * polyfill, which RN wires to `ExceptionsManager.handleException`
 * (`setUpErrorHandling.js`) — so it reaches the identical native sink WITHOUT a
 * deprecated deep import. This survives all three prior failure modes: it never
 * reassigns a read-only property, it runs last (so it is not overwritten), and it
 * filters AT the tracker rather than at the sealed `RN$handleException` sink.
 *
 * Test design: bun's test runner hard-fails on ANY raw unhandled rejection
 * (Hermes' tracker only observes the promise; it does not engine-level-handle it),
 * so we cannot let the real engine-level rejection escape in-process — such a test
 * could never go green with OR without the fix. Instead we verify the fix
 * faithfully, modeling the exact Hermes runtime contract:
 *   1. The predicate `isLibsodiumInitRejection` matches only the real rejection.
 *   2. Importing the polyfill on a runtime whose `HermesInternal` host object has
 *      a NON-WRITABLE / NON-CONFIGURABLE `enablePromiseRejectionTracker` (as real
 *      Hermes does) MUST NOT throw — this is the regression guard for the
 *      read-only crash. We never reassign that property; we only CALL it.
 *   3. After import, the LIVE tracker (the one the polyfill registered last,
 *      replacing the prior "Expo" registration) drops the libsodium rejection via
 *      its `onUnhandled` and DELEGATES every other rejection to the RN exception
 *      sink (proving we do not swallow genuine errors). We stub
 *      `global.ErrorUtils.reportError` so the delegated reports are observable
 *      without pulling in the whole RN runtime.
 * The synthesized rejection's name+message are lifted verbatim from running the
 * real CJS libsodium with `WebAssembly` deleted (see header). That crypto still
 * WORKS through the wasm2js fallback — the reason we swallow instead of crash — is
 * covered by the real-libsodium round-trips in `packages/protocol/src/crypto.test.ts`.
 *
 * This file mutates global console / WebAssembly / HermesInternal / ErrorUtils,
 * so it lives in its own test file per the repo's global-mutation isolation rule.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView | null>(buf: T): T => {
    if (buf && ArrayBuffer.isView(buf)) {
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) & 0xff;
    }
    return buf;
  },
}));

type RejectionTrackerOptions = {
  allRejections?: boolean;
  onUnhandled?: (id: number, rejection?: unknown) => void;
  onHandled?: (id: number) => void;
};

// Records every exception the polyfill's onUnhandled delegates to the RN sink.
// The polyfill routes genuine (non-libsodium) rejections through the public
// `global.ErrorUtils.reportError` polyfill (which RN wires to
// `ExceptionsManager.handleException`); we install a stub ErrorUtils so those
// reports are observable here without dragging in the whole RN runtime.
const reportedToSink: unknown[] = [];

const g = globalThis as Record<string, unknown>;
const originalWebAssembly = g["WebAssembly"];
const originalHermesInternal = g["HermesInternal"];
const originalErrorUtils = g["ErrorUtils"];
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

// Holds the onUnhandled of whichever tracker was registered LAST. Mirrors the
// real Hermes contract: a single hook, last-call-wins. Our fake host's
// enablePromiseRejectionTracker just overwrites this slot.
let liveOnUnhandled: RejectionTrackerOptions["onUnhandled"];

// The exact rejection libsodium's abort() throws on the no-WebAssembly path with
// our stub installed (verified by running the real library — see header).
function makeRealLibsodiumRejection(): Error {
  const e = new Error(
    "Aborted(Error: WebAssembly is not available on this runtime). Build with -sASSERTIONS for more info.",
  );
  e.name = "WebAssembly.RuntimeError";
  return e;
}

describe("crypto-polyfill Hermes rejection swallow", () => {
  beforeAll(async () => {
    // Simulate Hermes: no native WebAssembly.
    delete (g as { WebAssembly?: unknown }).WebAssembly;

    // Stub the public `global.ErrorUtils.reportError` polyfill — the sink the
    // fixed polyfill routes genuine rejections through. On real RN this is wired
    // to `ExceptionsManager.handleException`; here it just records what it gets so
    // the delegation is observable. Must be installed BEFORE the polyfill import
    // so the tracker's onUnhandled closes over a present ErrorUtils.
    g["ErrorUtils"] = {
      reportError: (e: unknown) => {
        reportedToSink.push(e);
      },
    };

    // Model the REAL Hermes host object: `enablePromiseRejectionTracker` is a
    // NON-WRITABLE, NON-CONFIGURABLE property and the object is non-extensible.
    // If the polyfill ever tries to REASSIGN it (the old intercept fix did), the
    // import below throws `TypeError: Cannot assign to read-only property` and
    // this test fails — that is exactly the on-device crash we are guarding. The
    // CALLABLE function, however, is invocable: it overwrites the single live
    // tracker hook (last-call-wins), which is what the fix depends on.
    const hermesHost: Record<string, unknown> = {};
    Object.defineProperty(hermesHost, "hasPromise", {
      value: () => true,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    Object.defineProperty(hermesHost, "enablePromiseRejectionTracker", {
      value: (options: RejectionTrackerOptions) => {
        // Last-call-wins: replace the single live hook, as real Hermes does.
        liveOnUnhandled = options.onUnhandled;
      },
      writable: false,
      configurable: false,
      enumerable: true,
    });
    Object.preventExtensions(hermesHost);
    g["HermesInternal"] = hermesHost;

    // Stand in for RN/Expo's earlier registration: a tracker registered BEFORE
    // the polyfill, whose onUnhandled would report everything. The polyfill must
    // register AFTER this and win, so this hook must end up replaced.
    (
      hermesHost["enablePromiseRejectionTracker"] as (
        o: RejectionTrackerOptions,
      ) => void
    )({
      allRejections: true,
      onUnhandled: () => {
        throw new Error(
          "stale Expo tracker fired — polyfill did not register last",
        );
      },
      onHandled: () => {},
    });

    // Side-effectful import: installs console filter + WebAssembly stub, and
    // (the fix) re-registers the Hermes tracker LAST with the drop/delegate
    // onUnhandled. MUST NOT throw despite the frozen HermesInternal host object.
    await expect(
      import("./crypto-polyfill?hermes-rejection=tracker"),
    ).resolves.toBeDefined();
  });

  afterAll(() => {
    g["WebAssembly"] = originalWebAssembly;
    g["HermesInternal"] = originalHermesInternal;
    g["ErrorUtils"] = originalErrorUtils;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  test("predicate matches only the real libsodium init rejection", async () => {
    const { isLibsodiumInitRejection } = await import(
      "./crypto-polyfill?hermes-rejection=tracker"
    );
    // Exact match — swallowed.
    expect(isLibsodiumInitRejection(makeRealLibsodiumRejection())).toBe(true);
    // Genuine RuntimeError with a different message — NOT swallowed.
    const other = new Error("Aborted(out of memory). Build with -sASSERTIONS.");
    other.name = "WebAssembly.RuntimeError";
    expect(isLibsodiumInitRejection(other)).toBe(false);
    // Genuine app error — NOT swallowed.
    expect(isLibsodiumInitRejection(new Error("relay handshake failed"))).toBe(
      false,
    );
    // Non-Error reasons — NOT swallowed.
    expect(isLibsodiumInitRejection("some string")).toBe(false);
    expect(isLibsodiumInitRejection(undefined)).toBe(false);
  });

  test("import re-registered the tracker LAST (no read-only crash, won the slot)", () => {
    // The import resolved (asserted in beforeAll) AND replaced the live tracker
    // hook with the polyfill's onUnhandled — proving it CALLED (not reassigned)
    // the frozen enablePromiseRejectionTracker, and registered after the stale
    // "Expo" hook (which throws if it ever fires).
    expect(typeof liveOnUnhandled).toBe("function");
  });

  test("onUnhandled drops EXACTLY the libsodium init rejection (no report)", () => {
    if (!liveOnUnhandled) throw new Error("tracker not registered");
    reportedToSink.length = 0;
    // Hermes hands onUnhandled the RAW rejection reason (id, rejection).
    liveOnUnhandled(7, makeRealLibsodiumRejection());
    expect(reportedToSink).toHaveLength(0); // swallowed: nothing reached the sink
  });

  test("onUnhandled delegates every other rejection to the RN exception sink", () => {
    if (!liveOnUnhandled) throw new Error("tracker not registered");

    // A genuine app rejection — delegated to ExceptionsManager, NOT swallowed.
    reportedToSink.length = 0;
    liveOnUnhandled(1, new Error("relay handshake failed"));
    expect(reportedToSink).toHaveLength(1);
    {
      const reported = reportedToSink[0] as Error & { cause?: unknown };
      expect(reported).toBeInstanceOf(Error);
      // Wrapped the RN way: "Uncaught (in promise, id: N) ...", cause = reason.
      expect(reported.message).toContain("Uncaught (in promise, id: 1)");
      expect(reported.message).toContain("relay handshake failed");
      expect((reported.cause as Error)?.message).toBe("relay handshake failed");
    }

    // A genuine RuntimeError with a DIFFERENT message — delegated, not swallowed.
    reportedToSink.length = 0;
    const otherRuntime = new Error(
      "Aborted(out of memory). Build with -sASSERTIONS.",
    );
    otherRuntime.name = "WebAssembly.RuntimeError";
    liveOnUnhandled(2, otherRuntime);
    expect(reportedToSink).toHaveLength(1);
    expect((reportedToSink[0] as { cause?: unknown }).cause).toBe(otherRuntime);

    // A non-Error rejection reason — still delegated (stringified), not swallowed.
    reportedToSink.length = 0;
    liveOnUnhandled(3, "plain string rejection");
    expect(reportedToSink).toHaveLength(1);
    expect((reportedToSink[0] as Error).message).toContain(
      "plain string rejection",
    );
  });

  // Coverage scope (why there is no "load real libsodium and let it reject" test):
  //   * That crypto still WORKS through the wasm2js fallback — the entire reason we
  //     swallow the rejection rather than let init crash — is covered by the
  //     real-libsodium ECDH / XChaCha20 round-trips in
  //     `packages/protocol/src/crypto.test.ts` (which runs the same library and
  //     would fail if init were actually broken).
  //   * The escaping rejection's exact identity (name + message) is asserted above
  //     via `makeRealLibsodiumRejection()`, whose strings were lifted verbatim from
  //     running the real CJS libsodium with `WebAssembly` deleted (see header).
  //   A subprocess fixture (`Bun.spawnSync(["node", …])`) was tried to load real
  //   libsodium without bun-test failing on its raw rejection, but child stdout is
  //   suppressed under bun:test's macOS sandbox (same limitation noted for
  //   `apps/cli/src/commands/doctor.integration.test.ts`): even
  //   `node -e "process.stdout.write('x')"` returns empty. Modeling the
  //   tracker → ExceptionsManager sink directly, as the tests above do, is exactly
  //   what Hermes drives at runtime — and is sandbox-independent.
});
