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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// secure-storage.ts (transitively imported by relay-client) reads
// `Platform.OS` and may `require("expo-secure-store")`. Bun has no native
// `react-native` module, so we mock both before importing the SUT. The
// SUT (relay-client) is loaded via dynamic import below — static imports
// would be hoisted above these mock.module() calls.
mock.module("react-native", () => ({ Platform: { OS: "web" } }));
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

// In-memory localStorage shim for secure-storage's web branch (used to
// inspect cached resume tokens in the resume tests below).
const fakeStorage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => fakeStorage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    fakeStorage.set(k, String(v));
  },
  removeItem: (k: string) => {
    fakeStorage.delete(k);
  },
  clear: () => {
    fakeStorage.clear();
  },
  get length() {
    return fakeStorage.size;
  },
  key: (i: number) => Array.from(fakeStorage.keys())[i] ?? null,
};

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
  type Label,
  type RelayServerMessage,
  ratchetSessionKeys,
  toBase64,
  WS_PROTOCOL_VERSION,
} from "@teleprompter/protocol/client";

// Dynamic import — evaluated AFTER mocks are registered. Static imports
// would be hoisted above the mock.module() calls.
const relayClientModule = await import("./relay-client");
const { FrontendRelayClient } = relayClientModule;
type FrontendRelayClient = InstanceType<typeof FrontendRelayClient>;
type FrontendRelayConfig = ConstructorParameters<typeof FrontendRelayClient>[0];

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
  // The real relay always stamps daemonId on auth.ok (relay-server.ts
  // buildAuthOk); the parseRelayServerMessage guard now enforces it, so the
  // fixture must match what production sends.
  ws.simulateMessage({
    t: "relay.auth.ok",
    daemonId: "daemon-test",
  } as RelayServerMessage);
  // sendKeyExchange() is async (encrypt is async) — flush microtasks.
  await flushPromises();
  return ws;
}

/**
 * Yield to the event loop a few times to let pending promise chains resolve.
 * The default tick count is generous because `ensureSodium()` (memoized in
 * `packages/protocol/src/crypto.ts` as of v0.1.38) wraps `require` + `await
 * s.ready` in an extra promise, so the wire-log inspections in these tests
 * need a handful of microtasks past the encrypt call to settle.
 */
