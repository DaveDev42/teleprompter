import { describe, expect, test } from "bun:test";
import { Collector } from "./collector";

describe("Collector", () => {
  const collector = new Collector("test-session");

  test("ioRecord returns the bytes as a binary sidecar (no base64)", () => {
    const data = new TextEncoder().encode("Hello, World!");
    const io = collector.ioRecord(data);

    expect(io.msg.t).toBe("rec");
    expect(io.msg.sid).toBe("test-session");
    expect(io.msg.kind).toBe("io");
    expect(io.msg.ts).toBeGreaterThan(0);
    // Payload stays empty — the bytes ride as the frame's binary sidecar.
    expect(io.msg.payload).toBe("");
    expect(new TextDecoder().decode(io.binary)).toBe("Hello, World!");
  });

  test("eventRecord creates event record from hook event", () => {
    const event = {
      session_id: "test",
      hook_event_name: "Stop" as const,
      cwd: "/tmp",
      last_assistant_message: "Done!",
    };
    const rec = collector.eventRecord(event);

    expect(rec.t).toBe("rec");
    expect(rec.sid).toBe("test-session");
    expect(rec.kind).toBe("event");
    expect(rec.ns).toBe("claude");
    expect(rec.name).toBe("Stop");

    const decoded = JSON.parse(Buffer.from(rec.payload, "base64").toString());
    expect(decoded.hook_event_name).toBe("Stop");
    expect(decoded.last_assistant_message).toBe("Done!");
  });

  test("metaRecord creates meta record with runner namespace", () => {
    const rec = collector.metaRecord("started", { pid: 1234 });

    expect(rec.t).toBe("rec");
    expect(rec.sid).toBe("test-session");
    expect(rec.kind).toBe("meta");
    expect(rec.ns).toBe("runner");
    expect(rec.name).toBe("started");

    const decoded = JSON.parse(Buffer.from(rec.payload, "base64").toString());
    expect(decoded.pid).toBe(1234);
  });

  test("ioRecord preserves null bytes and high bytes verbatim", () => {
    const data = new Uint8Array([0, 1, 2, 255, 0, 128]);
    const io = collector.ioRecord(data);
    expect(Array.from(io.binary)).toEqual(Array.from(data));
  });

  test("each io record has a unique timestamp", async () => {
    const a = collector.ioRecord(new Uint8Array([1]));
    await Bun.sleep(2);
    const b = collector.ioRecord(new Uint8Array([2]));
    expect(b.msg.ts).toBeGreaterThanOrEqual(a.msg.ts);
  });
});
