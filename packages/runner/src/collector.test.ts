import { describe, expect, test } from "bun:test";
import { Collector } from "./collector";

describe("Collector", () => {
  const collector = new Collector("test-session");

  test("ioRecord creates io record with base64 payload", () => {
    const data = new TextEncoder().encode("Hello, World!");
    const rec = collector.ioRecord(data);

    expect(rec.t).toBe("rec");
    expect(rec.sid).toBe("test-session");
    expect(rec.kind).toBe("io");
    expect(rec.ts).toBeGreaterThan(0);

    const decoded = Buffer.from(rec.payload, "base64").toString();
    expect(decoded).toBe("Hello, World!");
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

  test("ioRecord handles binary data with null bytes", () => {
    const data = new Uint8Array([0, 1, 2, 255, 0, 128]);
    const rec = collector.ioRecord(data);
    const decoded = Buffer.from(rec.payload, "base64");
    expect(new Uint8Array(decoded)).toEqual(data);
  });

  test("each record has a unique timestamp", async () => {
    const rec1 = collector.ioRecord(new Uint8Array([1]));
    await Bun.sleep(2);
    const rec2 = collector.ioRecord(new Uint8Array([2]));
    expect(rec2.ts).toBeGreaterThanOrEqual(rec1.ts);
  });
});