async function flushPromises(ticks = 20): Promise<void> {
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
  warnCalls: unknown[][];
  restore: () => void;
} {
  const origError = console.error;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const errorCalls: unknown[][] = [];
  const debugCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  console.debug = (...args: unknown[]) => {
    debugCalls.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  return {
    errorCalls,
    debugCalls,
    warnCalls,
    restore: () => {
      console.error = origError;
      console.debug = origDebug;
      console.warn = origWarn;
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
    // The frontend advertises its protocol version so the daemon can decide
    // whether to send the `Label` tagged union or a legacy string on
    // ControlRename. An un-updated app omits `v` → daemon treats it as v1.
    expect(decoded.v).toBe(WS_PROTOCOL_VERSION);

    client.dispose();
  });

  test("onConnected fires *after* kx so first encrypted frame is decryptable", async () => {
    // Regression: previously `onConnected` fired synchronously inside the
    // `relay.auth.ok` branch BEFORE `sendKeyExchange()` completed. Subscribers
    // wire `onConnected` into React state (`useAnyRelayConnected`); the
    // ChatView's `resume(sid, 0)` effect fires reactively on `connected →
    // true` and reaches `sendEncrypted()` while `authenticated=true` and
    // `sessionKeys` is set — so the gate at the top of `sendEncrypted`
    // didn't park the frame, it shipped immediately. Daemon hadn't received
    // the frontend pubkey yet (kx still in-flight) so no FrontendPeer
    // existed: the daemon silently dropped the first encrypted frame and
    // the user's first chat send went into a void. Pin the ordering so the
    // wire log proves kx is on the wire before any subscriber-driven
    // encrypted frame.
    const p = await setupPairing();
    let onConnectedCallIndex = -1;
    const client = new FrontendRelayClient(makeConfig(p), {
      onConnected: () => {
        const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        onConnectedCallIndex = ws ? ws.sent.length : -1;
      },
    });

    const ws = await authenticate(client);

    // Find the index of the relay.kx frame in the wire log.
    const kxIndex = ws
      .parsedSent()
      .findIndex((m) => (m as { t: string }).t === "relay.kx");
    expect(kxIndex).toBeGreaterThanOrEqual(0);

    // onConnected must have fired AFTER the kx frame was flushed onto the
    // wire — kxIndex < onConnectedCallIndex. Anything callable from
    // onConnected sees an authenticated + kx-completed connection and can
    // safely call sendEncrypted without the daemon dropping the frame.
    expect(onConnectedCallIndex).toBeGreaterThan(kxIndex);

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

  test("relay.frame with missing sid is dropped at the boundary guard", async () => {
    // A relay.frame with no sid violates the RelayFrame protocol type (sid is
    // a required string). parseRelayServerMessage now rejects it at the
    // onmessage boundary, so it never reaches handleFrame/decrypt: no decrypt
    // is attempted, nothing is logged, and onError stays silent. This is
    // strictly safer than the prior behavior (where the malformed frame
    // reached the decrypt catch and surfaced a console.error) — the zero-trust
    // guard refuses the frame before any handler dereferences its fields.
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
        // sid intentionally omitted — rejected by the guard
        ct: "AAAAAAAAAAAAAA",
        seq: 1,
        from: "daemon",
      } as unknown as RelayServerMessage);
      await flushPromises();

      // Dropped at the boundary: no decrypt-path error, no debug, no onError.
      expect(relayCalls(spy.errorCalls)).toEqual([]);
      expect(relayCalls(spy.debugCalls)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      spy.restore();
      client.dispose();
    }
  });

  test("a decrypted-but-malformed session frame is dropped by parseSessionServerMessage", async () => {
    // A frame that decrypts cleanly (correct session key) but whose plaintext
    // is a malformed `rec` (no `ts`) must NOT reach onRec. The boundary guard
    // (parseRelayServerMessage) accepts the relay.frame envelope, but the inner
    // session-data guard (parseSessionServerMessage) rejects the under-specified
    // payload and drops it with a warn. Without the guard, the old blind
    // `JSON.parse(...) as SessionRec` cast would have emitted the bad record to
    // onRec — this test pins the drop.
    const p = await setupPairing();
    const recs: unknown[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onRec: (r) => recs.push(r),
    });
    const spy = captureConsole();

    try {
      const ws = await authenticate(client);

      // Encrypt a rec MISSING the required `ts` field with the real session
      // key, so AEAD verifies and decrypt succeeds — the failure is purely the
      // shape, which only the session-data guard catches.
      const malformed = { t: "rec", sid: "s1", seq: 3, k: "io", d: btoa("x") };
      const ct = await encrypt(
        new TextEncoder().encode(JSON.stringify(malformed)),
        p.daemonTx,
      );
      ws.simulateMessage({
        t: "relay.frame",
        sid: "s1",
        ct,
        seq: 3,
        from: "daemon",
      } as RelayServerMessage);
      await flushPromises();

      // The malformed record never reaches the handler...
      expect(recs).toEqual([]);
      // ...and the guard logs the drop (no decrypt error — decrypt succeeded).
      const warns = relayCalls(spy.warnCalls).map((c) => c[0]);
      expect(
        warns.some(
          (w) =>
            typeof w === "string" && w.includes("dropped malformed session"),
        ),
      ).toBe(true);
      expect(relayCalls(spy.errorCalls)).toEqual([]);
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

  // Helper: encrypt+deliver a control.rename frame carrying an arbitrary
  // `label` wire value (legacy string, union object, or malformed) so the
  // decode path in handleFrame's CONTROL_RENAME case can be exercised.
  async function deliverRename(
    p: Awaited<ReturnType<typeof setupPairing>>,
    ws: Awaited<ReturnType<typeof authenticate>>,
    label: unknown,
  ): Promise<void> {
    const msg = {
      t: CONTROL_RENAME,
      daemonId: "daemon-test",
      frontendId: "frontend-test",
      label,
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
  }

  test("control.rename with a legacy string label fires onRename (decoded to union)", async () => {
    const p = await setupPairing();
    const received: Array<{ daemonId: string; label: Label }> = [];
    const client = new FrontendRelayClient(makeConfig(p));
    client.onRename = (info) => received.push(info);

    const ws = await authenticate(client);
    // A v1 daemon (or one talking down to an older app) sends a bare string.
    await deliverRename(p, ws, "Home Mac");

    expect(received).toEqual([
      { daemonId: "daemon-test", label: { set: true, value: "Home Mac" } },
    ]);
    client.dispose();
  });

  test("control.rename with a { set: true } union label fires onRename", async () => {
    const p = await setupPairing();
    const received: Array<{ daemonId: string; label: Label }> = [];
    const client = new FrontendRelayClient(makeConfig(p));
    client.onRename = (info) => received.push(info);

    const ws = await authenticate(client);
    // A v2 daemon sends the tagged union directly.
    await deliverRename(p, ws, { set: true, value: "Office Mac" });

    expect(received).toEqual([
      { daemonId: "daemon-test", label: { set: true, value: "Office Mac" } },
    ]);
    client.dispose();
  });

  test("control.rename with a { set: false } union label is an authoritative clear (no silent-clear regression)", async () => {
    // The data-corruption bug this migration fixes: the old code did
    // `typeof msg.label === "string" ? msg.label : ""`, which coerced a union
    // object to "" — turning an *unrelated* message into a label wipe. With
    // `decodeWireLabel`, a `{ set: false }` is a deliberate clear and a
    // `{ set: true }` is preserved as-is, never silently flattened.
    const p = await setupPairing();
    const received: Array<{ daemonId: string; label: Label }> = [];
    const client = new FrontendRelayClient(makeConfig(p));
    client.onRename = (info) => received.push(info);

    const ws = await authenticate(client);
    await deliverRename(p, ws, { set: false });

    expect(received).toEqual([
      { daemonId: "daemon-test", label: { set: false } },
    ]);
    client.dispose();
  });
});

// ── H8 / M26 regression tests ─────────────────────────────────────────────
//
// H8: handleMessage() was called without await/void so exceptions from
//     sendKeyExchange/encrypt became silently-swallowed unhandled rejections.
//     On relay.auth.ok if encrypt throws, `authenticated` stayed true but
//     onConnected never fired and flushPendingEncrypted never ran — daemon
//     never got kx, all encrypted sends silently dropped while isConnected()
//     returned true.
//
// M26: When the socket closed while sendKeyExchange() was awaiting, onConnected
//     fired AFTER onDisconnected because the post-await code didn't check
//     whether the connection was still live (inverted event ordering).

describe("FrontendRelayClient — H8/M26: auth pipeline failure and ordering", () => {
  test("H8: if sendKeyExchange throws on relay.auth.ok, client is NOT reported connected", async () => {
    const p = await setupPairing();
    let connected = false;
    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onConnected: () => {
        connected = true;
      },
      onError: (e) => errors.push(e),
    });

    // Pin reconnect so force-close doesn't re-arm a new socket.
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      _ms: number,
    ) =>
      0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;

    const spy = captureConsole();
    try {
      await client.connect();
      const ws = latestWs();
      ws.simulateOpen();

      // Sabotage kxKey so sendKeyExchange's encrypt call will throw by
      // substituting a too-short key (encrypt requires exactly 32 bytes).
      // We reach into the private field via type cast to inject the fault.
      (client as unknown as { kxKey: Uint8Array }).kxKey = new Uint8Array(4); // wrong length → encrypt throws

      // Send auth.ok — this should trigger the sabotaged sendKeyExchange.
      ws.simulateMessage({ t: "relay.auth.ok", daemonId: "daemon-test" } as RelayServerMessage);
      await flushPromises(30);

      // The client must NOT report itself as connected after kx failure.
      expect(connected).toBe(false);
      expect(client.isConnected()).toBe(false);
      // The error must have been logged (not silently swallowed).
      const handleMessageErrors = spy.errorCalls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("[FrontendRelay]"),
      );
      expect(handleMessageErrors.length).toBeGreaterThan(0);
    } finally {
      spy.restore();
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
      client.dispose();
    }
  });

  test("M26: onConnected does NOT fire after onDisconnected when socket closes during kx", async () => {
    const p = await setupPairing();
    const eventLog: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onConnected: () => eventLog.push("connected"),
      onDisconnected: () => eventLog.push("disconnected"),
    });

    // Pin reconnect timer so the close doesn't immediately re-arm.
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      _ms: number,
    ) =>
      0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;

    try {
      await client.connect();
      const ws = latestWs();
      ws.simulateOpen();

      // Install a hook that closes the socket mid-way through sendKeyExchange
      // by intercepting the relay.kx send: at the moment kx is flushed onto
      // the wire we know encrypt completed, meaning we're between the two
      // awaits in the auth.ok branch. Simulate the socket closing immediately
      // after kx is sent (race: server closes connection while we're awaiting).
      const origSend = ws.send.bind(ws);
      let kxSent = false;
      ws.send = (data: string) => {
        origSend(data);
        const parsed = JSON.parse(data) as { t?: string };
        if (parsed.t === "relay.kx" && !kxSent) {
          kxSent = true;
          // Force-close the socket — this fires ws.onclose synchronously
          // inside MockWebSocket.close(), which sets authenticated=false and
          // emits onDisconnected. The remaining post-await code in handleMessage
          // must detect the epoch mismatch and NOT emit onConnected.
          ws.simulateClose();
        }
      };

      ws.simulateMessage({ t: "relay.auth.ok", daemonId: "daemon-test" } as RelayServerMessage);
      // Give plenty of microtasks for the async pipeline to settle.
      await flushPromises(40);

      // onDisconnected must have fired (socket closed).
      expect(eventLog).toContain("disconnected");
      // onConnected must NOT fire after onDisconnected.
      const connIdx = eventLog.lastIndexOf("connected");
      const discIdx = eventLog.lastIndexOf("disconnected");
      // Either onConnected never fired, OR it fired before onDisconnected (correct order).
      // The regression was onConnected firing AFTER onDisconnected.
      if (connIdx !== -1 && discIdx !== -1) {
        expect(connIdx).toBeLessThan(discIdx);
      }
      // Client must not report itself connected.
      expect(client.isConnected()).toBe(false);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
      client.dispose();
    }
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
    // The wire field is the `Label` tagged union — sendRenameNotice wraps the
    // string arg with makeLabel before encrypting.
    expect(decoded.label).toEqual({ set: true, value: "iPhone 17" });
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
    ws.simulateMessage({ t: "relay.auth.ok", daemonId: "daemon-test" });
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
    ws.simulateMessage({ t: "relay.auth.ok", daemonId: "daemon-test" });
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
    ws.simulateMessage({ t: "relay.auth.ok", daemonId: "daemon-test" });
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
    expect(renameDecoded.label).toEqual({ set: true, value: "My Mac" });
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
      ws2.simulateMessage({ t: "relay.auth.ok", daemonId: "daemon-test-2" });
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

