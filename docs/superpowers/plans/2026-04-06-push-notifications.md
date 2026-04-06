# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send Expo push notifications (or in-app toasts) when Claude waits for user input (`Elicitation`, `PermissionRequest`), with relay-side delivery routing, rate limiting, and dedup.

**Architecture:** Protocol types extended with `pushToken`, `relay.push`, `relay.notification` messages. Daemon detects hook events and sends `relay.push` to relay. Relay checks frontend WS connectivity — sends WS notification (toast) if connected, Expo Push API if not. Frontend registers push token on startup and handles both push and toast navigation.

**Tech Stack:** TypeScript, Bun, expo-notifications, Expo Push API, Zustand

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/protocol/src/types/relay.ts` | Modify | Add `RelayPush`, `RelayNotification` types |
| `packages/protocol/src/types/ws.ts` | Modify | Add `WsPushToken` type |
| `packages/protocol/src/types/envelope.ts` | Modify | Add `"pushToken"` to `FrameType` |
| `packages/protocol/src/types/index.ts` | Modify | Re-export new types |
| `packages/relay/src/push.ts` | Create | Expo Push API client + rate limiter + dedup |
| `packages/relay/src/push.test.ts` | Create | Tests for push module |
| `packages/relay/src/relay-server.ts` | Modify | Handle `relay.push` message |
| `packages/relay/src/relay-server.test.ts` | Modify | Tests for `relay.push` handling |
| `packages/daemon/src/push/push-notifier.ts` | Create | Hook event detection + relay.push dispatch |
| `packages/daemon/src/push/push-notifier.test.ts` | Create | Tests for push notifier |
| `packages/daemon/src/daemon.ts` | Modify | Wire push notifier into handleRec + pushToken handling |
| `packages/daemon/src/transport/relay-client.ts` | Modify | Add `sendPush()` method |
| `apps/app/package.json` | Modify | Add `expo-notifications` |
| `apps/app/app.json` | Modify | Add `expo-notifications` plugin |
| `apps/app/src/hooks/use-push-notifications.ts` | Create | Push token registration + notification handling |
| `apps/app/src/components/InAppToast.tsx` | Create | Toast UI component |
| `apps/app/src/hooks/use-relay.ts` | Modify | Handle `relay.notification` → toast |
| `apps/app/app/_layout.tsx` | Modify | Wire push notifications hook + toast |
| `TODO.md` | Modify | Mark push notification item done |
| `CLAUDE.md` | Modify | Update test list + architecture notes |

---

### Task 1: Protocol types — relay.push and relay.notification

**Files:**
- Modify: `packages/protocol/src/types/relay.ts`
- Modify: `packages/protocol/src/types/index.ts`

- [ ] **Step 1: Add RelayPush and RelayNotification types to relay.ts**

Add before the `RelayClientMessage` union type:

```typescript
export interface RelayPush {
  t: "relay.push";
  /** Target frontend */
  frontendId: string;
  /** Expo push token */
  token: string;
  /** Notification title */
  title: string;
  /** Notification body */
  body: string;
  /** Navigation payload */
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}
```

Add `RelayPush` to the `RelayClientMessage` union:
```typescript
export type RelayClientMessage =
  | RelayAuth
  | RelayRegister
  | RelayKeyExchange
  | RelayPublish
  | RelaySubscribe
  | RelayUnsubscribe
  | RelayPing
  | RelayPush;
```

Add before the `RelayServerMessage` union type:

```typescript
export interface RelayNotification {
  t: "relay.notification";
  title: string;
  body: string;
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}
```

Add `RelayNotification` to the `RelayServerMessage` union:
```typescript
export type RelayServerMessage =
  | RelayAuthOk
  | RelayAuthErr
  | RelayRegisterOk
  | RelayRegisterErr
  | RelayFrame
  | RelayKeyExchangeFrame
  | RelayPresence
  | RelayPong
  | RelayError
  | RelayNotification;
```

- [ ] **Step 2: Re-export new types from index.ts**

Add `RelayPush` and `RelayNotification` to the relay re-exports in `packages/protocol/src/types/index.ts`:

```typescript
export type {
  // ... existing exports ...
  RelayPush,
  RelayNotification,
} from "./relay";
```

- [ ] **Step 3: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS (no consumers yet, just new types)

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/types/relay.ts packages/protocol/src/types/index.ts
git commit -m "feat(protocol): add RelayPush and RelayNotification types"
```

---

### Task 2: Protocol types — WsPushToken

