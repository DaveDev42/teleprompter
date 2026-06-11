import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HookEventBase } from "@teleprompter/protocol";
import { rmRetry } from "@teleprompter/protocol/test-utils";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HookReceiver } from "./hook-receiver";

describe("HookReceiver", () => {
  let receiver: HookReceiver;
  let socketPath: string;
  let tmpDir: string;
  let receivedEvents: HookEventBase[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tp-hook-"));
    socketPath = join(tmpDir, "hook.sock");
    receivedEvents = [];
    receiver = new HookReceiver(socketPath, (event) => {
      receivedEvents.push(event);
    });
    receiver.start();
  });

  afterEach(async () => {
    receiver.stop();
    await rmRetry(tmpDir);
  });

  test("receives hook event via unix socket", async () => {
    const event = {
      session_id: "test-session",
      hook_event_name: "Stop",
      cwd: tmpdir(),
      last_assistant_message: "Done!",
    };

    // Connect and send event (mimics capture-hook behavior)
    const _conn = await Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(event));
          socket.end();
        },
        data() {},
        error() {},
      },
    });

    await Bun.sleep(100);
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]?.hook_event_name).toBe("Stop");
    expect(receivedEvents[0]?.["last_assistant_message"]).toBe("Done!");
  });

  test("receives multiple events from different connections", async () => {
    const names = ["SessionStart", "UserPromptSubmit", "Stop"];
    for (const name of names) {
      const event = {
        session_id: "test",
        hook_event_name: name,
        cwd: tmpdir(),
      };
      await Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.write(JSON.stringify(event));
            socket.end();
          },
          data() {},
          error() {},
        },
      });
    }

    await Bun.sleep(150);
    expect(receivedEvents.length).toBe(3);
    const received = receivedEvents.map((e) => e.hook_event_name as string);
    expect(received).toEqual(names);
  });

  test("drops a malformed hook event (parseHookEvent guard)", async () => {
    // An unknown hook_event_name and a missing session_id must both be
    // dropped at the boundary, then a well-formed event is accepted — proving
    // the guard filters without wedging the socket.
    const payloads = [
      { session_id: "s", hook_event_name: "NotARealHook", cwd: tmpdir() },
      { hook_event_name: "Stop", cwd: tmpdir() }, // missing session_id
      { session_id: "s", hook_event_name: "Stop", cwd: tmpdir() }, // valid
    ];
    for (const event of payloads) {
      await Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.write(JSON.stringify(event));
            socket.end();
          },
          data() {},
          error() {},
        },
      });
      await Bun.sleep(40);
    }

    await Bun.sleep(100);
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]?.hook_event_name).toBe("Stop");
  });

  test("defaultSocketPath generates valid path", () => {
    const path = HookReceiver.defaultSocketPath("my-session");
    expect(path).toContain("hook-my-session.sock");
  });

  test("accumulates fragmented payload across data chunks (idx 5)", async () => {
    // Simulate a large payload that arrives split across two Bun.write() calls.
    // The receiver must buffer both chunks before attempting JSON.parse.
    const event = {
      session_id: "frag-test",
      hook_event_name: "Stop",
      cwd: tmpdir(),
      last_assistant_message: "x".repeat(4096),
    };
    const payload = JSON.stringify(event);
    let fragReceived = false;

    const _conn = await Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          // Deliberately split at an arbitrary offset mid-payload.
          const mid = Math.floor(payload.length / 2);
          socket.write(payload.slice(0, mid));
          // Yield to let Bun flush the first chunk, then send the rest.
          setTimeout(() => {
            socket.write(payload.slice(mid));
            socket.end();
            fragReceived = true;
          }, 10);
        },
        data() {},
        error() {},
      },
    });

    // Allow both chunks + processing time.
    await Bun.sleep(200);
    expect(fragReceived).toBe(true);
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]?.hook_event_name).toBe("Stop");
    const msg = receivedEvents[0] as { last_assistant_message?: string };
    expect(msg.last_assistant_message).toHaveLength(4096);
  });

  test("stop() is idempotent — second call does not throw (idx 52)", () => {
    // After stop the socket file should be gone even if stop is called twice.
    receiver.stop();
    // Second stop must not throw (force:true covers already-removed path).
    expect(() => receiver.stop()).not.toThrow();
    // afterEach will call stop() a third time — also must not throw.
  });

  test("oversized non-JSON payload resets buffer and does not emit an event", async () => {
    // Send more than MAX_HOOK_BUF_BYTES (1 MB) of non-JSON garbage.
    // The receiver must drop the oversized partial and NOT emit any event.
    // It must also NOT grow memory unboundedly (the buffer is reset on overflow).
    const garbage = "x".repeat(1 * 1024 * 1024 + 1); // 1 MB + 1 byte

    await Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(garbage);
          socket.end();
        },
        data() {},
        error() {},
      },
    });

    await Bun.sleep(150);
    // No events must have been emitted.
    expect(receivedEvents.length).toBe(0);

    // After the overflow, a well-formed event on a new connection must still work.
    const goodEvent = {
      session_id: "after-overflow",
      hook_event_name: "Stop",
      cwd: tmpdir(),
    };
    await Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(goodEvent));
          socket.end();
        },
        data() {},
        error() {},
      },
    });

    await Bun.sleep(100);
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]?.hook_event_name).toBe("Stop");
  });
});
