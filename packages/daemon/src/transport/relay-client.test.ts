import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONTROL_RENAME,
  CONTROL_UNPAIR,
  decrypt,
  deriveKxKey,
  deriveRegistrationProof,
  deriveRelayToken,
  deriveSessionKeys,
  encrypt,
  generateKeyPair,
  generatePairingSecret,
  type Label,
  makeLabel,
  RELAY_CHANNEL_CONTROL,
  type RelayClientMessage,
  type RelayServerMessage,
  type SessionRec,
  toBase64,
} from "@teleprompter/protocol";
import { RelayServer } from "../../../relay/src/relay-server";
import { RelayClient } from "./relay-client";

// Bound the WebSocket open handshake so a frontend socket that never opens
// (e.g. a relay frame delayed or dropped under a constrained CI runner) fails
// fast instead of hanging the `bun test` worker until the 10-minute GitHub
// Actions job timeout kills it.
function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws open failed"));
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

describe("RelayClient v2 (Daemon → Relay → Frontend E2E)", () => {
  let relay: RelayServer;
  let relayPort: number;
  let pairingSecret: Uint8Array;
  let relayToken: string;
  let registrationProof: string;
  const DAEMON_ID = "test-daemon";

  beforeEach(async () => {
    relay = new RelayServer();
    relayPort = relay.start(0);
    pairingSecret = await generatePairingSecret();
    relayToken = await deriveRelayToken(pairingSecret);
    registrationProof = await deriveRegistrationProof(pairingSecret);
    // Note: no registerToken() — daemon self-registers
  });

  afterEach(() => {
    relay.stop();
  });

  test("daemon self-registers, authenticates, and connects", async () => {
    const daemonKp = await generateKeyPair();

    let connected = false;
    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {
        onConnected: () => {
          connected = true;
        },
      },
    );

    await client.connect();
    await Bun.sleep(300);
    expect(connected).toBe(true);
    expect(client.isConnected()).toBe(true);
    client.dispose();
  });

  test("daemon publishes record, frontend decrypts after key exchange", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-1";
    const kxKey = await deriveKxKey(pairingSecret);

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);

    // Connect a "frontend" WebSocket to the relay
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);

    // Auth frontend
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    // Frontend performs key exchange
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    // Verify daemon has the peer
    expect(client.getPeerCount()).toBe(1);

    // Derive frontend session keys
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    // Subscribe to session
    frontendWs.send(JSON.stringify({ t: "relay.sub", sid: "session-1" }));
    await Bun.sleep(50);

    // Daemon publishes a record
    const rec: SessionRec = {
      t: "rec",
      sid: "session-1",
      seq: 1,
      k: "io",
      d: Buffer.from("Hello from daemon!").toString("base64"),
      ts: Date.now(),
    };
    client.subscribe("session-1");
    await client.publishRecord(rec);

    // Frontend receives and decrypts
    const frame = await new Promise<RelayServerMessage>((resolve, reject) => {
      frontendWs.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        if (msg.t === "relay.frame") resolve(msg);
      };
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    expect(frame.t).toBe("relay.frame");
    const ct = (frame as unknown as { ct: string }).ct;
    const plaintext = await decrypt(ct, frontendKeys.rx);
    const decrypted = JSON.parse(new TextDecoder().decode(plaintext));
    expect(decrypted.t).toBe("rec");
    expect(decrypted.sid).toBe("session-1");
    expect(Buffer.from(decrypted.d, "base64").toString()).toBe(
      "Hello from daemon!",
    );

    frontendWs.close();
    client.dispose();
  });

  test("frontend sends encrypted input, daemon receives via relay", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-2";
    const kxKey = await deriveKxKey(pairingSecret);

    let receivedInput: {
      kind: string;
      sid: string;
      data: string;
    } | null = null;

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {
        onInput: (kind, sid, data) => {
          receivedInput = { kind, sid, data };
        },
      },
    );

    await client.connect();
    client.subscribe("session-1");
    await Bun.sleep(300);

    // Connect and auth frontend
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    // Key exchange
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    // Frontend derives session keys and sends encrypted input
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );
    const inputMsg = {
      t: "in.chat",
      sid: "session-1",
      d: "Hello from frontend!",
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(inputMsg)),
      frontendKeys.tx,
    );
    frontendWs.send(
      JSON.stringify({ t: "relay.pub", sid: "session-1", ct, seq: 1 }),
    );

    await Bun.sleep(300);

    const input = receivedInput as {
      kind: string;
      sid: string;
      data: string;
    } | null;
    if (!input) throw new Error("expected receivedInput");
    expect(input.kind).toBe("chat");
    expect(input.sid).toBe("session-1");
    expect(input.data).toBe("Hello from frontend!");

    frontendWs.close();
    client.dispose();
  });

  test("sendUnpairNotice publishes encrypted control frame on control channel", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-unpair";
    const kxKey = await deriveKxKey(pairingSecret);

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);

    // Connect and auth frontend
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    // Key exchange
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    // Subscribe to the control channel so we receive the unpair frame
    frontendWs.send(
      JSON.stringify({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL }),
    );
    await Bun.sleep(50);

    // Frontend derives its session keys
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    const framePromise = new Promise<{ t: string; sid: string; ct: string }>(
      (resolve, reject) => {
        frontendWs.onmessage = (e) => {
          const msg = JSON.parse(e.data as string);
          if (msg.t === "relay.frame") resolve(msg);
        };
        setTimeout(() => reject(new Error("timeout")), 3000);
      },
    );

    const tsBefore = Date.now();
    const sent = await client.sendUnpairNotice(frontendId, "user-initiated");
    expect(sent).toBe(true);
    const frame = await framePromise;

    expect(frame.sid).toBe(RELAY_CHANNEL_CONTROL);
    const plaintext = await decrypt(frame.ct, frontendKeys.rx);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    expect(decoded.t).toBe(CONTROL_UNPAIR);
    expect(decoded.daemonId).toBe(DAEMON_ID);
    expect(decoded.frontendId).toBe(frontendId);
    expect(decoded.reason).toBe("user-initiated");
    expect(typeof decoded.ts).toBe("number");
    expect(decoded.ts).toBeGreaterThanOrEqual(tsBefore);

    frontendWs.close();
    client.dispose();
  });

  test("inbound control.unpair fires onUnpair callback", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-inbound-unpair";
    const kxKey = await deriveKxKey(pairingSecret);

    const received: Array<{ frontendId: string; reason: string }> = [];

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );
    client.onUnpair = (info) => received.push(info);

    await client.connect();
    client.subscribe(RELAY_CHANNEL_CONTROL);
    await Bun.sleep(300);

    // Connect and auth frontend
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    // Key exchange
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    // Frontend derives session keys and sends control.unpair on control channel
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );
    const unpairMsg = {
      t: CONTROL_UNPAIR,
      daemonId: DAEMON_ID,
      frontendId,
      reason: "user-initiated",
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(unpairMsg)),
      frontendKeys.tx,
    );
    frontendWs.send(
      JSON.stringify({
        t: "relay.pub",
        sid: RELAY_CHANNEL_CONTROL,
        ct,
        seq: 1,
      }),
    );

    await Bun.sleep(300);

    expect(received).toHaveLength(1);
    expect(received[0]?.frontendId).toBe(frontendId);
    expect(received[0]?.reason).toBe("user-initiated");

    frontendWs.close();
    client.dispose();
  });

  test("sendRenameNotice to a v1 peer sends a string-shaped label (version gate)", async () => {
    // This frontend's kx payload omits `v`, so the daemon reads its
    // protocolVersion as 1 (legacy). The version gate must downgrade the
    // Label union to a bare string on the wire — an un-updated app coerces an
    // object to "" and would silently clear the user's label, so the gate is
    // what prevents that data corruption.
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-rename";
    const kxKey = await deriveKxKey(pairingSecret);

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);

    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    frontendWs.send(
      JSON.stringify({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL }),
    );
    await Bun.sleep(50);

    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    const framePromise = new Promise<{ t: string; sid: string; ct: string }>(
      (resolve, reject) => {
        frontendWs.onmessage = (e) => {
          const msg = JSON.parse(e.data as string);
          if (msg.t === "relay.frame") resolve(msg);
        };
        setTimeout(() => reject(new Error("timeout")), 3000);
      },
    );

    await client.sendRenameNotice(frontendId, makeLabel("MacBook Pro 14"));
    const frame = await framePromise;

    expect(frame.sid).toBe(RELAY_CHANNEL_CONTROL);
    const plaintext = await decrypt(frame.ct, frontendKeys.rx);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    expect(decoded.t).toBe(CONTROL_RENAME);
    expect(decoded.daemonId).toBe(DAEMON_ID);
    expect(decoded.frontendId).toBe(frontendId);
    // v1 peer → bare string label on the wire (NOT the union object).
    expect(decoded.label).toBe("MacBook Pro 14");
    expect(typeof decoded.ts).toBe("number");

    frontendWs.close();
    client.dispose();
  });

  test("sendRenameNotice to a v2 peer sends the Label union object", async () => {
    // This frontend advertises `v: 2` in its kx payload, so the daemon keeps
    // the Label union on the wire (no downgrade).
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-rename-v2";
    const kxKey = await deriveKxKey(pairingSecret);

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);

    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    // kx payload advertises protocol v2 → daemon keeps the union on the wire.
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
      v: 2,
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    frontendWs.send(
      JSON.stringify({ t: "relay.sub", sid: RELAY_CHANNEL_CONTROL }),
    );
    await Bun.sleep(50);

    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    const framePromise = new Promise<{ t: string; sid: string; ct: string }>(
      (resolve, reject) => {
        frontendWs.onmessage = (e) => {
          const msg = JSON.parse(e.data as string);
          if (msg.t === "relay.frame") resolve(msg);
        };
        setTimeout(() => reject(new Error("timeout")), 3000);
      },
    );

    await client.sendRenameNotice(frontendId, makeLabel("MacBook Pro 14"));
    const frame = await framePromise;

    expect(frame.sid).toBe(RELAY_CHANNEL_CONTROL);
    const plaintext = await decrypt(frame.ct, frontendKeys.rx);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    expect(decoded.t).toBe(CONTROL_RENAME);
    expect(decoded.frontendId).toBe(frontendId);
    // v2 peer → Label union object on the wire.
    expect(decoded.label).toEqual({ set: true, value: "MacBook Pro 14" });

    frontendWs.close();
    client.dispose();
  });

  test("inbound control.rename fires onRename callback", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-inbound-rename";
    const kxKey = await deriveKxKey(pairingSecret);

    const received: Array<{ frontendId: string; label: Label }> = [];

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );
    client.onRename = (info) => received.push(info);

    await client.connect();
    client.subscribe(RELAY_CHANNEL_CONTROL);
    await Bun.sleep(300);

    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );
    // Legacy app sends a bare string label on the wire; the daemon must
    // decode it into the Label union before firing onRename.
    const renameMsg = {
      t: CONTROL_RENAME,
      daemonId: DAEMON_ID,
      frontendId,
      label: "iPhone 15",
      ts: Date.now(),
    };
    const ct = await encrypt(
      new TextEncoder().encode(JSON.stringify(renameMsg)),
      frontendKeys.tx,
    );
    frontendWs.send(
      JSON.stringify({
        t: "relay.pub",
        sid: RELAY_CHANNEL_CONTROL,
        ct,
        seq: 1,
      }),
    );

    await Bun.sleep(300);

    expect(received).toEqual([
      { frontendId, label: { set: true, value: "iPhone 15" } },
    ]);

    frontendWs.close();
    client.dispose();
  });

  test("relay cannot read plaintext (ciphertext-only)", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const wrongKp = await generateKeyPair();
    const frontendId = "test-frontend-3";
    const kxKey = await deriveKxKey(pairingSecret);

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);

    // Frontend connects, auths, and performs key exchange
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(300);

    frontendWs.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    await Bun.sleep(50);

    // Daemon publishes
    const rec: SessionRec = {
      t: "rec",
      sid: "s1",
      seq: 1,
      k: "event",
      d: Buffer.from(
        JSON.stringify({
          hook_event_name: "Stop",
          last_assistant_message: "secret!",
        }),
      ).toString("base64"),
      ts: Date.now(),
    };
    client.subscribe("s1");
    await client.publishRecord(rec);

    const frame = await new Promise<{ t: string; ct: string }>(
      (resolve, reject) => {
        frontendWs.onmessage = (e) => {
          const msg = JSON.parse(e.data as string);
          if (msg.t === "relay.frame") resolve(msg);
        };
        setTimeout(() => reject(new Error("timeout")), 3000);
      },
    );

    expect(frame.ct).toBeTruthy();
    expect(frame.ct.includes("secret!")).toBe(false);

    // Wrong key fails
    const wrongKeys = await deriveSessionKeys(
      wrongKp,
      daemonKp.publicKey,
      "frontend",
    );
    await expect(decrypt(frame.ct, wrongKeys.rx)).rejects.toThrow();

    // Correct key succeeds
    const correctKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );
    const pt = await decrypt(frame.ct, correctKeys.rx);
    const decrypted = JSON.parse(new TextDecoder().decode(pt));
    expect(decrypted.sid).toBe("s1");

    frontendWs.close();
    client.dispose();
  });

  test("reconnect uses relay.auth.resume after first auth.ok", async () => {
    const daemonKp = await generateKeyPair();
    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);
    expect(client.isConnected()).toBe(true);

    // Force a clean reconnect — connect() tears down the existing socket and
    // opens a new one. The cached resume token should drive the auth.resume
    // fast path on the second open.
    await client.connect();
    await Bun.sleep(300);
    expect(client.isConnected()).toBe(true);

    const res = await fetch(`http://localhost:${relayPort}/health`);
    const body = (await res.json()) as {
      metrics: { resumesAttempted: number; resumesAccepted: number };
    };
    expect(body.metrics.resumesAttempted).toBeGreaterThanOrEqual(1);
    expect(body.metrics.resumesAccepted).toBeGreaterThanOrEqual(1);

    client.dispose();
  });

  test("resume skips daemon kx broadcast when peers already known", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const frontendId = "test-frontend-kx-skip";
    const kxKey = await deriveKxKey(pairingSecret);

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );
    await client.connect();
    await Bun.sleep(200);

    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await waitOpen(frontendWs);
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
        frontendId,
      }),
    );
    await Bun.sleep(100);

    let kxFramesReceived = 0;
    frontendWs.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.t === "relay.kx.frame" && m.from === "daemon") {
        kxFramesReceived++;
      }
    });

    // First exchange: daemon → frontend (via daemon's auth.ok broadcast that
    // happened before the listener was attached). Send frontend → daemon kx
    // so the daemon registers this peer.
    const kxPayload = JSON.stringify({
      pk: await toBase64(frontendKp.publicKey),
      frontendId,
      role: "frontend",
    });
    const kxCt = await encrypt(new TextEncoder().encode(kxPayload), kxKey);
    frontendWs.send(
      JSON.stringify({ t: "relay.kx", ct: kxCt, role: "frontend" }),
    );
    await Bun.sleep(200);
    expect(client.getPeerCount()).toBe(1);

    // Now reconnect daemon — should resume, peers Map non-empty → skip kx.
    await client.connect();
    await Bun.sleep(400);
    expect(client.isConnected()).toBe(true);

    // No new daemon-origin kx.frame should have reached the frontend on the
    // resume path.
    expect(kxFramesReceived).toBe(0);

    frontendWs.close();
    client.dispose();
  });

  test("falls back to full auth when resume token is rejected", async () => {
    const daemonKp = await generateKeyPair();
    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        registrationProof,
        keyPair: daemonKp,
        pairingSecret,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(300);
    expect(client.isConnected()).toBe(true);

    // Restart the relay with a different secret so the cached token verifies
    // as garbage. Existing client retains its token; reconnect must fall back.
    relay.stop();
    relay = new RelayServer({ resumeSecret: "Z".repeat(64) });
    relayPort = relay.start(relayPort);
    // Re-register the token on the new server (simulates daemon's normal
    // self-registration path being available on the slow path).
    relay.registerToken(relayToken, DAEMON_ID);

    // Trigger reconnect via the client's own retry loop: close the current
    // socket from outside isn't exposed, so we just call connect() again —
    // it tears down and reopens.
    await client.connect();
    // Resume attempt → auth.err → close → schedule reconnect → full auth.
    await Bun.sleep(2000);
    expect(client.isConnected()).toBe(true);

    const res = await fetch(`http://localhost:${relayPort}/health`);
    const body = (await res.json()) as {
      metrics: { resumesAttempted: number; resumesRejected: number };
    };
    expect(body.metrics.resumesAttempted).toBeGreaterThanOrEqual(1);
    expect(body.metrics.resumesRejected).toBeGreaterThanOrEqual(1);

    client.dispose();
  });
});