**Files:**
- Modify: `packages/protocol/src/types/ws.ts`
- Modify: `packages/protocol/src/types/envelope.ts`
- Modify: `packages/protocol/src/types/index.ts`

- [ ] **Step 1: Add WsPushToken type to ws.ts**

Add before the `WsClientMessage` union:

```typescript
export interface WsPushToken {
  t: "pushToken";
  /** Expo push token (e.g., "ExponentPushToken[xxx]") */
  token: string;
  /** Client platform */
  platform: "ios" | "android";
}
```

Add `WsPushToken` to the `WsClientMessage` union:
```typescript
export type WsClientMessage =
  | WsHello
  | WsAttach
  | WsDetach
  | WsResume
  | WsInChat
  | WsInTerm
  | WsResize
  | WsPing
  | WsPushToken
  | WsWorktreeCreate
  | WsWorktreeRemove
  | WsWorktreeList
  | WsSessionCreate
  | WsSessionStop
  | WsSessionRestart
  | WsSessionExport;
```

- [ ] **Step 2: Add "pushToken" to FrameType in envelope.ts**

```typescript
export type FrameType =
  | "hello"
  | "attach"
  | "detach"
  | "resume"
  | "rec"
  | "batch"
  | "in.chat"
  | "in.term"
  | "state"
  | "ping"
  | "pong"
  | "pushToken"
  | "err";
```

- [ ] **Step 3: Re-export WsPushToken from index.ts**

Add `WsPushToken` to the ws re-exports in `packages/protocol/src/types/index.ts`.

- [ ] **Step 4: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types/ws.ts packages/protocol/src/types/envelope.ts packages/protocol/src/types/index.ts
git commit -m "feat(protocol): add WsPushToken type and pushToken frame type"
```

---

### Task 3: Relay push module — Expo Push API + rate limiting + dedup

**Files:**
- Create: `packages/relay/src/push.ts`
- Create: `packages/relay/src/push.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/relay/src/push.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PushService } from "./push";

