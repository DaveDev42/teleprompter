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
    expect(receivedEvents[0].hook_event_name).toBe("Stop");
    expect(receivedEvents[0]["last_assistant_message"]).toBe("Done!");
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
    expect(receivedEvents[0].hook_event_name).toBe("Stop");
  });

  test("defaultSocketPath generates valid path", () => {
    const path = HookReceiver.defaultSocketPath("my-session");
    expect(path).toContain("hook-my-session.sock");
  });
});
