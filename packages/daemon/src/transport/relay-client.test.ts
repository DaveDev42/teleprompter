import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decrypt,
  deriveKxKey,
  deriveRegistrationProof,
  deriveRelayToken,
  deriveSessionKeys,
  encrypt,
  generateKeyPair,
  generatePairingSecret,
  type RelayServerMessage,
  toBase64,
  type WsRec,
} from "@teleprompter/protocol";
import { RelayServer } from "../../../relay/src/relay-server";
import { RelayClient } from "./relay-client";

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
    await new Promise<void>((r) => {
      frontendWs.onopen = () => r();
    });

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
    const rec: WsRec = {
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
    const ct = (frame as any).ct;
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

    let receivedInput: { sid: string; data: string } | null = null;

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
        onInput: (sid, data) => {
          receivedInput = { sid, data };
        },
      },
    );

    await client.connect();
    client.subscribe("session-1");
    await Bun.sleep(300);

    // Connect and auth frontend
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((r) => {
      frontendWs.onopen = () => r();
    });
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

    expect(receivedInput).not.toBeNull();
    expect(receivedInput!.sid).toBe("session-1");
    expect(receivedInput!.data).toBe("Hello from frontend!");

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
    await new Promise<void>((r) => {
      frontendWs.onopen = () => r();
    });
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
    const rec: WsRec = {
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

    const frame = await new Promise<any>((resolve, reject) => {
      frontendWs.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        if (msg.t === "relay.frame") resolve(msg);
      };
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

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
});