describe("PushService", () => {
  let push: PushService;

  beforeEach(() => {
    push = new PushService({
      rateLimitPerMinute: 3,
      dedupWindowMs: 5000,
    });
  });

  afterEach(() => {
    push.dispose();
  });

  describe("sendOrDeliver", () => {
    test("returns 'ws' when frontend is connected", async () => {
      const result = await push.sendOrDeliver({
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "Test",
        body: "Body",
        isFrontendConnected: true,
      });
      expect(result).toBe("ws");
    });

    test("calls Expo Push API when frontend is not connected", async () => {
      const calls: unknown[] = [];
      push = new PushService({
        rateLimitPerMinute: 3,
        dedupWindowMs: 5000,
        fetchFn: async (url, opts) => {
          calls.push({ url, body: JSON.parse(opts?.body as string) });
          return new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
            status: 200,
          });
        },
      });

      const result = await push.sendOrDeliver({
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "Test",
        body: "Body",
        isFrontendConnected: false,
      });

      expect(result).toBe("push");
      expect(calls).toHaveLength(1);
      expect((calls[0] as { body: { to: string } }).body.to).toBe(
        "ExponentPushToken[abc]",
      );
    });
  });

  describe("rate limiting", () => {
    test("rejects after exceeding rate limit", async () => {
      const push2 = new PushService({
        rateLimitPerMinute: 2,
        dedupWindowMs: 1000,
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [{ status: "ok" }] })),
      });

      // 1st and 2nd should succeed
      const r1 = await push2.sendOrDeliver({
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "T",
        body: "B",
        isFrontendConnected: false,
      });
      expect(r1).toBe("push");

      // Different dedup key (different event)
      const r2 = await push2.sendOrDeliver({
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "T2",
        body: "B2",
        isFrontendConnected: false,
        data: { sid: "s1", daemonId: "d1", event: "Elicitation" },
      });
      expect(r2).toBe("push");

      // 3rd should be rate limited
      const r3 = await push2.sendOrDeliver({
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "T3",
        body: "B3",
        isFrontendConnected: false,
        data: { sid: "s2", daemonId: "d1", event: "PermissionRequest" },
      });
      expect(r3).toBe("rate_limited");

      push2.dispose();
    });
  });

  describe("dedup", () => {
    test("deduplicates same frontendId+sid+event within window", async () => {
      const calls: unknown[] = [];
      const push2 = new PushService({
        rateLimitPerMinute: 100,
        dedupWindowMs: 5000,
        fetchFn: async (url, opts) => {
          calls.push(opts);
          return new Response(JSON.stringify({ data: [{ status: "ok" }] }));
        },
      });

      const opts = {
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "T",
        body: "B",
        isFrontendConnected: false,
        data: { sid: "s1", daemonId: "d1", event: "Elicitation" },
      };

      const r1 = await push2.sendOrDeliver(opts);
      expect(r1).toBe("push");

      const r2 = await push2.sendOrDeliver(opts);
      expect(r2).toBe("deduped");

      expect(calls).toHaveLength(1);
      push2.dispose();
    });

    test("allows same event after dedup window expires", async () => {
      const calls: unknown[] = [];
      const push2 = new PushService({
        rateLimitPerMinute: 100,
        dedupWindowMs: 50, // Very short for test
        fetchFn: async (url, opts) => {
          calls.push(opts);
          return new Response(JSON.stringify({ data: [{ status: "ok" }] }));
        },
      });

      const opts = {
        frontendId: "f1",
        token: "ExponentPushToken[abc]",
        title: "T",
        body: "B",
        isFrontendConnected: false,
        data: { sid: "s1", daemonId: "d1", event: "Elicitation" },
      };

      await push2.sendOrDeliver(opts);
      await Bun.sleep(60);
      const r2 = await push2.sendOrDeliver(opts);
      expect(r2).toBe("push");
      expect(calls).toHaveLength(2);
      push2.dispose();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/relay/src/push.test.ts
```

Expected: FAIL — `Cannot find module "./push"`

- [ ] **Step 3: Implement PushService**

Create `packages/relay/src/push.ts`:

```typescript
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("Push");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type DeliveryResult = "ws" | "push" | "rate_limited" | "deduped" | "error";

export interface PushRequest {
  frontendId: string;
  token: string;
  title: string;
  body: string;
  isFrontendConnected: boolean;
  data?: {
    sid: string;
    daemonId: string;
    event: string;
  };
}

export interface PushServiceOptions {
  /** Max push notifications per frontendId per minute */
  rateLimitPerMinute?: number;
  /** Dedup window in ms for same (frontendId, sid, event) */
  dedupWindowMs?: number;
  /** Override fetch for testing */
  fetchFn?: typeof fetch;
}

interface RateEntry {
  count: number;
  windowStart: number;
}

export class PushService {
  private rateLimitPerMinute: number;
  private dedupWindowMs: number;
  private fetchFn: typeof fetch;

  /** frontendId → rate state */
  private rates = new Map<string, RateEntry>();
  /** "frontendId:sid:event" → expiry timestamp */
  private dedup = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(opts: PushServiceOptions = {}) {
    this.rateLimitPerMinute = opts.rateLimitPerMinute ?? 5;
    this.dedupWindowMs = opts.dedupWindowMs ?? 60_000;
    this.fetchFn = opts.fetchFn ?? fetch;

    // Clean up expired dedup entries every 30s
    this.cleanupTimer = setInterval(() => this.cleanupDedup(), 30_000);
  }

  async sendOrDeliver(req: PushRequest): Promise<DeliveryResult> {
    if (req.isFrontendConnected) {
      return "ws";
    }

    // Dedup check
    if (req.data) {
      const dedupKey = `${req.frontendId}:${req.data.sid}:${req.data.event}`;
      const expiry = this.dedup.get(dedupKey);
      if (expiry && Date.now() < expiry) {
        return "deduped";
      }
      this.dedup.set(dedupKey, Date.now() + this.dedupWindowMs);
    }

    // Rate limit check
    const now = Date.now();
    let rate = this.rates.get(req.frontendId);
    if (!rate || now - rate.windowStart >= 60_000) {
      rate = { count: 0, windowStart: now };
      this.rates.set(req.frontendId, rate);
    }
    if (rate.count >= this.rateLimitPerMinute) {
      return "rate_limited";
    }
    rate.count++;

    // Send via Expo Push API
    try {
      const response = await this.fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: req.token,
          title: req.title,
          body: req.body,
          data: req.data,
          sound: "default",
        }),
      });

      if (!response.ok) {
        log.error(`Expo Push API error: ${response.status}`);
        return "error";
      }

      return "push";
    } catch (err) {
      log.error(`Expo Push API request failed: ${err}`);
      return "error";
    }
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, expiry] of this.dedup) {
      if (now >= expiry) {
        this.dedup.delete(key);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.rates.clear();
    this.dedup.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/relay/src/push.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/push.ts packages/relay/src/push.test.ts
git commit -m "feat(relay): add PushService with Expo Push API, rate limiting, and dedup"
```

---

### Task 4: Relay server — handle relay.push

**Files:**
- Modify: `packages/relay/src/relay-server.ts`
- Modify: `packages/relay/src/relay-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/relay/src/relay-server.test.ts`, at the end of the existing `describe` block:

```typescript
describe("relay.push", () => {
  test("delivers WS notification when frontend is connected", async () => {
    // Connect daemon
    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
        v: 2,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    // Connect frontend
    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-1",
        v: 2,
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    // Daemon sends relay.push
    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-1",
        token: "ExponentPushToken[abc]",
        title: "Session Test",
        body: "Waiting for response",
        data: { sid: "s1", daemonId: DAEMON_ID, event: "Elicitation" },
      }),
    );

    // Frontend should receive relay.notification
    const msg = await waitForMessage(
      frontend,
      (m) => m.t === "relay.notification",
    );
    expect(msg).toMatchObject({
      t: "relay.notification",
      title: "Session Test",
      body: "Waiting for response",
      data: { sid: "s1", daemonId: DAEMON_ID, event: "Elicitation" },
    });

    daemon.close();
    frontend.close();
  });

  test("rejects relay.push from non-daemon role", async () => {
    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-1",
        v: 2,
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-1",
        token: "ExponentPushToken[abc]",
        title: "Test",
        body: "Test",
      }),
    );

    const err = await waitForMessage(frontend, (m) => m.t === "relay.err");
    expect((err as RelayError).e).toBe("UNAUTHORIZED");

    frontend.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/relay/src/relay-server.test.ts
