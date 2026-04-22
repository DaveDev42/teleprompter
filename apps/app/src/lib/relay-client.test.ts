/**
 * Unit tests for FrontendRelayClient.
 *
 * Covers:
 *  - E2EE roundtrip (pairingSecret → kxKey → frame encrypt/decrypt)
 *  - ECDH session-key derivation (daemon/frontend pair up)
 *  - Per-session key ratchet isolation
 *  - WebSocket handler state machine (auth.ok → kx → frame)
 *  - Reconnect scheduling with exponential backoff
 *
 * These tests only exercise the frontend client in isolation — they do NOT
 * spin up a real relay server. A small mock WebSocket is installed onto
 * `globalThis.WebSocket` to capture outgoing traffic and inject inbound
 * frames. Crypto primitives come from `@teleprompter/protocol/client` and
 * share the libsodium runtime with the client under test.
 *
 * Run with:
 *   bun test apps/app/src/lib/relay-client.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONTROL_RENAME,
  CONTROL_UNPAIR,
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  ensureSodium,
  fromBase64,
  generateKeyPair,
  generatePairingSecret,
  type KeyPair,
  type RelayServerMessage,
  ratchetSessionKeys,
  toBase64,
} from "@teleprompter/protocol/client";
import { FrontendRelayClient, type FrontendRelayConfig } from "./relay-client";

// ── Mock WebSocket ──────────────────────────────────────────────────────────

type Listener = ((ev: unknown) => void) | null;

/**
 * Minimal WebSocket stand-in that satisfies FrontendRelayClient's usage
 * (readyState + onopen/onmessage/onclose/onerror + send/close) without ever
 * opening a real socket. Tests drive it via `simulateOpen`, `simulateMessage`,
 * `simulateClose`, and inspect captured outbound messages via `sent`.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];

  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
  }

  close() {
    if (
      this.readyState === MockWebSocket.CLOSED ||
      this.readyState === MockWebSocket.CLOSING
    ) {
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(msg: RelayServerMessage | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  simulateClose() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  simulateError(msg = "boom") {
    this.onerror?.({ message: msg });
  }

  /** Parse captured outbound messages in order. */
  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** Find the first outbound message matching `t`. */
  findSent<T = Record<string, unknown>>(t: string): T | undefined {
    for (const raw of this.sent) {
      const parsed = JSON.parse(raw) as Record<string, unknown> & {
        t?: string;
      };
      if (parsed.t === t) return parsed as T;
    }
    return undefined;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FullPairing {
  daemonKp: KeyPair;
  frontendKp: KeyPair;
  pairingSecret: Uint8Array;
  kxKey: Uint8Array;
  daemonTx: Uint8Array;
  daemonRx: Uint8Array;
  frontendTx: Uint8Array;
  frontendRx: Uint8Array;
}

async function setupPairing(): Promise<FullPairing> {
  const daemonKp = await generateKeyPair();
  const frontendKp = await generateKeyPair();
  const pairingSecret = await generatePairingSecret();
  const kxKey = await deriveKxKey(pairingSecret);
  const daemonKeys = await deriveSessionKeys(
    daemonKp,
    frontendKp.publicKey,
    "daemon",
  );
  const frontendKeys = await deriveSessionKeys(
    frontendKp,
    daemonKp.publicKey,
    "frontend",
  );
  return {
    daemonKp,
    frontendKp,
    pairingSecret,
    kxKey,
    daemonTx: daemonKeys.tx,
    daemonRx: daemonKeys.rx,
    frontendTx: frontendKeys.tx,
    frontendRx: frontendKeys.rx,
  };
}

function makeConfig(
  p: FullPairing,
  overrides: Partial<FrontendRelayConfig> = {},
): FrontendRelayConfig {
  return {
    relayUrl: "ws://mock.relay/test",
    daemonId: "daemon-test",
    token: "token-test",
    keyPair: p.frontendKp,
    daemonPublicKey: p.daemonKp.publicKey,
    pairingSecret: p.pairingSecret,
    frontendId: "frontend-test",
    ...overrides,
  };
}

/**
 * Drive the client through the standard handshake so tests can start
 * from an authenticated state. Returns the MockWebSocket currently in use.
 */
async function authenticate(
  client: FrontendRelayClient,
): Promise<MockWebSocket> {
  await client.connect();
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no WebSocket instance created by connect()");
  ws.simulateOpen();
  ws.simulateMessage({ t: "relay.auth.ok" } as RelayServerMessage);
  // sendKeyExchange() is async (encrypt is async) — flush microtasks.
  await flushPromises();
  return ws;
}

/** Yield to the event loop a few times to let pending promise chains resolve. */
async function flushPromises(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

// ── Shared fixtures ─────────────────────────────────────────────────────────

let realWebSocket: typeof globalThis.WebSocket;

beforeEach(async () => {
  // Ensure libsodium is ready before each test so that crypto calls inside
  // the client (which are async lazy-init anyway) don't race the first
  // simulated event.
  await ensureSodium();
  MockWebSocket.reset();
  realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
    MockWebSocket;
});

afterEach(() => {
  (
    globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }
  ).WebSocket = realWebSocket;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("FrontendRelayClient — crypto primitives", () => {
  test("pairingSecret → kxKey is deterministic and matches daemon side", async () => {
    const secret = await generatePairingSecret();
    const k1 = await deriveKxKey(secret);
    const k2 = await deriveKxKey(secret);
    expect(k1).toEqual(k2);
    expect(k1.length).toBe(32);
  });

  test("ECDH session keys match across daemon/frontend roles", async () => {
    const p = await setupPairing();
    // daemon tx == frontend rx, daemon rx == frontend tx
    expect(p.daemonTx).toEqual(p.frontendRx);
    expect(p.daemonRx).toEqual(p.frontendTx);
  });

  test("kx envelope roundtrip: daemon decrypts frontend pubkey", async () => {
    const p = await setupPairing();
    const payload = JSON.stringify({
      pk: await toBase64(p.frontendKp.publicKey),
      frontendId: "frontend-test",
      role: "frontend",
    });
    const ct = await encrypt(new TextEncoder().encode(payload), p.kxKey);
    const pt = await decrypt(ct, p.kxKey);
    const decoded = JSON.parse(new TextDecoder().decode(pt));
    expect(decoded.frontendId).toBe("frontend-test");
    expect(decoded.pk).toBe(await toBase64(p.frontendKp.publicKey));
  });

  test("data frame roundtrip: daemon encrypt → frontend decrypt", async () => {
    const p = await setupPairing();
    const msg = JSON.stringify({
      t: "rec",
      sid: "s1",
      seq: 1,
      k: "io",
      d: btoa("hello"),
    });
    const ct = await encrypt(new TextEncoder().encode(msg), p.daemonTx);
    const pt = await decrypt(ct, p.frontendRx);
    expect(new TextDecoder().decode(pt)).toBe(msg);
  });

  test("tampered ciphertext is rejected", async () => {
    const p = await setupPairing();
    const ct = await encrypt(new TextEncoder().encode("secret"), p.frontendTx);
    // Flip a bit somewhere inside the ciphertext (after the nonce).
    const bytes = await fromBase64(ct);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    const tamperedCt = await toBase64(bytes);
    await expect(decrypt(tamperedCt, p.daemonRx)).rejects.toThrow();
  });

  test("wrong key (unrelated frontend) cannot decrypt", async () => {
    const p = await setupPairing();
    const strangerKp = await generateKeyPair();
    const strangerKeys = await deriveSessionKeys(
      strangerKp,
      p.daemonKp.publicKey,
      "frontend",
    );

    const ct = await encrypt(new TextEncoder().encode("hush"), p.daemonTx);
    await expect(decrypt(ct, strangerKeys.rx)).rejects.toThrow();
  });

  test("session ratchet isolates ciphertext per-session", async () => {
    const p = await setupPairing();

    const daemonS1 = await ratchetSessionKeys(
      { tx: p.daemonTx, rx: p.daemonRx },
      "session-1",
      "daemon",
    );
    const frontendS1 = await ratchetSessionKeys(
      { tx: p.frontendTx, rx: p.frontendRx },
      "session-1",
      "frontend",
    );
    const frontendS2 = await ratchetSessionKeys(
      { tx: p.frontendTx, rx: p.frontendRx },
      "session-2",
      "frontend",
    );

    const ct = await encrypt(
      new TextEncoder().encode("session-1 payload"),
      daemonS1.tx,
    );
    // Same-session key decrypts successfully.
    const pt = await decrypt(ct, frontendS1.rx);
    expect(new TextDecoder().decode(pt)).toBe("session-1 payload");
    // Other session's ratcheted key cannot decrypt.
    await expect(decrypt(ct, frontendS2.rx)).rejects.toThrow();
  });
});

describe("FrontendRelayClient — WebSocket state machine", () => {
  test("connect() opens WS and sends relay.auth on onopen", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    await client.connect();
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws!.url).toBe("ws://mock.relay/test");

    // Nothing sent until the socket opens.
    expect(ws!.sent.length).toBe(0);

    ws!.simulateOpen();
    const auth = ws!.findSent<{
      t: string;
      role: string;
      daemonId: string;
      token: string;
      frontendId: string;
      v: number;
    }>("relay.auth");
    expect(auth).toBeDefined();
    expect(auth?.role).toBe("frontend");
    expect(auth?.daemonId).toBe("daemon-test");
    expect(auth?.token).toBe("token-test");
    expect(auth?.frontendId).toBe("frontend-test");
    expect(auth?.v).toBe(2);
    client.dispose();
  });

  test("relay.auth.ok fires onConnected, sends subs + kx", async () => {
    const p = await setupPairing();
    let connected = false;
    const client = new FrontendRelayClient(makeConfig(p), {
      onConnected: () => {
        connected = true;
      },
    });

    const ws = await authenticate(client);
    expect(connected).toBe(true);
    expect(client.isConnected()).toBe(true);

    // Meta + control subscriptions
    const subs = ws
      .parsedSent()
      .filter((m) => m.t === "relay.sub")
      .map((m) => m.sid);
    expect(subs).toContain("__meta__");
    expect(subs).toContain("__control__");

    // Key-exchange envelope delivered to daemon
    const kx = ws.findSent<{ t: string; ct: string; role: string }>("relay.kx");
    expect(kx).toBeDefined();
    expect(kx?.role).toBe("frontend");

    // The kx envelope must decrypt with the pairing-derived kxKey and
    // contain the frontend's pubkey — this is the promise the daemon relies on.
    const pt = await decrypt(kx!.ct, p.kxKey);
    const decoded = JSON.parse(new TextDecoder().decode(pt));
    expect(decoded.role).toBe("frontend");
    expect(decoded.frontendId).toBe("frontend-test");
    expect(decoded.pk).toBe(await toBase64(p.frontendKp.publicKey));

    client.dispose();
  });

  test("relay.auth.err surfaces via onError", async () => {
    const p = await setupPairing();
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });

    await client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ t: "relay.auth.err", e: "bad-token" });
    await flushPromises();

    expect(errors.some((e) => e.includes("bad-token"))).toBe(true);
    expect(client.isConnected()).toBe(false);
    client.dispose();
  });

  test("relay.frame with rec is decrypted and emitted via onRec", async () => {
    const p = await setupPairing();
    const recs: unknown[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onRec: (r) => recs.push(r),
    });

    const ws = await authenticate(client);

    // Daemon encrypts a rec and injects a relay.frame.
    const rec = {
      t: "rec",
      sid: "s1",
      seq: 7,
      k: "io",
      d: btoa("hello world"),
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(rec)),
      p.daemonTx,
    );
    ws.simulateMessage({
      t: "relay.frame",
      sid: "s1",
      ct,
      seq: 7,
      from: "daemon",
    } as RelayServerMessage);
    await flushPromises();

    expect(recs.length).toBe(1);
    expect((recs[0] as { seq: number }).seq).toBe(7);
    expect((recs[0] as { sid: string }).sid).toBe("s1");
    client.dispose();
  });

  test("relay.frame from frontend is ignored (wrong sender)", async () => {
    const p = await setupPairing();
    const recs: unknown[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onRec: (r) => recs.push(r),
    });

    const ws = await authenticate(client);

    const rec = { t: "rec", sid: "s1", seq: 1, k: "io", d: btoa("x") };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(rec)),
      p.daemonTx,
    );
    ws.simulateMessage({
      t: "relay.frame",
      sid: "s1",
      ct,
      seq: 1,
      from: "frontend", // should be dropped
    } as RelayServerMessage);
    await flushPromises();

    expect(recs.length).toBe(0);
    client.dispose();
  });

  test("relay.frame with garbage ciphertext logs but does not throw", async () => {
    const p = await setupPairing();
    const recs: unknown[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onRec: (r) => recs.push(r),
    });

    const ws = await authenticate(client);

    // Send a well-formed relay.frame envelope with bogus ciphertext.
    ws.simulateMessage({
      t: "relay.frame",
      sid: "s1",
      ct: "AAAAAAAAAAAAAA", // clearly not a valid XChaCha20-Poly1305 ciphertext
      seq: 1,
      from: "daemon",
    } as RelayServerMessage);
    await flushPromises();

    expect(recs.length).toBe(0);
    // Client is still alive.
    expect(client.isConnected()).toBe(true);
    client.dispose();
  });

  test("decrypt fail on __control__ sid is demoted to debug and skips onError", async () => {
    // When the daemon broadcasts control.unpair to N frontends, each frontend
    // can only decrypt its own per-frontend ciphertext; the other (N-1)
    // frames are "wrong-key" decrypts by design. Those must not surface as
    // errors or toasts — they are normal traffic on the __control__ channel.
    const p = await setupPairing();
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });

    const originalError = console.error;
    const originalDebug = console.debug;
    const errorCalls: unknown[][] = [];
    const debugCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };
    console.debug = (...args: unknown[]) => {
      debugCalls.push(args);
    };

    try {
      const ws = await authenticate(client);

      // Simulate a broadcast frame addressed to a different frontend — we
      // cannot decrypt it with our session keys. This is the N-1 case.
      ws.simulateMessage({
        t: "relay.frame",
        sid: "__control__",
        ct: "AAAAAAAAAAAAAA", // undecryptable with our keys
        seq: 1,
        from: "daemon",
      } as RelayServerMessage);
      await flushPromises();

      // Should NOT emit onError — decrypt failure on __control__ is expected.
      expect(errors).toEqual([]);
      // Should NOT be logged as console.error (noisy).
      const relayErrorCalls = errorCalls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("[FrontendRelay]"),
      );
      expect(relayErrorCalls).toEqual([]);
      // Should be logged as console.debug instead (quiet).
      const relayDebugCalls = debugCalls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("[FrontendRelay]"),
      );
      expect(relayDebugCalls.length).toBe(1);
      expect(client.isConnected()).toBe(true);
    } finally {
      console.error = originalError;
      console.debug = originalDebug;
      client.dispose();
    }
  });

  test("decrypt fail on non-control sid still logs as error", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      const ws = await authenticate(client);

      ws.simulateMessage({
        t: "relay.frame",
        sid: "s1",
        ct: "AAAAAAAAAAAAAA",
        seq: 1,
        from: "daemon",
      } as RelayServerMessage);
      await flushPromises();

      const relayErrorCalls = errorCalls.filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("[FrontendRelay] decrypt failed"),
      );
      expect(relayErrorCalls.length).toBe(1);
    } finally {
      console.error = originalError;
      client.dispose();
    }
  });

  test("relay.presence → onPresence", async () => {
    const p = await setupPairing();
    const seen: Array<{ online: boolean; sessions: string[] }> = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onPresence: (online, sessions) => seen.push({ online, sessions }),
    });

    const ws = await authenticate(client);
    ws.simulateMessage({
      t: "relay.presence",
      daemonId: "daemon-test",
      online: true,
      sessions: ["s1", "s2"],
      lastSeen: Date.now(),
    } as RelayServerMessage);
    await flushPromises();

    expect(seen.length).toBe(1);
    expect(seen[0]?.online).toBe(true);
    expect(seen[0]?.sessions).toEqual(["s1", "s2"]);
    client.dispose();
  });

  test("relay.notification → onNotification", async () => {
    const p = await setupPairing();
    const notes: Array<{ title: string; body: string }> = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onNotification: (title, body) => notes.push({ title, body }),
    });

    const ws = await authenticate(client);
    ws.simulateMessage({
      t: "relay.notification",
      title: "Stop",
      body: "Claude finished",
      data: { sid: "s1", daemonId: "daemon-test", event: "Stop" },
    } as RelayServerMessage);
    await flushPromises();

    expect(notes).toEqual([{ title: "Stop", body: "Claude finished" }]);
    client.dispose();
  });

  test("control.unpair on control channel fires onUnpair", async () => {
    const p = await setupPairing();
    const received: Array<{ daemonId: string; reason: string }> = [];
    const client = new FrontendRelayClient(makeConfig(p));
    client.onUnpair = (info) => received.push(info);

    const ws = await authenticate(client);

    const msg = {
      t: CONTROL_UNPAIR,
      daemonId: "daemon-test",
      frontendId: "frontend-test",
      reason: "user-initiated",
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(msg)),
      p.daemonTx,
    );
    ws.simulateMessage({
      t: "relay.frame",
      sid: "__control__",
      ct,
      seq: 1,
      from: "daemon",
    } as RelayServerMessage);
    await flushPromises();

    expect(received).toEqual([
      { daemonId: "daemon-test", reason: "user-initiated" },
    ]);
    client.dispose();
  });

  test("control.unpair arriving on non-control sid is ignored", async () => {
    const p = await setupPairing();
    const received: Array<{ daemonId: string; reason: string }> = [];
    const client = new FrontendRelayClient(makeConfig(p));
    client.onUnpair = (info) => received.push(info);

    const ws = await authenticate(client);

    const msg = {
      t: CONTROL_UNPAIR,
      daemonId: "daemon-test",
      frontendId: "frontend-test",
      reason: "user-initiated",
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(msg)),
      p.daemonTx,
    );
    ws.simulateMessage({
      t: "relay.frame",
      sid: "s1", // NOT the control channel
      ct,
      seq: 1,
      from: "daemon",
    } as RelayServerMessage);
    await flushPromises();

    expect(received.length).toBe(0);
    client.dispose();
  });

  test("control.rename on control channel fires onRename", async () => {
    const p = await setupPairing();
    const received: Array<{ daemonId: string; label: string }> = [];
    const client = new FrontendRelayClient(makeConfig(p));
    client.onRename = (info) => received.push(info);

    const ws = await authenticate(client);

    const msg = {
      t: CONTROL_RENAME,
      daemonId: "daemon-test",
      frontendId: "frontend-test",
      label: "Home Mac",
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(msg)),
      p.daemonTx,
    );
    ws.simulateMessage({
      t: "relay.frame",
      sid: "__control__",
      ct,
      seq: 1,
      from: "daemon",
    } as RelayServerMessage);
    await flushPromises();

    expect(received).toEqual([{ daemonId: "daemon-test", label: "Home Mac" }]);
    client.dispose();
  });
});

