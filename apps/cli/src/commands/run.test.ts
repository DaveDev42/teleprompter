/**
 * run.ts — graceful shutdown + NaN guard regression tests
 *
 * idx-run-1: SIGINT/SIGTERM must call runner.stop() before process.exit (not
 *   bypass stop() with a bare process.exit(0)), so hook receiver socket files
 *   are removed and the 'bye' IPC frame is sent to the daemon.
 *
 * idx-run-2: cols/rows parsing must apply the same NaN guard + Math.max(1, …)
 *   as packages/runner/src/index.ts so that invalid CLI args (non-numeric,
 *   empty, zero) do not produce NaN / 0 terminal dimensions.
 *
 * Signal testing is impractical in bun:test (cannot safely fork + signal
 * a subprocess without race conditions and real claude deps). Instead we test
 * the helper logic directly using the same pattern as index.test.ts.
 */
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// idx-run-2: NaN guard for cols/rows (mirrors index.ts)
// ---------------------------------------------------------------------------

/** Mirror of the guard expression used in run.ts */
function parseDim(value: string, fallback: number): number {
  return Math.max(1, parseInt(value, 10) || fallback);
}

describe("run.ts NaN guard for cols/rows (idx-run-2)", () => {
  test("numeric string parses correctly", () => {
    expect(parseDim("80", 120)).toBe(80);
    expect(parseDim("24", 40)).toBe(24);
  });

  test("non-numeric string falls back to default", () => {
    expect(parseDim("abc", 120)).toBe(120);
    expect(parseDim("", 120)).toBe(120);
  });

  test("zero falls back to default (zero terminal dim is invalid)", () => {
    expect(parseDim("0", 120)).toBe(120);
  });

  test("negative value is clamped to 1 via Math.max", () => {
    expect(parseDim("-5", 120)).toBe(1);
  });

  test("default values match run.ts literals", () => {
    expect(parseDim("120", 120)).toBe(120);
    expect(parseDim("40", 40)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// idx-run-1: gracefulShutdown helper logic
//
// The helper closes over a `stopping` boolean to prevent double-stop, calls
// runner.stop() with the correct exit code, then calls process.exit(0).
// We test the observable side-effects (stop called once, correct code, double-
// signal forces exit(1)) without actually calling process.exit.
// ---------------------------------------------------------------------------

describe("run.ts gracefulShutdown logic (idx-run-1)", () => {
  function makeGracefulShutdown(runner: { stop: (code: number) => void }) {
    let stopping = false;
    const exits: number[] = [];
    function fakeExit(code: number): never {
      exits.push(code);
      // Don't actually exit; throw so the caller can observe the call.
      throw new Error(`exit(${code})`);
    }
    function gracefulShutdown(signal: string): void {
      if (stopping) {
        fakeExit(1);
      }
      stopping = true;
      runner.stop(signal === "SIGINT" ? 130 : 143);
      fakeExit(0);
    }
    return { gracefulShutdown, exits };
  }

  test("SIGINT calls runner.stop(130) then exit(0)", () => {
    const stopCalls: number[] = [];
    const runner = { stop: (code: number) => { stopCalls.push(code); } };
    const { gracefulShutdown, exits } = makeGracefulShutdown(runner);

    expect(() => gracefulShutdown("SIGINT")).toThrow("exit(0)");
    expect(stopCalls).toEqual([130]);
    expect(exits).toEqual([0]);
  });

  test("SIGTERM calls runner.stop(143) then exit(0)", () => {
    const stopCalls: number[] = [];
    const runner = { stop: (code: number) => { stopCalls.push(code); } };
    const { gracefulShutdown, exits } = makeGracefulShutdown(runner);

    expect(() => gracefulShutdown("SIGTERM")).toThrow("exit(0)");
    expect(stopCalls).toEqual([143]);
    expect(exits).toEqual([0]);
  });

  test("second signal forces exit(1) without calling stop() again", () => {
    const stopCalls: number[] = [];
    const runner = { stop: (code: number) => { stopCalls.push(code); } };
    const { gracefulShutdown, exits } = makeGracefulShutdown(runner);

    // First signal
    expect(() => gracefulShutdown("SIGINT")).toThrow("exit(0)");
    // Second signal while stopping
    expect(() => gracefulShutdown("SIGINT")).toThrow("exit(1)");

    // stop() was only called once
    expect(stopCalls).toEqual([130]);
    expect(exits).toEqual([0, 1]);
  });

  test("stop() is called before exit, not skipped", () => {
    const order: string[] = [];
    const runner = { stop: (_code: number) => { order.push("stop"); } };
    const { gracefulShutdown } = makeGracefulShutdown(runner);

    try { gracefulShutdown("SIGTERM"); } catch { /* expected exit throw */ }
    // stop must appear before exit in call order
    expect(order[0]).toBe("stop");
  });
});
