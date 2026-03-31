import type { WsServerMessage } from "@teleprompter/protocol";
import type { ServerWebSocket } from "bun";

export interface WsClient {
  ws: ServerWebSocket<{ client: WsClient }>;
  id: number;
}

let nextId = 1;

export function createClient(
  ws: ServerWebSocket<{ client: WsClient }>,
): WsClient {
  return { ws, id: nextId++ };
}

export class ClientRegistry {
  private clients = new Set<WsClient>();
  private subscriptions = new Map<string, Set<WsClient>>();

  add(client: WsClient): void {
    this.clients.add(client);
  }

  remove(client: WsClient): void {
    this.clients.delete(client);
    // Remove from all subscriptions
    for (const [sid, subs] of this.subscriptions) {
      subs.delete(client);
      if (subs.size === 0) {
        this.subscriptions.delete(sid);
      }
    }
  }

  attach(client: WsClient, sid: string): void {
    let subs = this.subscriptions.get(sid);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(sid, subs);
    }
    subs.add(client);
  }

  detach(client: WsClient, sid: string): void {
    const subs = this.subscriptions.get(sid);
    if (!subs) return;
    subs.delete(client);
    if (subs.size === 0) {
      this.subscriptions.delete(sid);
    }
  }

  broadcast(sid: string, msg: WsServerMessage): void {
    const subs = this.subscriptions.get(sid);
    if (!subs) return;
    const json = JSON.stringify(msg);
    for (const client of subs) {
      client.ws.send(json);
    }
  }

  sendAll(msg: WsServerMessage): void {
    const json = JSON.stringify(msg);
    for (const client of this.clients) {
      client.ws.send(json);
    }
  }

  send(client: WsClient, msg: WsServerMessage): void {
    client.ws.send(JSON.stringify(msg));
  }

  get size(): number {
    return this.clients.size;
  }

  subscriberCount(sid: string): number {
    return this.subscriptions.get(sid)?.size ?? 0;
  }
}
