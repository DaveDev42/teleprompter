import { describe, test, expect, beforeEach } from "bun:test";
import { ClientRegistry, type WsClient } from "./client-registry";

function mockClient(id: number): WsClient {
  const sent: string[] = [];
  return {
    id,
    ws: {
      send(data: string) {
        sent.push(data);
      },
      _sent: sent,
    } as unknown as WsClient["ws"],
  };
}

function getSent(client: WsClient): unknown[] {
  return ((client.ws as unknown as { _sent: string[] })._sent).map((s) => JSON.parse(s));
}

describe("ClientRegistry", () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    registry = new ClientRegistry();
  });

  test("add and remove clients", () => {
    const c1 = mockClient(1);
    const c2 = mockClient(2);

    registry.add(c1);
    registry.add(c2);
    expect(registry.size).toBe(2);

    registry.remove(c1);
    expect(registry.size).toBe(1);
  });

  test("attach and broadcast to subscribed clients", () => {
    const c1 = mockClient(1);
    const c2 = mockClient(2);
    const c3 = mockClient(3);

    registry.add(c1);
    registry.add(c2);
    registry.add(c3);

    registry.attach(c1, "session-1");
    registry.attach(c2, "session-1");
    registry.attach(c3, "session-2");

    registry.broadcast("session-1", { t: "pong" });

    expect(getSent(c1)).toEqual([{ t: "pong" }]);
    expect(getSent(c2)).toEqual([{ t: "pong" }]);
    expect(getSent(c3)).toEqual([]); // not subscribed to session-1
  });

  test("detach stops broadcasts to client", () => {
    const c1 = mockClient(1);
    registry.add(c1);
    registry.attach(c1, "s1");

    registry.broadcast("s1", { t: "pong" });
    expect(getSent(c1)).toHaveLength(1);

    registry.detach(c1, "s1");
    registry.broadcast("s1", { t: "pong" });
    expect(getSent(c1)).toHaveLength(1); // no new messages
  });

  test("remove cleans up all subscriptions", () => {
    const c1 = mockClient(1);
    registry.add(c1);
    registry.attach(c1, "s1");
    registry.attach(c1, "s2");

    registry.remove(c1);
    expect(registry.subscriberCount("s1")).toBe(0);
    expect(registry.subscriberCount("s2")).toBe(0);
  });

  test("sendAll sends to all connected clients", () => {
    const c1 = mockClient(1);
    const c2 = mockClient(2);
    registry.add(c1);
    registry.add(c2);

    registry.sendAll({ t: "pong" });

    expect(getSent(c1)).toEqual([{ t: "pong" }]);
    expect(getSent(c2)).toEqual([{ t: "pong" }]);
  });

  test("send sends to specific client", () => {
    const c1 = mockClient(1);
    const c2 = mockClient(2);
    registry.add(c1);
    registry.add(c2);

    registry.send(c1, { t: "pong" });

    expect(getSent(c1)).toEqual([{ t: "pong" }]);
    expect(getSent(c2)).toEqual([]);
  });

  test("broadcast to non-existent sid is noop", () => {
    const c1 = mockClient(1);
    registry.add(c1);
    registry.broadcast("nonexistent", { t: "pong" });
    expect(getSent(c1)).toEqual([]);
  });

  test("subscriberCount returns correct count", () => {
    const c1 = mockClient(1);
    const c2 = mockClient(2);
    registry.add(c1);
    registry.add(c2);

    expect(registry.subscriberCount("s1")).toBe(0);

    registry.attach(c1, "s1");
    expect(registry.subscriberCount("s1")).toBe(1);

    registry.attach(c2, "s1");
    expect(registry.subscriberCount("s1")).toBe(2);
  });
});