describe("FrontendRelayClient — resume token", () => {
  beforeEach(() => {
    fakeStorage.clear();
  });

  test("auth.ok caches rolling token and persists to localStorage", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));

    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();
    ws.simulateMessage({
      t: "relay.auth.ok",
      daemonId: "daemon-test",
      resumeToken: "tok-1",
      resumeExpiresAt: Date.now() + 60_000,
    } as RelayServerMessage);
    await flushPromises(20);

    // Persisted under the relay_resume_<daemonId> key with the tp_ prefix.
    const stored = fakeStorage.get("tp_relay_resume_daemon-test");
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as {
      token: string;
      expiresAt: number;
    };
    expect(parsed.token).toBe("tok-1");
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());

    client.dispose();
  });

  test("subsequent connect uses relay.auth.resume when token is cached", async () => {
    const p = await setupPairing();
    fakeStorage.set(
      "tp_relay_resume_daemon-test",
      JSON.stringify({ token: "cached-tok", expiresAt: Date.now() + 60_000 }),
    );

    const client = new FrontendRelayClient(makeConfig(p));
    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();

    const sent = ws.findSent<{ t: string; token: string; v: number }>(
      "relay.auth.resume",
    );
    expect(sent).toBeDefined();
    expect(sent?.token).toBe("cached-tok");
    expect(sent?.v).toBe(1);

    // Slow-path relay.auth must NOT have been sent.
    expect(ws.findSent("relay.auth")).toBeUndefined();

    client.dispose();
  });

  test("resume happy path skips kx (auth.ok with resumed=true)", async () => {
    const p = await setupPairing();
    fakeStorage.set(
      "tp_relay_resume_daemon-test",
      JSON.stringify({ token: "cached-tok", expiresAt: Date.now() + 60_000 }),
    );

    const client = new FrontendRelayClient(makeConfig(p));
    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();

    ws.simulateMessage({
      t: "relay.auth.ok",
      daemonId: "daemon-test",
      resumed: true,
      resumeToken: "tok-2",
      resumeExpiresAt: Date.now() + 60_000,
    } as RelayServerMessage);
    await settleAuthPipeline();

    // No relay.kx sent on the resumed path — daemon already has our pubkey.
    expect(ws.findSent("relay.kx")).toBeUndefined();
    // Rolling token replaces the cached one.
    const stored = fakeStorage.get("tp_relay_resume_daemon-test");
    const parsed = JSON.parse(stored as string) as { token: string };
    expect(parsed.token).toBe("tok-2");

    client.dispose();
  });

  test("auth.err during resume drops cached token and closes for retry", async () => {
    const p = await setupPairing();
    fakeStorage.set(
      "tp_relay_resume_daemon-test",
      JSON.stringify({ token: "stale-tok", expiresAt: Date.now() + 60_000 }),
    );

    const errors: string[] = [];
    const client = new FrontendRelayClient(makeConfig(p), {
      onError: (e) => errors.push(e),
    });
    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();
    // Confirm we attempted resume.
    expect(ws.findSent("relay.auth.resume")).toBeDefined();

    ws.simulateMessage({
      t: "relay.auth.err",
      e: "resume token invalid",
    } as RelayServerMessage);
    await flushPromises(20);

    // Rejected resume must NOT bubble up as a fatal error.
    expect(errors.length).toBe(0);
    // Cached token cleared from storage so the next reconnect uses the slow
    // path.
    expect(fakeStorage.get("tp_relay_resume_daemon-test")).toBeUndefined();
    // WS was closed so the reconnect path can re-open with full auth.
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    client.dispose();
  });

  test("expired cached token is purged and slow auth is used", async () => {
    const p = await setupPairing();
    fakeStorage.set(
      "tp_relay_resume_daemon-test",
      JSON.stringify({ token: "old-tok", expiresAt: Date.now() - 1000 }),
    );

    const client = new FrontendRelayClient(makeConfig(p));
    await client.connect();
    const ws = latestWs();
    ws.simulateOpen();

    // Expired token must not be sent.
    expect(ws.findSent("relay.auth.resume")).toBeUndefined();
    // Full auth path took over.
    expect(ws.findSent("relay.auth")).toBeDefined();
    // Storage entry was cleaned up.
    await flushPromises(5);
    expect(fakeStorage.get("tp_relay_resume_daemon-test")).toBeUndefined();

    client.dispose();
  });
});