```

Expected: FAIL — `relay.push` falls through to `UNKNOWN_TYPE`

- [ ] **Step 3: Add relay.push handling to relay-server.ts**

Import PushService at the top of `relay-server.ts`:

```typescript
import type { RelayNotification } from "@teleprompter/protocol";
import { PushService } from "./push";
```

Add `pushService` field to `RelayServer`:

```typescript
private pushService = new PushService();
```

Add `relay.push` case in `handleMessage()` switch, before `default`:

```typescript
      case "relay.push":
        this.handlePush(ws, msg as RelayClientMessage & { t: "relay.push" });
        break;
```

Add `handlePush` method:

```typescript
  private async handlePush(
    ws: ServerWebSocket,
    msg: RelayClientMessage & { t: "relay.push" },
  ) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "daemon") {
      this.send(ws, {
        t: "relay.err",
        e: "UNAUTHORIZED",
        m: "Only daemons can send push requests",
      });
      return;
    }

    // Find the target frontend by frontendId in the same daemon group
    const group = this.daemonGroups.get(client.daemonId);
    let targetFrontendWs: ServerWebSocket | null = null;
    if (group) {
      for (const memberWs of group) {
        const member = this.clients.get(memberWs);
        if (
          member &&
          member.role === "frontend" &&
          member.frontendId === msg.frontendId
        ) {
          targetFrontendWs = memberWs;
          break;
        }
      }
    }

    const isFrontendConnected = targetFrontendWs !== null;

    const result = await this.pushService.sendOrDeliver({
      frontendId: msg.frontendId,
      token: msg.token,
      title: msg.title,
      body: msg.body,
      isFrontendConnected,
      data: msg.data,
    });

    if (result === "ws" && targetFrontendWs) {
      const notification: RelayNotification = {
        t: "relay.notification",
        title: msg.title,
        body: msg.body,
        data: msg.data,
      };
      this.send(targetFrontendWs, notification);
    }
  }