describe("FrontendRelayClient — outbound encrypted senders", () => {
  test("sendChat encrypts with tx key and publishes on the session sid", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);

    client.sendChat("s1", "hi daemon");
    await flushPromises();

    const pub = ws
      .parsedSent()
      .find(
        (m) => m.t === "relay.pub" && (m as { sid?: string }).sid === "s1",
      ) as { t: string; sid: string; ct: string; seq: number } | undefined;
    expect(pub).toBeDefined();
    // Daemon decrypts with its rx key (== frontend tx).
    const pt = await decrypt(pub!.ct, p.daemonRx);
    const decoded = JSON.parse(new TextDecoder().decode(pt));
    expect(decoded).toEqual({ t: "in.chat", sid: "s1", d: "hi daemon" });
    client.dispose();
  });

  test("sendUnpairNotice publishes on the control channel", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);

    await client.sendUnpairNotice("user-initiated");
    await flushPromises();

    const pub = ws
      .parsedSent()
      .find(
        (m) =>
          m.t === "relay.pub" && (m as { sid?: string }).sid === "__control__",
      ) as { ct: string } | undefined;
    expect(pub).toBeDefined();

    const pt = await decrypt(pub!.ct, p.daemonRx);
    const decoded = JSON.parse(new TextDecoder().decode(pt));
    expect(decoded.t).toBe(CONTROL_UNPAIR);
    expect(decoded.daemonId).toBe("daemon-test");
    expect(decoded.frontendId).toBe("frontend-test");
    expect(decoded.reason).toBe("user-initiated");
    expect(typeof decoded.ts).toBe("number");
    client.dispose();
  });

  test("sendRenameNotice publishes control.rename on control channel", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);

    await client.sendRenameNotice("iPhone 17");
    await flushPromises();

    const pub = ws
      .parsedSent()
      .find(
        (m) =>
          m.t === "relay.pub" && (m as { sid?: string }).sid === "__control__",
      ) as { ct: string } | undefined;
    expect(pub).toBeDefined();

    const pt = await decrypt(pub!.ct, p.daemonRx);
    const decoded = JSON.parse(new TextDecoder().decode(pt));
    expect(decoded.t).toBe(CONTROL_RENAME);
    expect(decoded.label).toBe("iPhone 17");
    client.dispose();
  });

  test("outbound encrypted messages are dropped before auth", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    await client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    // Note: no relay.auth.ok sent → not authenticated.
    client.sendChat("s1", "nope");
    await flushPromises();

    const pubs = ws.parsedSent().filter((m) => m.t === "relay.pub");
    expect(pubs.length).toBe(0);
    client.dispose();
  });

  test("attach triggers relay.sub and an encrypted attach message", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);

    // Reset captured frames for easier assertion.
    const before = ws.sent.length;
    client.attach("s1");
    await flushPromises();
    const after = ws.parsedSent().slice(before);

    const sub = after.find(
      (m) => m.t === "relay.sub" && (m as { sid?: string }).sid === "s1",
    );
    expect(sub).toBeDefined();

    const pub = after.find(
      (m) => m.t === "relay.pub" && (m as { sid?: string }).sid === "s1",
    ) as { ct: string } | undefined;
    expect(pub).toBeDefined();
    const decoded = JSON.parse(
      new TextDecoder().decode(await decrypt(pub!.ct, p.daemonRx)),
    );
    expect(decoded).toEqual({ t: "attach", sid: "s1" });
    client.dispose();
  });
});