describe("RelayClient.sendPush — wire field selection (back-compat)", () => {
  // A new daemon must put a real sealed blob ("tpps1.…") in the `sealed` field
  // but a legacy plaintext token in the `token` field, so an OLD relay (which
  // requires a `token` field) still accepts and delivers the push. The protocol
  // guard enforces exactly one of {token, sealed}.
  function captureSend(): {
    client: RelayClient;
    sent: RelayClientMessage[];
  } {
    const sent: RelayClientMessage[] = [];
    const client = new RelayClient(
      {
        relayUrl: "ws://localhost:0",
        daemonId: "d-test",
        token: "tok",
        registrationProof: "proof",
        keyPair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(32),
        },
        pairingSecret: new Uint8Array(32),
      },
      {},
    );
    // Inject a fake OPEN socket so the private send() path serializes the frame.
    (client as unknown as { ws: unknown }).ws = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => {
        sent.push(JSON.parse(raw) as RelayClientMessage);
      },
    };
    return { client, sent };
  }

  test("real sealed blob rides the `sealed` field, never `token`", () => {
    const { client, sent } = captureSend();
    client.sendPush("fe-1", "tpps1.1.abc123", "Title", "Body");
    expect(sent).toHaveLength(1);
    const msg = sent[0] as RelayClientMessage & { t: "relay.push" };
    expect(msg.t).toBe("relay.push");
    expect(msg.sealed).toBe("tpps1.1.abc123");
    expect(msg.token).toBeUndefined();
  });

  test("legacy plaintext token rides the `token` field (old-relay compatible)", () => {
    const { client, sent } = captureSend();
    client.sendPush("fe-1", "ExponentPushToken[legacy]", "Title", "Body");
    expect(sent).toHaveLength(1);
    const msg = sent[0] as RelayClientMessage & { t: "relay.push" };
    expect(msg.t).toBe("relay.push");
    expect(msg.token).toBe("ExponentPushToken[legacy]");
    expect(msg.sealed).toBeUndefined();
  });
});
