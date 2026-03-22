import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RelayServer } from "../../../relay/src/relay-server";
import { RelayClient } from "./relay-client";
import {
  generateKeyPair,
  deriveSessionKeys,
  encrypt,
  decrypt,
  deriveRelayToken,
  generatePairingSecret,
  type WsRec,
  type RelayServerMessage,
} from "@teleprompter/protocol";

describe("RelayClient (Daemon → Relay → Frontend E2E)", () => {
  let relay: RelayServer;
  let relayPort: number;
  let pairingSecret: Uint8Array;
  let relayToken: string;
  const DAEMON_ID = "test-daemon";

  beforeEach(async () => {
    relay = new RelayServer();
    relayPort = relay.start(0);
    pairingSecret = await generatePairingSecret();
    relayToken = await deriveRelayToken(pairingSecret);
    relay.registerToken(relayToken, DAEMON_ID);
  });

  afterEach(() => {
    relay.stop();
  });

  test("daemon connects and authenticates to relay", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();

    let connected = false;
    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        keyPair: daemonKp,
        frontendPublicKey: frontendKp.publicKey,
      },
      {
        onConnected: () => {
          connected = true;
        },
      },
    );

    await client.connect();
    await Bun.sleep(200);
    expect(connected).toBe(true);
    expect(client.isConnected()).toBe(true);
    client.dispose();
  });

  test("daemon publishes encrypted record, frontend decrypts via relay", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();

    // Derive keys on both sides
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        keyPair: daemonKp,
        frontendPublicKey: frontendKp.publicKey,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(200);

    // Connect a "frontend" WebSocket to the relay
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((resolve) => {
      frontendWs.onopen = () => resolve();
    });

    // Auth frontend
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
      }),
    );
    await Bun.sleep(100);

    // Subscribe to session
    frontendWs.send(JSON.stringify({ t: "relay.sub", sid: "session-1" }));
    await Bun.sleep(50);

    // Daemon publishes an encrypted record
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

    // Decrypt with frontend's rx key
    const plaintext = await decrypt(ct, frontendKeys.rx);
    const decrypted = JSON.parse(new TextDecoder().decode(plaintext));
    expect(decrypted.t).toBe("rec");
    expect(decrypted.sid).toBe("session-1");
    expect(decrypted.seq).toBe(1);
    expect(Buffer.from(decrypted.d, "base64").toString()).toBe(
      "Hello from daemon!",
    );

    frontendWs.close();
    client.dispose();
  });

  test("frontend sends encrypted input, daemon receives via relay", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();

    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      daemonKp.publicKey,
      "frontend",
    );

    let receivedInput: { sid: string; data: string } | null = null;

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        keyPair: daemonKp,
        frontendPublicKey: frontendKp.publicKey,
      },
      {
        onInput: (sid, data) => {
          receivedInput = { sid, data };
        },
      },
    );

    await client.connect();
    client.subscribe("session-1");
    await Bun.sleep(200);

    // Connect frontend
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((resolve) => {
      frontendWs.onopen = () => resolve();
    });

    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
      }),
    );
    await Bun.sleep(100);

    // Frontend encrypts and sends input
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
      JSON.stringify({
        t: "relay.pub",
        sid: "session-1",
        ct,
        seq: 1,
      }),
    );

    await Bun.sleep(300);

    expect(receivedInput).not.toBeNull();
    expect(receivedInput!.sid).toBe("session-1");
    expect(receivedInput!.data).toBe("Hello from frontend!");

    frontendWs.close();
    client.dispose();
  });

  test("relay cannot read plaintext (ciphertext-only verification)", async () => {
    const daemonKp = await generateKeyPair();
    const frontendKp = await generateKeyPair();
    const wrongKp = await generateKeyPair();

    const client = new RelayClient(
      {
        relayUrl: `ws://localhost:${relayPort}`,
        daemonId: DAEMON_ID,
        token: relayToken,
        keyPair: daemonKp,
        frontendPublicKey: frontendKp.publicKey,
      },
      {},
    );

    await client.connect();
    await Bun.sleep(200);

    // Frontend subscribes
    const frontendWs = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((resolve) => {
      frontendWs.onopen = () => resolve();
    });
    frontendWs.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: relayToken,
      }),
    );
    await Bun.sleep(100);
    frontendWs.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    await Bun.sleep(50);

    // Daemon publishes encrypted record
    const rec: WsRec = {
      t: "rec",
      sid: "s1",
      seq: 1,
      k: "event",
      d: Buffer.from(
        JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "secret!" }),
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

    // The ciphertext should NOT contain readable plaintext
    expect(frame.ct).toBeTruthy();
    expect(frame.ct.includes("secret!")).toBe(false);
    expect(frame.ct.includes("Stop")).toBe(false);

    // A wrong key should fail to decrypt
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