/**
 * Regression: a frontend that loses its network without a clean TCP FIN
 * (mobile sleep, captive portal, Wi-Fi handoff) used to wait the full 90s
 * relay-side idle timeout before noticing the disconnect — meaning the UI
 * sat in a "connected, just slow" state while sends silently piled up. The
 * client now drives its own relay.ping cadence and force-closes when too
 * many pongs go missing, so onDisconnected fires within ~30s.
 */
describe("FrontendRelayClient — client-side ping", () => {
  type FakeIntervalEntry = {
    handle: number;
    callback: () => void;
    ms: number;
  };
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;
  let intervals: FakeIntervalEntry[];
  let nextHandle: number;

  beforeEach(() => {
    intervals = [];
    nextHandle = 1;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval =
      ((cb: () => void, ms: number) => {
        const handle = nextHandle++;
        intervals.push({ handle, callback: cb, ms });
        return handle as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval;
    (
      globalThis as unknown as { clearInterval: typeof clearInterval }
    ).clearInterval = ((handle: number) => {
      intervals = intervals.filter((e) => e.handle !== handle);
    }) as unknown as typeof clearInterval;
  });

  afterEach(() => {
    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval =
      originalSetInterval;
    (
      globalThis as unknown as { clearInterval: typeof clearInterval }
    ).clearInterval = originalClearInterval;
  });

  function pingTimer(): FakeIntervalEntry {
    // The ping interval is the only setInterval the client arms today —
    // be specific by interval duration so this stays robust if other
    // timers get added later.
    const entry = intervals.find((e) => e.ms === 15_000);
    if (!entry) throw new Error("expected a 15s setInterval (relay ping)");
    return entry;
  }

  test("starts a 15s ping interval after auth.ok and sends relay.ping ticks", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);

    const timer = pingTimer();
    const beforeCount = ws
      .parsedSent()
      .filter((m) => m.t === "relay.ping").length;
    expect(beforeCount).toBe(0);

    timer.callback();
    const afterOne = ws.parsedSent().filter((m) => m.t === "relay.ping");
    expect(afterOne.length).toBe(1);
    expect(typeof (afterOne[0] as { ts?: unknown }).ts).toBe("number");

    // A relay.pong resets the missed counter, so subsequent ticks keep
    // emitting pings rather than tripping the force-close.
    ws.simulateMessage({
      t: "relay.pong",
      ts: Date.now(),
    } as unknown as RelayServerMessage);
    timer.callback();
    expect(ws.parsedSent().filter((m) => m.t === "relay.ping").length).toBe(2);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    client.dispose();
  });

  test("force-closes the socket after too many missed pongs", async () => {
    const p = await setupPairing();
    let disconnects = 0;
    const client = new FrontendRelayClient(makeConfig(p), {
      onDisconnected: () => {
        disconnects += 1;
      },
    });

    // Pin reconnect so the force-close doesn't immediately re-arm a fresh
    // socket and another ping timer behind our back.
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _cb: () => void,
      _ms: number,
    ) =>
      0 as unknown as ReturnType<
        typeof setTimeout
      >) as unknown as typeof setTimeout;

    try {
      const ws = await authenticate(client);
      const timer = pingTimer();

      // Three ticks without any pong: the first two send pings, the third
      // exceeds RELAY_MAX_MISSED_PONGS (=2) and force-closes.
      timer.callback();
      timer.callback();
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      expect(disconnects).toBe(0);

      timer.callback();
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      expect(disconnects).toBe(1);
      // The 3rd tick is the threshold breach — no ping should be on the
      // wire from that tick, only the prior two.
      expect(ws.parsedSent().filter((m) => m.t === "relay.ping").length).toBe(
        2,
      );
      // Timer must be cleared once we tripped the force-close.
      expect(intervals.some((e) => e.ms === 15_000)).toBe(false);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      client.dispose();
    }
  });

  test("clearing happens on natural close and on dispose", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);
    expect(intervals.some((e) => e.ms === 15_000)).toBe(true);

    ws.simulateClose();
    expect(intervals.some((e) => e.ms === 15_000)).toBe(false);

    // dispose after a clean close must stay idempotent.
    client.dispose();
    expect(intervals.some((e) => e.ms === 15_000)).toBe(false);
  });

  test("getRtt() returns { measured: false } on a fresh client before any pong", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    // No connect, no pong — the initial state must be unmeasured.
    expect(client.getRtt()).toEqual({ measured: false });
    client.dispose();
  });

  test("getRtt() returns { measured: true, ms: N } after a ping/pong cycle", async () => {
    const p = await setupPairing();
    const client = new FrontendRelayClient(makeConfig(p));
    const ws = await authenticate(client);

    // Simulate a ping then a pong carrying the response.
    client.ping();
    // Brief wait so Date.now() inside ping() is fixed before pong arrives.
    await flushPromises(2);

    // Deliver an application-level pong from the daemon (session "pong" msg).
    const pongMsg = { t: "pong", sid: "__session__", seq: 0, ts: Date.now() };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(pongMsg)),
      p.daemonTx,
    );
    ws.simulateMessage({
      t: "relay.frame",
      sid: "__session__",
      ct,
      seq: 0,
      from: "daemon",
    } as RelayServerMessage);
    await flushPromises();

    const rtt = client.getRtt();
    expect(rtt.measured).toBe(true);
    if (rtt.measured) {
      expect(typeof rtt.ms).toBe("number");
      expect(rtt.ms).toBeGreaterThanOrEqual(0);
    }
    client.dispose();
  });
});
