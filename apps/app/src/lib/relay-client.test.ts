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

/**
 * Swap in `console.error` / `console.debug` spies so tests can assert on
 * what the SUT logged without polluting the test runner's stdout. The
 * returned `restore()` must be called in a `finally` so globals are
 * reinstated even if an assertion throws.
 */
function captureConsole(): {
  errorCalls: unknown[][];
  debugCalls: unknown[][];
  restore: () => void;
} {
  const origError = console.error;
  const origDebug = console.debug;
  const errorCalls: unknown[][] = [];
  const debugCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  console.debug = (...args: unknown[]) => {
    debugCalls.push(args);
  };
  return {
    errorCalls,
    debugCalls,
    restore: () => {
      console.error = origError;
      console.debug = origDebug;
    },
  };
}

/** Filter captured console calls to those originating from FrontendRelayClient. */
function relayCalls(calls: unknown[][]): unknown[][] {
  return calls.filter(
    (call) =>
      typeof call[0] === "string" &&
      (call[0] as string).includes("[FrontendRelay]"),
  );
}

/**
 * Yield enough microtasks for the full auth.ok pipeline to settle:
 * handleMessage (async) → sendKeyExchange (async encrypt) →
 * flushPendingEncrypted (one async encrypt per queued frame) → auto-resume.
 *
 * `frameCount` is the number of queued frames expected to flush; each adds
 * roughly one encrypt's worth of microtask depth. The 20-tick base covers
 * the non-flush stages with headroom.
 */
async function settleAuthPipeline(frameCount = 0): Promise<void> {
  const perFrameTicks = 5;
  await flushPromises(20 + frameCount * perFrameTicks);
}

/** Return the most recently constructed MockWebSocket or throw. */
function latestWs(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no MockWebSocket constructed yet");
  return ws;
}