```

Dispose push service in `stop()`:

```typescript
  stop() {
    // ... existing cleanup ...
    this.pushService.dispose();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/relay/src/relay-server.test.ts
```

Expected: All PASS (existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/relay-server.ts packages/relay/src/relay-server.test.ts
git commit -m "feat(relay): handle relay.push with WS notification delivery"
```

---

### Task 5: Daemon push notifier — hook event detection + relay.push dispatch

**Files:**
- Create: `packages/daemon/src/push/push-notifier.ts`
- Create: `packages/daemon/src/push/push-notifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/push/push-notifier.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { PushNotifier } from "./push-notifier";

describe("PushNotifier", () => {
  test("triggers push for Elicitation event", () => {
    const pushes: unknown[] = [];
    const notifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        pushes.push({ frontendId, token, title, body, data });
      },
    });

    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "Elicitation",
      ns: "claude",
    });

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      frontendId: "fe-1",
      token: "ExponentPushToken[abc]",
      title: expect.any(String),
      body: expect.any(String),
      data: { sid: "s1", event: "Elicitation" },
    });
  });

  test("triggers push for PermissionRequest event", () => {
    const pushes: unknown[] = [];
    const notifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        pushes.push({ frontendId, token, title, body, data });
      },
    });

    notifier.registerToken("fe-1", "ExponentPushToken[xyz]", "android");

    notifier.onRecord({
      sid: "s2",
      kind: "event",
      name: "PermissionRequest",
      ns: "claude",
    });

    expect(pushes).toHaveLength(1);
    expect((pushes[0] as { data: { event: string } }).data.event).toBe(
      "PermissionRequest",
    );
  });

  test("does not trigger for non-notification events", () => {
    const pushes: unknown[] = [];
    const notifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        pushes.push({ frontendId, token, title, body, data });
      },
    });

    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");

    notifier.onRecord({ sid: "s1", kind: "event", name: "Stop", ns: "claude" });
    notifier.onRecord({ sid: "s1", kind: "io", ns: "claude" });
    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "PostToolUse",
      ns: "claude",
    });

    expect(pushes).toHaveLength(0);
  });

  test("sends to all registered frontends", () => {
    const pushes: unknown[] = [];
    const notifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        pushes.push({ frontendId });
      },
    });

    notifier.registerToken("fe-1", "ExponentPushToken[a]", "ios");
    notifier.registerToken("fe-2", "ExponentPushToken[b]", "android");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "Elicitation",
      ns: "claude",
    });

    expect(pushes).toHaveLength(2);
    expect(pushes.map((p: unknown) => (p as { frontendId: string }).frontendId)).toEqual([
      "fe-1",
      "fe-2",
    ]);
  });

  test("updates token on re-register", () => {
    const pushes: unknown[] = [];
    const notifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        pushes.push({ token });
      },
    });

    notifier.registerToken("fe-1", "ExponentPushToken[old]", "ios");
    notifier.registerToken("fe-1", "ExponentPushToken[new]", "ios");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "Elicitation",
      ns: "claude",
    });

    expect(pushes).toHaveLength(1);
    expect((pushes[0] as { token: string }).token).toBe("ExponentPushToken[new]");
  });

  test("unregisterToken removes frontend", () => {
    const pushes: unknown[] = [];
    const notifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        pushes.push({ frontendId });
      },
    });

    notifier.registerToken("fe-1", "ExponentPushToken[abc]", "ios");
    notifier.unregisterToken("fe-1");

    notifier.onRecord({
      sid: "s1",
      kind: "event",
      name: "Elicitation",
      ns: "claude",
    });

    expect(pushes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/daemon/src/push/push-notifier.test.ts
```

Expected: FAIL — `Cannot find module "./push-notifier"`

- [ ] **Step 3: Implement PushNotifier**

Create `packages/daemon/src/push/push-notifier.ts`:

```typescript
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("PushNotifier");

/** Events that trigger a push notification */
const NOTIFY_EVENTS = new Set(["Elicitation", "PermissionRequest"]);

const EVENT_MESSAGES: Record<string, { title: string; body: string }> = {
  Elicitation: {
    title: "Response needed",
    body: "Claude is waiting for your answer",
  },
  PermissionRequest: {
    title: "Permission needed",
    body: "Tool permission approval required",
  },
};

interface FrontendToken {
  token: string;
  platform: "ios" | "android";
}

interface RecordInfo {
  sid: string;
  kind: string;
  name?: string;
  ns?: string;
}

export interface PushNotifierDeps {
  sendPush: (
    frontendId: string,
    token: string,
    title: string,
    body: string,
    data: { sid: string; daemonId?: string; event: string },
  ) => void;
}

export class PushNotifier {
  private tokens = new Map<string, FrontendToken>();
  private deps: PushNotifierDeps;

  constructor(deps: PushNotifierDeps) {
    this.deps = deps;
  }

  registerToken(
    frontendId: string,
    token: string,
    platform: "ios" | "android",
  ): void {
    this.tokens.set(frontendId, { token, platform });
    log.info(`push token registered for frontend ${frontendId}`);
  }

  unregisterToken(frontendId: string): void {
    this.tokens.delete(frontendId);
  }

  onRecord(rec: RecordInfo): void {
    if (rec.kind !== "event" || !rec.name || !NOTIFY_EVENTS.has(rec.name)) {
      return;
    }

    const msg = EVENT_MESSAGES[rec.name];
    if (!msg) return;

    for (const [frontendId, { token }] of this.tokens) {
      this.deps.sendPush(frontendId, token, msg.title, msg.body, {
        sid: rec.sid,
        event: rec.name,
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/daemon/src/push/push-notifier.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/push/push-notifier.ts packages/daemon/src/push/push-notifier.test.ts
git commit -m "feat(daemon): add PushNotifier for hook event detection"
```

---

### Task 6: Daemon relay client — add sendPush method

**Files:**
- Modify: `packages/daemon/src/transport/relay-client.ts`

- [ ] **Step 1: Add sendPush method**

Add after the `publishToPeer` method in `RelayClient`:

```typescript
  /**
   * Send a push notification request to the relay server.
   * The relay will decide delivery method (WS notification vs Expo Push).
   * This message is plaintext (not E2EE) — relay needs to read it.
   */
  sendPush(
    frontendId: string,
    token: string,
    title: string,
    body: string,
    data?: { sid: string; daemonId?: string; event: string },
  ): void {
    this.send({
      t: "relay.push",
      frontendId,
      token,
      title,
      body,
      data: data
        ? { sid: data.sid, daemonId: data.daemonId ?? this.config.daemonId, event: data.event }
        : undefined,
    } as RelayClientMessage);
  }
```

Note: The `send()` method accepts `RelayClientMessage`. Since we added `RelayPush` to `RelayClientMessage` in Task 1, this will type-check.

- [ ] **Step 2: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/transport/relay-client.ts
git commit -m "feat(daemon): add sendPush method to relay client"
```

---

### Task 7: Wire PushNotifier into Daemon

**Files:**
- Modify: `packages/daemon/src/daemon.ts`

- [ ] **Step 1: Import and instantiate PushNotifier**

Add import at the top:

```typescript
import { PushNotifier } from "./push/push-notifier";
```

Add field to the `Daemon` class:

```typescript
  private pushNotifier: PushNotifier;
```

Initialize in constructor, after `this.store = new Store(storeDir)`:

```typescript
    this.pushNotifier = new PushNotifier({
      sendPush: (frontendId, token, title, body, data) => {
        for (const relay of this.relayClients) {
          relay.sendPush(frontendId, token, title, body, data);
        }
      },
    });
```

- [ ] **Step 2: Call pushNotifier.onRecord in handleRec**

In `handleRec()`, after the relay publish loop (after line ~383), add:

```typescript
    // Check if this record should trigger a push notification
    this.pushNotifier.onRecord({
      sid: msg.sid,
      kind: msg.kind,
      name: msg.name,
      ns: msg.ns,
    });
```

- [ ] **Step 3: Handle pushToken message from frontend**

In the `onInput` handler of `connectRelay()` (around line 206), the relay client currently only handles `in.chat` and `in.term`. We need to extend the daemon-side relay client to also forward `pushToken` messages.

Add a new event to `RelayClientEvents`:

In `packages/daemon/src/transport/relay-client.ts`, add to `RelayClientEvents`:

```typescript
  /** Called when a frontend sends a pushToken message */
  onPushToken?: (frontendId: string, token: string, platform: "ios" | "android") => void;
```

In the `handleDecryptedFrame` method (around line 277), extend the condition:

```typescript
    if (msg.t === "in.chat" || msg.t === "in.term") {
      this.events.onInput?.(msg.sid, msg.d, peer.frontendId);
    } else if (msg.t === "pushToken") {
      this.events.onPushToken?.(peer.frontendId, msg.token, msg.platform);
    }
```

Then in `daemon.ts`, in the `connectRelay()` call, add:

```typescript
      onPushToken: (frontendId, token, platform) => {
        this.pushNotifier.registerToken(frontendId, token, platform);
      },
```

- [ ] **Step 4: Run type check and tests**

```bash
pnpm type-check:all && bun test packages/daemon
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/transport/relay-client.ts
git commit -m "feat(daemon): wire PushNotifier into record pipeline and pushToken handling"
```

---

### Task 8: Install expo-notifications and configure app.json

**Files:**
- Modify: `apps/app/package.json`
- Modify: `apps/app/app.json`

- [ ] **Step 1: Install expo-notifications**

```bash
cd apps/app && npx expo install expo-notifications
```

- [ ] **Step 2: Add expo-notifications plugin to app.json**

Add to the `plugins` array in `apps/app/app.json`:

```json
[
  "expo-notifications",
  {
    "icon": "./assets/icon.png",
    "color": "#000000"
  }
]
```

- [ ] **Step 3: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/app/package.json apps/app/app.json
# Also add pnpm-lock.yaml if changed
git add pnpm-lock.yaml 2>/dev/null || true
git commit -m "feat(app): install expo-notifications and configure plugins"
```

---

### Task 9: Frontend push notifications hook

**Files:**
- Create: `apps/app/src/hooks/use-push-notifications.ts`

- [ ] **Step 1: Create the hook**

Create `apps/app/src/hooks/use-push-notifications.ts`:

```typescript
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useRelayConnectionStore } from "./use-relay";

/**
 * Configures push notifications:
 * - Requests permission and gets Expo push token
 * - Sends token to daemon via relay
 * - Handles notification tap → navigate to session
 */
export function usePushNotifications() {
  const router = useRouter();
  const tokenSent = useRef(false);

  useEffect(() => {
    if (Platform.OS === "web") return;

    // Configure notification presentation when app is in foreground
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: false, // We use in-app toast instead
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    // Register for push token
    registerForPushToken();

    // Handle notification tap (app opened from notification)
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as {
          sid?: string;
          daemonId?: string;
        } | undefined;
        if (data?.sid) {
          router.push(`/session/${data.sid}`);
        }
      },
    );

    return () => {
      responseSub.remove();
    };
  }, []);

  // Re-send token when relay connections change
  const relayConnections = useRelayConnectionStore((s) => s.connections);

  useEffect(() => {
    if (Platform.OS === "web") return;
    // When a relay connection comes online, re-send token
    sendTokenToRelays();
  }, [relayConnections]);
}

async function registerForPushToken(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  const { status: existingStatus } =
    await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  const tokenData = await Notifications.getExpoPushTokenAsync();
  const token = tokenData.data;

  // Store token for later relay sends
  _currentToken = token;
  sendTokenToRelays();

  // Listen for token changes
  Notifications.addPushTokenListener((newToken) => {
    _currentToken = newToken.data;
    sendTokenToRelays();
  });

  return token;
}

let _currentToken: string | null = null;

function sendTokenToRelays(): void {
  if (!_currentToken || Platform.OS === "web") return;

  const { getRelayClient } = require("./use-relay");
  const clients = getRelayClient();
  if (!clients) return;

  const platform = Platform.OS as "ios" | "android";
  for (const client of clients) {
    client.sendPushToken(_currentToken, platform);
  }
}
```

Note: The `sendPushToken` method on `FrontendRelayClient` will be added in the next task. The `getRelayClient` accessor and `useRelayConnectionStore` are referenced from `use-relay.ts` — we will add those exports in the same task.

- [ ] **Step 2: Run type check (may have missing refs — that's expected, they'll be added in next tasks)**

This step may have type errors for `sendPushToken` and `getRelayClient` which don't exist yet. That's expected.

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/hooks/use-push-notifications.ts
git commit -m "feat(app): add usePushNotifications hook for token registration"
```

---

### Task 10: Frontend relay client — sendPushToken + relay.notification handling

**Files:**
- Modify: `apps/app/src/lib/relay-client.ts`
- Modify: `apps/app/src/hooks/use-relay.ts`

- [ ] **Step 1: Add sendPushToken to FrontendRelayClient**

In `apps/app/src/lib/relay-client.ts`, add a method to encrypt and send the pushToken message:

```typescript
  async sendPushToken(token: string, platform: "ios" | "android"): Promise<void> {
    if (!this.authenticated || !this.sessionKeys) return;
    const msg = { t: "pushToken", token, platform };
    const json = JSON.stringify(msg);
    const plaintext = new TextEncoder().encode(json);
    const ct = await encrypt(plaintext, this.sessionKeys.tx);
    this.send({ t: "relay.pub", sid: "__meta__", ct, seq: 0 });
  }
```

- [ ] **Step 2: Handle relay.notification in FrontendRelayClient**

Add a new event callback to `FrontendRelayClientEvents`:

```typescript
  onNotification?: (title: string, body: string, data?: { sid: string; daemonId: string; event: string }) => void;
```

In the message handler where `relay.notification` arrives (this comes as a plaintext relay server message, not encrypted), add handling:

```typescript
    if (msg.t === "relay.notification") {
      this.events.onNotification?.(msg.title, msg.body, msg.data);
      return;
    }
```

- [ ] **Step 3: Add getRelayClients accessor and notification wiring in use-relay.ts**

In `apps/app/src/hooks/use-relay.ts`, add:

A module-level array to track active relay clients:

```typescript
let activeRelayClients: FrontendRelayClient[] = [];

export function getRelayClient(): FrontendRelayClient[] {
  return activeRelayClients;
}
```

Update the client creation in `useRelay` to push/remove from `activeRelayClients`.

Wire the `onNotification` callback when creating each relay client:

```typescript
  onNotification: (title, body, data) => {
    // Check if user is already viewing this session
    const currentSid = useSessionStore.getState().sid;
    if (data?.sid && data.sid === currentSid) return; // Skip — user is watching

    // Show in-app toast
    useNotificationStore.getState().showToast({ title, body, data });
  },
```

- [ ] **Step 4: Create a minimal notification store for toast state**

Create `apps/app/src/stores/notification-store.ts`:

```typescript
import { create } from "zustand";

export interface ToastData {
  title: string;
  body: string;
  data?: { sid: string; daemonId: string; event: string };
}

interface NotificationStore {
  toast: ToastData | null;
  showToast: (data: ToastData) => void;
  dismissToast: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  toast: null,
  showToast: (data) => {
    set({ toast: data });
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      set((state) => (state.toast === data ? { toast: null } : state));
    }, 5000);
  },
  dismissToast: () => set({ toast: null }),
}));
```

- [ ] **Step 5: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/lib/relay-client.ts apps/app/src/hooks/use-relay.ts apps/app/src/stores/notification-store.ts
git commit -m "feat(app): add sendPushToken, relay.notification handling, and notification store"
```

