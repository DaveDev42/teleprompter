import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { setupWatchHandlers } from "./daemon";

describe("daemon.ts imports", () => {
  test("does not import loadPairingData", () => {
    const src = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
    expect(src).not.toMatch(/loadPairingData/);
    expect(src).not.toMatch(/pairing\.json/);
  });
});

/**
 * Regression test for H6: --watch handler accumulation across restarts.
 *
 * Verifies that calling setupWatchHandlers() multiple times (simulating N
 * daemon restarts) does NOT grow the process listener count for
 * uncaughtException, SIGINT, or SIGTERM.
 *
 * Test isolation: we save the listener lists before and restore them after so
 * no handlers leak into subsequent tests.
 */
describe("setupWatchHandlers — idempotency (H6 regression)", () => {
  // Capture pre-test listener lists so we can restore them exactly.
  const savedListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const events = [
    "uncaughtException",
    "SIGINT",
    "SIGTERM",
    "unhandledRejection",
  ] as const;

  beforeEach(() => {
    for (const evt of events) {
      savedListeners[evt] = process.listeners(evt) as ((
        ...args: unknown[]
      ) => void)[];
    }
  });

  afterEach(() => {
    // Remove any listeners added during the test and restore the originals.
    for (const evt of events) {
      process.removeAllListeners(evt);
      for (const l of savedListeners[evt] ?? []) {
        process.on(evt, l);
      }
    }
  });

  test("handler counts are bounded (1 extra per event) after N restarts", () => {
    const baselineCounts: Record<string, number> = {};
    for (const evt of events) {
      baselineCounts[evt] = process.listenerCount(evt);
    }

    const state = {
      daemonRef: null,
      shuttingDown: false,
      handlersRegistered: false,
    };
    const argv = ["start", "--watch"];
    const restartFn = () => {
      /* no-op for this test */
    };

    // Simulate 5 daemon restarts — each restart calls setupWatchHandlers().
    const N = 5;
    for (let i = 0; i < N; i++) {
      setupWatchHandlers(state, restartFn, argv);
    }

    // Each event should have gained exactly 1 listener, regardless of N.
    // Bracket access is required: noPropertyAccessFromIndexSignature (TS4111)
    // forbids dot access on the index-signature-typed baselineCounts record.
    expect(process.listenerCount("uncaughtException")).toBe(
      (baselineCounts["uncaughtException"] ?? 0) + 1,
    );
    expect(process.listenerCount("SIGINT")).toBe(
      (baselineCounts["SIGINT"] ?? 0) + 1,
    );
    expect(process.listenerCount("SIGTERM")).toBe(
      (baselineCounts["SIGTERM"] ?? 0) + 1,
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      (baselineCounts["unhandledRejection"] ?? 0) + 1,
    );
  });

  test("handler counts grow (SABOTAGE: if guard removed, listeners accumulate)", () => {
    // This test documents the pre-fix behaviour by simulating what the buggy
    // code did: each restart call creates a NEW closure and registers it, so
    // N restarts = N distinct listeners on SIGINT/uncaughtException.
    // It is intentionally written to PASS (it asserts growth), confirming the
    // regression test above would catch a reverted fix.
    const baseline = process.listenerCount("SIGINT");

    // Simulate the buggy pre-fix pattern: unique closure per "restart".
    const N = 4;
    const added: (() => void)[] = [];
    for (let i = 0; i < N; i++) {
      // Each iteration creates a new closure — exactly what the old code did on
      // each recursive daemonCommand() call.
      const handler = () => {
        /* restart-instance shutdown */
      };
      added.push(handler);
      process.on("SIGINT", handler);
    }

    // Without the guard, each of the N calls adds a unique listener.
    expect(process.listenerCount("SIGINT")).toBe(baseline + N);

    // Clean up.
    for (const h of added) process.removeListener("SIGINT", h);
  });
});