describe("FrontendRelayClient — reconnect backoff", () => {
  test("schedules reconnect with exponential delay on WS close", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    // Capture setTimeout invocations for reconnect scheduling.
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    // We swap in a stub that records the delay but NEVER fires the callback,
    // so the client stays parked on each "attempt" and we can read the next
    // scheduled delay.
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      ms: number,
    ) => {
      delays.push(ms);
      // Return a fake handle shaped like NodeJS.Timeout — `clearTimeout`
      // on it is a no-op in Bun for unknown handles.
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
      // Failure cycles: WS closes without ever opening (e.g. network error,
      // TLS rejection) — `onopen` never fires, so the attempt counter
      // is never reset. Each reconnect should double.
      await client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateClose();
      expect(delays.length).toBe(1);
      expect(delays[0]).toBe(1000); // RECONNECT_BASE_MS * 2^0

      await client.connect();
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
      ws2.simulateClose();
      expect(delays.length).toBe(2);
      expect(delays[1]).toBe(2000); // RECONNECT_BASE_MS * 2^1

      await client.connect();
      const ws3 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
      ws3.simulateClose();
      expect(delays.length).toBe(3);
      expect(delays[2]).toBe(4000); // RECONNECT_BASE_MS * 2^2
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      client.dispose();
    }
  });

  test("successful auth resets the backoff counter", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      ms: number,
    ) => {
      delays.push(ms);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
      // First cycle: close without ever opening → delay=1000
      await client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateClose();
      expect(delays.at(-1)).toBe(1000);

      // Second cycle: close without opening → delay=2000
      await client.connect();
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
      ws2.simulateClose();
      expect(delays.at(-1)).toBe(2000);

      // Third cycle: socket actually opens → `onopen` resets the counter.
      // Next close (e.g. server kills connection) starts again at 1000.
      await client.connect();
      const ws3 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
      ws3.simulateOpen();
      ws3.simulateClose();
      expect(delays.at(-1)).toBe(1000);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      client.dispose();
    }
  });

  test("dispose() prevents further reconnects", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      ms: number,
    ) => {
      delays.push(ms);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
      await client.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();
      client.dispose();
      // After dispose, close events should not schedule a new reconnect.
      ws.simulateClose();
      expect(delays.length).toBe(0);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
    }
  });
});
