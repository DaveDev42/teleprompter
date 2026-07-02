/**
 * Fix #1 regression — a Runner that dies WITHOUT sending a clean "bye"
 * (crash, OOM-kill, `kill -9`) is reconciled by `SessionManager`'s
 * `onRunnerExit` callback (wired in `Daemon`'s constructor), which flips the
 * store row to "stopped". Before this fix that callback updated the store
 * but never notified relay — so a subscribed frontend never learned the
 * session died, leaving the app's "Claude is responding…" / busy state
 * hanging forever (until an unrelated manual refetch).
 *
 * This test drives the real crash path end-to-end: a real (short-lived)
 * subprocess registered via `SessionManager.setRunnerCommand`, which exits on
 * its own with no bye frame ever sent, and asserts the daemon broadcasts the
 * resulting "stopped" state to relay via `RelayClient.publishState`.
 *
 * Source-only revert of the `this.dispatcher.broadcastSessionState(sid)` call
 * in `daemon.ts`'s `setOnRunnerExit` callback must fail this test (the store
 * still updates to "stopped", but `publishState` is never called).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStateMsg } from "@teleprompter/protocol";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "./daemon";
import { SessionManager } from "./session/session-manager";
import { rmRetry } from "./store/test-helpers";
import type { RelayClient } from "./transport/relay-client";

// Exits immediately with no IPC connection at all — the daemon never
// receives a "hello" or a "bye" for this sid, exactly modeling a Runner that
// crashes before (or without) completing its handshake.
const CRASH_CMD = [process.execPath, "--version"];

describe("Daemon runner-exit crash path broadcasts session state", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmRetry(dir);
  });

  test("a Runner exit with no bye still reaches RelayClient.publishState", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-exit-broadcast-"));
    const daemon = new Daemon(dir);
    daemon.start(join(dir, "daemon.sock"));

    const publishedStates: SessionStateMsg[] = [];
    const fakeRelay = {
      publishState: async (_sid: string, msg: SessionStateMsg) => {
        publishedStates.push(msg);
      },
      dispose: () => {},
    } as unknown as RelayClient;

    // Register a connected relay client directly in the pool — bypasses the
    // real pairing/kx handshake, which is orthogonal to this fix.
    (
      daemon as unknown as {
        relayManager: { registerClient: (c: RelayClient) => void };
      }
    ).relayManager.registerClient(fakeRelay);

    const sid = "crash-broadcast-sid";
    SessionManager.setRunnerCommand(CRASH_CMD);
    // Seed the store row as "running" (mirrors what a real hello would have
    // done) and spawn the process directly via the SessionManager the daemon
    // already owns, so `proc.exited` drives the daemon's real
    // `setOnRunnerExit` wiring — not a hand-rolled stand-in.
    (
      daemon as unknown as {
        store: {
          createSession: (sid: string, cwd: string) => unknown;
        };
      }
    ).store.createSession(sid, dir);
    (
      daemon as unknown as {
        sessionManager: SessionManager;
      }
    ).sessionManager.spawnRunner(sid, dir);

    // Wait for the subprocess to exit and the onRunnerExit callback to run
    // (proc.exited resolution + the handler's microtask).
    await Bun.sleep(300);

    const meta = (
      daemon as unknown as {
        store: { getSession: (sid: string) => { state: string } | undefined };
      }
    ).store.getSession(sid);
    expect(meta?.state).toBe("stopped");

    // The critical assertion: relay was actually notified, not just the
    // store. Before the fix, `publishedStates` stays empty even though the
    // store row above correctly reads "stopped".
    expect(publishedStates.length).toBeGreaterThan(0);
    expect(publishedStates[0]?.sid).toBe(sid);
    expect(publishedStates[0]?.d.state).toBe("stopped");

    daemon.stop();
  });
});