---

### Task 11: InAppToast component

**Files:**
- Create: `apps/app/src/components/InAppToast.tsx`

- [ ] **Step 1: Create the toast component**

Create `apps/app/src/components/InAppToast.tsx`:

```typescript
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNotificationStore } from "../stores/notification-store";

export function InAppToast() {
  const toast = useNotificationStore((s) => s.toast);
  const dismiss = useNotificationStore((s) => s.dismissToast);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  if (!toast) return null;

  const handlePress = () => {
    dismiss();
    if (toast.data?.sid) {
      router.push(`/session/${toast.data.sid}`);
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      className="absolute left-4 right-4 bg-tp-bg-elevated rounded-card border border-tp-border p-4 shadow-lg z-50"
      style={{ top: insets.top + 8 }}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1 mr-2">
          <Text className="text-tp-text-primary font-semibold text-sm">
            {toast.title}
          </Text>
          <Text className="text-tp-text-secondary text-sm mt-1">
            {toast.body}
          </Text>
        </View>
        <Pressable onPress={dismiss} hitSlop={8}>
          <Text className="text-tp-text-tertiary text-lg">✕</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}
```

- [ ] **Step 2: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/InAppToast.tsx
git commit -m "feat(app): add InAppToast component for relay notifications"
```

---

### Task 12: Wire everything into _layout.tsx

**Files:**
- Modify: `apps/app/app/_layout.tsx`

- [ ] **Step 1: Import and add hooks + component**

Add imports:

```typescript
import { usePushNotifications } from "../src/hooks/use-push-notifications";
import { InAppToast } from "../src/components/InAppToast";
```

Call `usePushNotifications()` in the component body, after `useRelay()`:

```typescript
  // Push notification registration and handling
  usePushNotifications();
