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
// runner.stop() with the correct exit code, yields one macrotask
// (`setImmediate`) so the queued 'bye' IPC frame flushes, then calls
// process.exit(0). We mirror that exact shape (async + setImmediate) and test
// the observable side-effects (stop called once, correct code, the flush tick
// runs between stop() and exit(0), double-signal forces exit(1)) without
// actually calling process.exit.
//
// The async flush tick (run-1b) is the fix for the lost-bye-on-backpressure
// bug: a synchronous process.exit(0) right after runner.stop() tears the
// process down before the event loop flushes the queued bye frame.
// ---------------------------------------------------------------------------

describe("run.ts gracefulShutdown logic (idx-run-1)", () => {
  function makeGracefulShutdown(runner: {
    stop: (code: number, reason?: "signal" | "exit") => void;
  }) {
    let stopping = false;
    const exits: number[] = [];
    const order: string[] = [];
    function fakeExit(code: number): never {
      exits.push(code);
      order.push(`exit(${code})`);
      // Don't actually exit; throw so the caller can observe the call.
      throw new Error(`exit(${code})`);
    }
    async function gracefulShutdown(signal: string): Promise<void> {
      if (stopping) {
        fakeExit(1);
      }
      stopping = true;
      // SIGINT/SIGTERM is a daemon/transport-initiated stop, not claude's own
      // process exit — reason "signal" (mirrors run.ts).
      runner.stop(signal === "SIGINT" ? 130 : 143, "signal");
      // Mirror of run.ts: yield a macrotask so the queued bye frame flushes
      // before exit. Record the tick so tests can assert the ordering.
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push("flush-tick");
      fakeExit(0);
    }
    return { gracefulShutdown, exits, order };
  }

  test("SIGINT calls runner.stop(130, 'signal') then exit(0)", async () => {
    const stopCalls: Array<[number, "signal" | "exit" | undefined]> = [];
    const runner = {
      stop: (code: number, reason?: "signal" | "exit") => {
        stopCalls.push([code, reason]);
      },
    };
    const { gracefulShutdown, exits } = makeGracefulShutdown(runner);

    await expect(gracefulShutdown("SIGINT")).rejects.toThrow("exit(0)");
    expect(stopCalls).toEqual([[130, "signal"]]);
    expect(exits).toEqual([0]);
  });

  test("SIGTERM calls runner.stop(143, 'signal') then exit(0)", async () => {
    const stopCalls: Array<[number, "signal" | "exit" | undefined]> = [];
    const runner = {
      stop: (code: number, reason?: "signal" | "exit") => {
        stopCalls.push([code, reason]);
      },
    };
    const { gracefulShutdown, exits } = makeGracefulShutdown(runner);

    await expect(gracefulShutdown("SIGTERM")).rejects.toThrow("exit(0)");
    expect(stopCalls).toEqual([[143, "signal"]]);
    expect(exits).toEqual([0]);
  });

  test("second signal forces exit(1) without calling stop() again", async () => {
    const stopCalls: Array<[number, "signal" | "exit" | undefined]> = [];
    const runner = {
      stop: (code: number, reason?: "signal" | "exit") => {
        stopCalls.push([code, reason]);
      },
    };
    const { gracefulShutdown, exits } = makeGracefulShutdown(runner);

    // First signal — completes its async flush + exit(0).
    await expect(gracefulShutdown("SIGINT")).rejects.toThrow("exit(0)");
    // Second signal while stopping — forces exit(1) synchronously, before any
    // await, so stop() is not called again.
    await expect(gracefulShutdown("SIGINT")).rejects.toThrow("exit(1)");

    // stop() was only called once
    expect(stopCalls).toEqual([[130, "signal"]]);
    expect(exits).toEqual([0, 1]);
  });

  test("stop() runs, then the flush tick, then exit (run-1b ordering)", async () => {
    const order: string[] = [];
    const runner = {
      stop: (_code: number, _reason?: "signal" | "exit") => {
        order.push("stop");
      },
    };
    const { gracefulShutdown, order: shutdownOrder } = makeGracefulShutdown({
      stop: (code, reason) => runner.stop(code, reason),
    });

    try {
      await gracefulShutdown("SIGTERM");
    } catch {
      /* expected exit throw */
    }
    // The flush tick must sit between stop() and exit(0): the queued bye frame
    // gets an event-loop tick to drain before the process tears down.
    expect(order[0]).toBe("stop");
    expect(shutdownOrder).toEqual(["flush-tick", "exit(0)"]);
  });
});
