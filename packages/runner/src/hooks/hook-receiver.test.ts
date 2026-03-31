import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HookEventBase } from "@teleprompter/protocol";
import { mkdtemp, rm } from "fs/promises";
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("receives hook event via unix socket", async () => {
    const event = {
      session_id: "test-session",
      hook_event_name: "Stop",
      cwd: "/tmp",
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
    expect(receivedEvents[0].last_assistant_message).toBe("Done!");
  });

  test("receives multiple events from different connections", async () => {
    for (let i = 0; i < 3; i++) {
      const event = {
        session_id: "test",
        hook_event_name: `Event${i}`,
        cwd: "/tmp",
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
    const names = receivedEvents.map((e) => e.hook_event_name as string);
    expect(names).toEqual(["Event0", "Event1", "Event2"]);
  });

  test("defaultSocketPath generates valid path", () => {
    const path = HookReceiver.defaultSocketPath("my-session");
    expect(path).toContain("hook-my-session.sock");
  });
});