```

Add `<InAppToast />` inside the `<SafeAreaProvider>`, after `<UpdateBanner>`:

```typescript
        <UpdateBanner status={otaStatus} onRestart={restart} />
        <InAppToast />
```

- [ ] **Step 2: Run type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/app/app/_layout.tsx
git commit -m "feat(app): wire push notifications and toast into root layout"
```

---

### Task 13: Run full test suite + type check

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: All PASS. No existing tests should break.

- [ ] **Step 2: Run full type check**

```bash
pnpm type-check:all
```

Expected: PASS

- [ ] **Step 3: Fix any issues found**

If any test or type error appears, fix it before proceeding.

---

### Task 14: Update documentation

**Files:**
- Modify: `TODO.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Mark push notification TODO as done**

In `TODO.md`, change line 184 from:
```
- [ ] Expo Push Notifications — 작업 완료, 유저 응답 대기 시 푸시 알림 (Runner hooks 이벤트 기반)
```
to:
```
- [x] Expo Push Notifications — 작업 완료, 유저 응답 대기 시 푸시 알림 (Runner hooks 이벤트 기반)
```

- [ ] **Step 2: Update CLAUDE.md test list**

Add to the Tier 1 unit tests section:
```
- `packages/relay/src/push.test.ts` — Expo Push API client, rate limiting, dedup
- `packages/daemon/src/push/push-notifier.test.ts` — hook event detection, token registration, push dispatch
```

Add to the Tier 2 integration tests section:
```
- `packages/relay/src/relay-server.test.ts` — (existing) + relay.push handling, WS notification delivery
```

- [ ] **Step 3: Commit**

```bash
git add TODO.md CLAUDE.md
git commit -m "docs: mark push notifications done, update test documentation"
```
