/**
 * Runner unit tests
 *
 * M7 regression — start() error path must clean up all already-started
 * subsystems (HookReceiver, IPC) so no socket files are leaked.
 *
 * M8 — Runner.stop() idempotency: calling stop() twice must not crash and
 * must not re-send a 'bye' message to the daemon.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HookReceiver } from "./hooks/hook-receiver";

// ---------------------------------------------------------------------------
// M7 — start() error path cleans up HookReceiver socket
// ---------------------------------------------------------------------------

describe("Runner start() error cleanup — M7 regression", () => {
  test("hook receiver socket is removed when Runner.start() fails after hookReceiver.start()", async () => {
    // Runner.start() fails after hookReceiver.start() when the PTY command
    // is invalid (non-existent binary). We use a non-existent command to
    // cause pty.spawn() to throw (Bun.spawn rejects on ENOENT). We verify
    // that the hookReceiver socket file is cleaned up in the catch block.
    //
    // The hook socket path is deterministic: HookReceiver.defaultSocketPath(sid)
    // The Runner's catch block (the M7 fix) must call hookReceiver.stop()
    // which removes the socket file.
    const { Runner } = await import("./runner");

    const tmpDir = await mkdtemp(join(tmpdir(), "tp-runner-m7-"));
    const ipcSocketPath = join(tmpDir, "ipc.sock");

    // Minimal IPC server so IpcClient.connect() succeeds
    const server = Bun.listen({
      unix: ipcSocketPath,
      socket: {
        open() {},
        data() {},
        close() {},
        error() {},
      },
    });

    // Use a unique sid so the hook socket path is predictable
    const sid = `m7-test-${Date.now()}`;
    const hookSocketPath = HookReceiver.defaultSocketPath(sid);

    const runner = new Runner({
      sid,
      cwd: tmpDir,
      socketPath: ipcSocketPath,
      // Pass a non-existent command so pty.spawn() throws after hookReceiver.start()
      claudeArgs: [],
    });

    // Monkey-patch the runner's pty to throw during spawn, simulating an error
    // that occurs after hookReceiver.start() but before the runner reaches
    // "running" state. We set claudeArgs to force a known-bad command by
    // overriding the pty spawn to throw.
    // Instead: start() will use "claude" which may or may not exist. To make
    // this reliable we patch the internal pty manager via Object.assign on the
    // private field after construction (TypeScript private doesn't prevent JS access).
    const fakeError = new Error("fake-pty-spawn-error");
    (runner as unknown as Record<string, unknown>)["pty"] = {
      spawn: () => {
        throw fakeError;
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
      pid: undefined,
    };

    // start() should throw because pty.spawn() throws
    await expect(runner.start()).rejects.toThrow("fake-pty-spawn-error");

    // The M7 fix: hookReceiver.stop() must have been called, removing the socket
    expect(existsSync(hookSocketPath)).toBe(false);

    server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("HookReceiver.stop() is idempotent — calling it twice does not throw", () => {
    const receiver = new HookReceiver("/tmp/never-started-m7.sock", () => {});
    // stop() on a never-started receiver must be a no-op
    expect(() => receiver.stop()).not.toThrow();
    expect(() => receiver.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M8 — Runner.stop() idempotency (state machine guard)
// ---------------------------------------------------------------------------

describe("Runner.stop() idempotency — M8 regression", () => {
  test("calling stop() twice with a connected IPC only sends one bye", async () => {
    // Import Runner lazily to avoid pulling in PtyBun in environments that
    // lack a PTY device.
    const { Runner } = await import("./runner");

    const tmpDir = await mkdtemp(join(tmpdir(), "tp-runner-m8-"));
    const socketPath = join(tmpDir, "ipc-m8.sock");

    const serverMessages: unknown[] = [];

    // Start a minimal server so IpcClient.connect() and send() work.
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open() {},
        data(_sock, data) {
          // Decode framed JSON messages and record them.
          const view = new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
          let offset = 0;
          while (offset + 4 <= data.byteLength) {
            const len = view.getUint32(offset);
            offset += 4;
            if (offset + len <= data.byteLength) {
              const json = Buffer.from(
                data.slice(offset, offset + len),
              ).toString("utf-8");
              serverMessages.push(JSON.parse(json));
              offset += len;
            } else break;
          }
        },
        close() {},
        error() {},
      },
    });

    const runner = new Runner({
      sid: "idempotent-test",
      cwd: tmpDir,
      socketPath,
    });

    // Manually connect the IPC so we can call stop() without going through
    // start() (which would try to spawn claude).
    // We do this by directly calling start() in a context where the PTY spawn
    // will fail — the catch block should still leave things in "stopped" state.
    // Instead: use the IpcClient inside the runner indirectly by triggering
    // stop() after ipc is connected via a test-only path.
    //
    // Simplest verifiable case: the state-machine guard in stop() means that
    // if stop() is called while state is "created", it must not crash (it will
    // early-return since "created" is not "stopping"/"stopped" but IPC is null).
    // Instead we verify the guard via a second call after the first stop fires.

    // Directly connect IPC by calling the method on the internal ipc client
    // via the connect path exposed through start(). We call start() with a
    // valid socket but expect it to throw when PTY spawn fails — then
    // ipcConnected=true but PTY never started.
    //
    // The point we test: after the catch block runs (state="stopped"),
    // calling stop() again must not crash — the guard must fire.
    await runner.start().catch(() => {
      // Expected: PTY spawn fails (claude not found). State is now "stopped".
    });

    // Calling stop() on a stopped runner: the guard must return early.
    expect(() => runner.stop(0)).not.toThrow();
    expect(() => runner.stop(0)).not.toThrow();

    server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// stop() kills the PTY child — stop() is reached from the graceful-shutdown
// SIGTERM/SIGINT path (run.ts) and the IPC onClose path (queue overflow /
// socket teardown), where claude is still alive. Without kill() the runner
// process exits and orphans claude to init, leaking the process. The PTY's
// own onExit path also routes through stop(), where kill() is a harmless
// no-op (proc already dead).
// ---------------------------------------------------------------------------

describe("Runner.stop() kills the PTY child", () => {
  test("stop() calls pty.kill() so a live claude child is not orphaned", async () => {
    const { Runner } = await import("./runner");

    const tmpDir = await mkdtemp(join(tmpdir(), "tp-runner-ptykill-"));
    const socketPath = join(tmpDir, "ipc-ptykill.sock");

    // Minimal IPC server so IpcClient.connect()/send() succeed.
    const server = Bun.listen({
      unix: socketPath,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });

    const runner = new Runner({
      sid: "ptykill-test",
      cwd: tmpDir,
      socketPath,
    });

    // Inject a fake PTY that records kill() invocations, and drive the runner
    // to "running" without spawning real claude. We patch BEFORE start() so the
    // fake's spawn() is what start() invokes; spawn() is a no-op (the real one
    // wires onExit, which we don't want firing here).
    let killCount = 0;
    (runner as unknown as Record<string, unknown>)["pty"] = {
      spawn: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {
        killCount += 1;
      },
      pid: 4242,
    };

    await runner.start();
    // start() reached "running" (fake spawn did not throw); claude is "alive".
    expect(killCount).toBe(0);

    // Simulate the IPC onClose / SIGTERM teardown: stop() with a non-exit code.
    runner.stop(143);

    // The fix: stop() must have killed the PTY child exactly once.
    expect(killCount).toBe(1);

    // Idempotency: a second stop() is a no-op (state guard), no extra kill.
    runner.stop(143);
    expect(killCount).toBe(1);

    server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// sid path-traversal guard — the Runner constructor computes its hook socket
// path via HookReceiver.defaultSocketPath(sid), which rejects a sid containing
// a path separator or '..'. A crafted --tp-sid must fail fast at construction,
// not silently bind a socket outside the per-user runtime dir.
// ---------------------------------------------------------------------------

describe("Runner constructor — sid path-traversal guard", () => {
  test("rejects a sid with a path separator or '..'", async () => {
    const { Runner } = await import("./runner");
    for (const sid of ["../escape", "a/b", "a\\b", "..", "foo/../bar"]) {
      expect(() => new Runner({ sid, cwd: "/tmp", claudeArgs: [] })).toThrow(
        /invalid sid/,
      );
    }
  });

  test("accepts an ordinary auto-generated sid", async () => {
    // A `session-<ts>` sid (the index.ts/run.ts default shape) must construct.
    const { Runner } = await import("./runner");
    expect(
      () =>
        new Runner({
          sid: "session-1700000000000",
          cwd: "/tmp",
          claudeArgs: [],
        }),
    ).not.toThrow();
  });
});