/** Extract a relay.pub frame by sid, asserting it exists. */
function expectPub(
  ws: MockWebSocket,
  sid: string,
): { t: string; sid: string; ct: string; seq: number } {
  const pub = ws
    .parsedSent()
    .find((m) => m.t === "relay.pub" && (m as { sid?: string }).sid === sid);
  if (!pub) throw new Error(`no relay.pub on sid=${sid}`);
  return pub as { t: string; sid: string; ct: string; seq: number };
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

    const spy = captureConsole();
    try {
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
    } finally {
      spy.restore();
      client.dispose();
    }
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
    const spy = captureConsole();

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
      expect(relayCalls(spy.errorCalls)).toEqual([]);
      // Should be logged as console.debug instead (quiet).
      expect(relayCalls(spy.debugCalls).length).toBe(1);
      expect(client.isConnected()).toBe(true);
    } finally {
      spy.restore();
      client.dispose();
    }
  });

  test("15-frontend broadcast produces N-1 debug logs and zero errors", async () => {
    // Reproduction of the original QA scenario: daemon sent control.unpair
    // to 15 paired frontends, so this frontend received 14 undecryptable
    // frames on __control__ plus its own (which we don't simulate here to
    // keep the test focused on the wrong-key path). Each of the 14 should
    // produce exactly one debug log and zero errors.
    const p = await setupPairing();
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });
    const spy = captureConsole();

    try {
      const ws = await authenticate(client);

      const N = 14;
      for (let i = 0; i < N; i++) {
        ws.simulateMessage({
          t: "relay.frame",
          sid: "__control__",
          ct: "AAAAAAAAAAAAAA",
          seq: i + 1,
          from: "daemon",
        } as RelayServerMessage);
      }
      await flushPromises();

      expect(errors).toEqual([]);
      expect(relayCalls(spy.errorCalls)).toEqual([]);
      expect(relayCalls(spy.debugCalls).length).toBe(N);
    } finally {
      spy.restore();
      client.dispose();
    }
  });

  test("decrypt fail on __meta__ sid is also demoted to debug", async () => {
    // __meta__ is the other broadcast-plane channel; mirrors the
    // __control__ treatment so a future meta-broadcast feature doesn't
    // regress the toast noise.
    const p = await setupPairing();
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });
    const spy = captureConsole();

    try {
      const ws = await authenticate(client);
      ws.simulateMessage({
        t: "relay.frame",
        sid: "__meta__",
        ct: "AAAAAAAAAAAAAA",
        seq: 1,
        from: "daemon",
      } as RelayServerMessage);
      await flushPromises();

      expect(errors).toEqual([]);
      expect(relayCalls(spy.errorCalls)).toEqual([]);
      expect(relayCalls(spy.debugCalls).length).toBe(1);
    } finally {
      spy.restore();
      client.dispose();
    }
  });

  test("decrypt fail with missing sid falls through to error path", async () => {
    // Malformed frames (sid undefined/empty) are a real anomaly — the
    // RelayFrame protocol type declares sid as a required string. The
    // guard compares against specific sentinel strings, so undefined
    // correctly falls through to console.error.
    const p = await setupPairing();
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });
    const spy = captureConsole();

    try {
      const ws = await authenticate(client);

      ws.simulateMessage({
        t: "relay.frame",
        // sid intentionally omitted
        ct: "AAAAAAAAAAAAAA",
        seq: 1,
        from: "daemon",
      } as unknown as RelayServerMessage);
      await flushPromises();

      expect(relayCalls(spy.errorCalls).length).toBe(1);
      expect(relayCalls(spy.debugCalls)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      spy.restore();
      client.dispose();
    }
  });

  test("decrypt fail on non-control sid still logs as error and skips onError", async () => {
    // Non-broadcast sids are real anomalies (tampered frame, key mismatch,
    // protocol bug). Keep them loud on console.error. onError should NOT
    // fire from the decrypt catch today; lock that invariant so a future
    // refactor doesn't accidentally re-route decrypt failures into toasts.
    const p = await setupPairing();
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });
    const spy = captureConsole();

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

      const errorCalls = relayCalls(spy.errorCalls).filter(
        (call) =>
          typeof call[0] === "string" &&
          (call[0] as string).includes("decrypt failed"),
      );
      expect(errorCalls.length).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      spy.restore();
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

  test("outbound encrypted messages are queued before auth, not sent", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    await client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    // Note: no relay.auth.ok sent → not authenticated.
    client.sendChat("s1", "nope");
    await flushPromises();

    // Nothing on the wire yet — queued in pendingEncrypted.
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

describe("FrontendRelayClient — pending-encrypted queue", () => {
  /**
   * Regression: ChatView's ~500ms resume-on-mount timer used to race the
   * relay key-exchange handshake. On a cold session URL open, the frame
   * landed in sendEncrypted() before `authenticated` flipped, and was
   * silently dropped, leaving Chat/Terminal blank. Now those frames park
   * in a bounded queue and flush once auth.ok fires (after kx).
   */
  test("frames sent before auth are flushed once auth.ok arrives", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();

    // Simulate ChatView's early resume: fires before relay.auth.ok.
    client.resume("s1", 0);
    await flushPromises();

    // Nothing encrypted is on the wire yet — queued, not dropped.
    expect(ws.parsedSent().filter((m) => m.t === "relay.pub").length).toBe(0);

    // Complete the handshake.
    ws.simulateMessage({ t: "relay.auth.ok" });
    await settleAuthPipeline(1);

    // The queued resume is now flushed to the daemon.
    const pub = expectPub(ws, "s1");
    const decoded = JSON.parse(
      new TextDecoder().decode(await decrypt(pub.ct, p.daemonRx)),
    );
    expect(decoded).toEqual({ t: "resume", sid: "s1", c: 0 });
    client.dispose();
  });

  test("queue is capped at MAX_PENDING_ENCRYPTED, oldest dropped", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();

    // Overfill by 5 so we can observe the oldest-drop behavior.
    const overflow = 5;
    const cap = 32;
    for (let i = 0; i < cap + overflow; i++) {
      client.sendChat(`s${i}`, `msg-${i}`);
    }
    await flushPromises();

    // Still nothing on the wire — all parked in queue.
    expect(ws.parsedSent().filter((m) => m.t === "relay.pub").length).toBe(0);

    // Authenticate → queue drains. Because we overflowed by `overflow`,
    // the first `overflow` sends (sid=s0..s4) were dropped; the remaining
    // cap frames (sid=s5..s36) should arrive in order.
    ws.simulateMessage({ t: "relay.auth.ok" });
    await settleAuthPipeline(cap);

    const pubs = ws.parsedSent().filter((m) => m.t === "relay.pub") as Array<{
      sid: string;
      ct: string;
    }>;
    expect(pubs.length).toBe(cap);

    const first = pubs[0];
    const last = pubs[pubs.length - 1];
    if (!first || !last) throw new Error("expected flush to produce frames");

    const firstDecoded = JSON.parse(
      new TextDecoder().decode(await decrypt(first.ct, p.daemonRx)),
    );
    expect(firstDecoded).toEqual({
      t: "in.chat",
      sid: `s${overflow}`,
      d: `msg-${overflow}`,
    });

    const lastDecoded = JSON.parse(
      new TextDecoder().decode(await decrypt(last.ct, p.daemonRx)),
    );
    expect(lastDecoded).toEqual({
      t: "in.chat",
      sid: `s${cap + overflow - 1}`,
      d: `msg-${cap + overflow - 1}`,
    });
    client.dispose();
  });

  test("sendPushToken/sendUnpairNotice/sendRenameNotice also queue pre-auth", async () => {
    // Push-token, unpair, and rename notices previously had their own
    // silent `if (!authenticated) return` drops. They now funnel through
    // sendEncrypted() so they share the same queue semantics as resume().
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();
    // Pre-auth: queue three different sender types.
    await client.sendPushToken("expo-token-xyz", "ios");
    await client.sendUnpairNotice("user-initiated");
    await client.sendRenameNotice("My Mac");
    await flushPromises();
    // Nothing on the wire yet.
    expect(ws.parsedSent().filter((m) => m.t === "relay.pub").length).toBe(0);

    // Authenticate → queue drains.
    ws.simulateMessage({ t: "relay.auth.ok" });
    await settleAuthPipeline(3);

    const pubs = ws.parsedSent().filter((m) => m.t === "relay.pub") as Array<{
      t: string;
      sid: string;
      ct: string;
    }>;
    expect(pubs.length).toBe(3);

    // Channel routing is preserved: push-token goes to __meta__, the two
    // control notices to __control__.
    expect(pubs.map((p2) => p2.sid)).toEqual([
      "__meta__",
      "__control__",
      "__control__",
    ]);

    const [pushPub, unpairPub, renamePub] = pubs;
    if (!pushPub || !unpairPub || !renamePub) {
      throw new Error("expected three flushed frames");
    }

    const pushDecoded = JSON.parse(
      new TextDecoder().decode(await decrypt(pushPub.ct, p.daemonRx)),
    );
    expect(pushDecoded).toEqual({
      t: "pushToken",
      token: "expo-token-xyz",
      platform: "ios",
    });

    const unpairDecoded = JSON.parse(
      new TextDecoder().decode(await decrypt(unpairPub.ct, p.daemonRx)),
    );
    expect(unpairDecoded.t).toBe(CONTROL_UNPAIR);
    expect(unpairDecoded.reason).toBe("user-initiated");

    const renameDecoded = JSON.parse(
      new TextDecoder().decode(await decrypt(renamePub.ct, p.daemonRx)),
    );
    expect(renameDecoded.t).toBe(CONTROL_RENAME);
    expect(renameDecoded.label).toBe("My Mac");
    client.dispose();
  });

  test("queue is cleared on WS close before auth.ok", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    // Stub setTimeout so scheduleReconnect() doesn't spawn a third
    // MockWebSocket behind our back during this test. Matches the pattern
    // used by the "reconnect backoff" describe block below.
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      _ms: number,
    ) =>
      0 as unknown as ReturnType<
        typeof setTimeout
      >) as unknown as typeof setTimeout;

    try {
      await client.connect();
      const ws1 = latestWs();
      ws1.simulateOpen();
      // Queue a frame before auth.
      client.sendChat("s1", "queued");
      await flushPromises();

      // Socket closes before auth ever completes.
      ws1.simulateClose();
      await flushPromises();

      // Reconnect + authenticate a fresh socket. The old queued frame
      // should NOT be resurrected — it was tied to the previous connection
      // cycle. Callers (ChatView, auto-resume path) are responsible for
      // re-issuing their state on the new cycle.
      await client.connect();
      const ws2 = latestWs();
      ws2.simulateOpen();
      ws2.simulateMessage({ t: "relay.auth.ok" });
      await settleAuthPipeline(0);

      const pubs = ws2
        .parsedSent()
        .filter(
          (m) => m.t === "relay.pub" && (m as { sid?: string }).sid === "s1",
        );
      expect(pubs.length).toBe(0);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      client.dispose();
    }
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
