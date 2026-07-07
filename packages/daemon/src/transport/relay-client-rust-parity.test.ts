/**
 * Differential reconnect-policy parity gate (ADR-0003 Phase 4, daemon inc3).
 *
 * The daemon-side relay client carries a reconnect/backoff state machine whose
 * load-bearing pure core is `computeReconnectPlan(attempt, peerlessReconnects)`
 * and `nextPeerlessReconnects(current, hadPeer)` (relay-client.ts:95,122). These
 * two functions encode the dead-pairing throttle — the property that stopped a
 * pile of dead pairings from storming the relay (the observed 9-pairing → 3113
 * re-auths-in-41h incident). During the dual-run window a Bun daemon and a Rust
 * `tp-daemon` may each reconnect their own pairings; if their backoff curve or
 * throttle threshold diverges by one step, one impl storms the relay while the
 * other paces itself.
 *
 * Unlike the store gate (a SHARED on-disk file both impls co-read/write), the
 * reconnect plan is PURE arithmetic — so this is a DIFFERENTIAL FUNCTION gate:
 * drive the SAME (attempt, peerlessReconnects) / (current, hadPeer) table through
 * the Bun `computeReconnectPlan` / `nextPeerlessReconnects` AND the Rust port
 * (via `tp-daemon-probe`), and assert the outputs are byte-identical across a
 * grid that exercises every branch:
 *   - exponential backoff `1000 * 2^attempt` for attempt 0..MAX
 *   - the `RECONNECT_MAX_MS` (30s) cap and the `MAX_RECONNECT_ATTEMPT` clamp
 *   - the dead-pairing throttle (peerless >= 3 → 30min, attempt UNCHANGED)
 *   - the throttle taking priority over the backoff branch even at attempt 0
 *   - the peerless counter arm (no peer → +1) and reset (had peer → 0)
 *
 * The Rust side is driven through the same `tp-daemon-probe` binary the store /
 * worktree gates use, via two verbs (see PROBE CONTRACT below). Degrades by SKIP
 * (not FAIL) when the probe binary has not been built — build it with
 * `(cd rust && cargo build --bin tp-daemon-probe)`. Mirrors the store /
 * worktree / runner-parity SKIP-when-unbuilt precedent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBE CONTRACT (tp-daemon-probe <verb> [args...])
 *   reconnect-plan <attempt> <peerlessReconnects> → stdout: JSON {delayMs, nextAttempt}
 *   peerless-next  <current> <hadPeer:0|1>        → stdout: JSON {value}
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { computeReconnectPlan, nextPeerlessReconnects } from "./relay-client";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

/** Prefer the release binary; fall back to debug. Returns null if neither built. */
function findProbe(): string | null {
  for (const profile of ["release", "debug"]) {
    const p = join(REPO_ROOT, "rust", "target", profile, "tp-daemon-probe");
    if (existsSync(p)) return p;
  }
  return null;
}

const probeBin = findProbe();

/** Drive the Rust probe; parse its canonical-JSON stdout into shape `T`. */
function probe<T>(args: string[]): T {
  const r = spawnSync(probeBin as string, args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`probe ${args.join(" ")} failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as T;
}

/** `reconnect-plan` verb → the Rust `ReconnectPlan` (delayMs/nextAttempt). */
function rustPlan(
  attempt: number,
  peerless: number,
): { delayMs: number; nextAttempt: number } {
  return probe(["reconnect-plan", String(attempt), String(peerless)]);
}

/** `peerless-next` verb → the next throttle counter value. */
function rustPeerlessNext(current: number, hadPeer: boolean): number {
  return probe<{ value: number }>([
    "peerless-next",
    String(current),
    hadPeer ? "1" : "0",
  ]).value;
}

const maybe = probeBin ? describe : describe.skip;

maybe("relay-client reconnect-policy Bun↔Rust differential parity", () => {
  test("computeReconnectPlan matches across the full (attempt × peerless) grid", () => {
    // attempt 0..8 covers the ramp, the 30s cap, and the MAX_RECONNECT_ATTEMPT
    // clamp; peerless 0..5 covers below-threshold and the throttle (>=3).
    for (let attempt = 0; attempt <= 8; attempt++) {
      for (let peerless = 0; peerless <= 5; peerless++) {
        const bun = computeReconnectPlan(attempt, peerless);
        const rust = rustPlan(attempt, peerless);
        expect({
          attempt,
          peerless,
          delayMs: rust.delayMs,
          nextAttempt: rust.nextAttempt,
        }).toEqual({
          attempt,
          peerless,
          delayMs: bun.delay,
          nextAttempt: bun.nextAttempt,
        });
      }
    }
  });

  test("throttle branch: peerless >= 3 pins 30min and leaves attempt unchanged (both impls)", () => {
    // Spot-check the load-bearing throttle invariant explicitly (the grid above
    // already covers it, but assert the exact values so a regression names it).
    for (const attempt of [0, 1, 5]) {
      const bun = computeReconnectPlan(attempt, 3);
      const rust = rustPlan(attempt, 3);
      expect(bun.delay).toBe(30 * 60_000);
      expect(bun.nextAttempt).toBe(attempt); // unchanged — recovered pairing resumes fast
      expect(rust.delayMs).toBe(bun.delay);
      expect(rust.nextAttempt).toBe(bun.nextAttempt);
    }
  });

  test("nextPeerlessReconnects arms (no peer → +1) and resets (had peer → 0) identically", () => {
    for (const current of [0, 1, 2, 3, 4]) {
      // no peer this connection → increment
      const bunInc = nextPeerlessReconnects(current, false);
      expect(rustPeerlessNext(current, false)).toBe(bunInc);
      expect(bunInc).toBe(current + 1);

      // a peer joined → reset to 0
      const bunReset = nextPeerlessReconnects(current, true);
      expect(rustPeerlessNext(current, true)).toBe(bunReset);
      expect(bunReset).toBe(0);
    }
  });
});
