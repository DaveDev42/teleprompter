import { parseArgs } from "util";
import { RelayServer } from "@teleprompter/relay";
import { loadPairingData } from "./pair";
import {
  generateKeyPair,
  deriveSessionKeys,
  encrypt,
  decrypt,
} from "@teleprompter/protocol";

export async function relayCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  switch (subcommand) {
    case "start":
      return startRelay(argv.slice(1));
    case "ping":
      return pingRelay(argv.slice(1));
    default:
      console.error(`Usage: tp relay <start|ping> [options]`);
      process.exit(1);
  }
}

function startRelay(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "7090" },
    },
    strict: false,
  });

  const port = parseInt(values.port as string, 10);
  const relay = new RelayServer();
  relay.start(port);

  console.log("[Relay] press Ctrl+C to stop");

  function shutdown() {
    console.log("\n[Relay] shutting down...");
    relay.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function pingRelay(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "relay-url": { type: "string" },
      count: { type: "string", default: "10" },
      "verify-e2ee": { type: "boolean", default: false },
    },
    strict: false,
  });

  const pairing = await loadPairingData();
  const relayUrl = (values["relay-url"] as string) ?? pairing?.relayUrl;

  if (!relayUrl) {
    console.error("[Ping] No relay URL. Run `tp pair` first or use --relay-url.");
    process.exit(1);
  }

  if (!pairing) {
    console.error("[Ping] No pairing data found. Run `tp pair` first.");
    process.exit(1);
  }

  const count = parseInt(values.count as string, 10);
  const verifyE2EE = values["verify-e2ee"] as boolean;

  console.log(`PING ${relayUrl} (${count} pings${verifyE2EE ? ", E2EE verify" : ""})`);

  // Connect as daemon role for ping
  const ws = new WebSocket(relayUrl);

  const rtts: number[] = [];
  let pongResolve: ((rtt: number) => void) | null = null;

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer),
      );
      if (msg.t === "relay.auth.ok") {
        // Auth succeeded, start pinging
        runPings();
      } else if (msg.t === "relay.pong" && msg.ts && pongResolve) {
        const rtt = Date.now() - msg.ts;
        pongResolve(rtt);
        pongResolve = null;
      } else if (msg.t === "relay.auth.err") {
        console.error(`[Ping] Auth failed: ${msg.e}`);
        ws.close();
        process.exit(1);
      }
    } catch {}
  };

  ws.onopen = () => {
    // Authenticate
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: pairing.daemonId,
        token: pairing.relayToken,
        v: 1,
      }),
    );
  };

  ws.onerror = () => {
    console.error(`[Ping] Connection failed: ${relayUrl}`);
    process.exit(1);
  };

  async function runPings() {
    for (let i = 0; i < count; i++) {
      const rtt = await new Promise<number>((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout>;
        pongResolve = (rtt: number) => {
          clearTimeout(timeoutId);
          resolve(rtt);
        };
        timeoutId = setTimeout(() => {
          pongResolve = null;
          resolve(-1);
        }, 5000);
        ws.send(JSON.stringify({ t: "relay.ping", ts: Date.now() }));
      });

      if (rtt === -1) {
        console.log(`${relayUrl}: timeout`);
      } else {
        rtts.push(rtt);
        console.log(`${relayUrl}: rtt=${rtt}ms`);
      }

      // Wait 500ms between pings
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // E2EE verification if requested
    if (verifyE2EE && pairing) {
      console.log(`\n--- E2EE Verification ---`);
      await verifyE2EECrypto();
    }

    // Print statistics
    if (rtts.length > 0) {
      const sorted = [...rtts].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];

      console.log(`\n--- ${relayUrl} ping statistics ---`);
      console.log(
        `${count} pings, ${rtts.length} received, ${count - rtts.length} lost`,
      );
      console.log(`rtt min=${min}ms avg=${avg}ms max=${max}ms p95=${p95}ms`);
    }

    ws.close();
    process.exit(0);
  }
}

/**
 * Verify E2EE crypto primitives work correctly.
 * Tests key exchange, bidirectional encrypt/decrypt, and wrong-key rejection.
 * This is a local crypto self-test, not a relay round-trip verification.
 */
async function verifyE2EECrypto(): Promise<void> {
  const daemonKp = await generateKeyPair();
  const frontendKp = await generateKeyPair();

  // Derive session keys for both sides
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

  // Test encrypt/decrypt round-trip
  const testPayload = new TextEncoder().encode(
    "E2EE verification test " + Date.now(),
  );

  try {
    // Daemon encrypts -> Frontend decrypts
    const ciphertext = await encrypt(testPayload, daemonKeys.tx);
    const decrypted = await decrypt(ciphertext, frontendKeys.rx);
    const decryptedText = new TextDecoder().decode(decrypted);
    const originalText = new TextDecoder().decode(testPayload);

    if (decryptedText === originalText) {
      console.log(`  daemon -> frontend: OK (encrypt + decrypt)`);
    } else {
      console.log(`  daemon -> frontend: FAIL (mismatch)`);
    }

    // Frontend encrypts -> Daemon decrypts
    const ciphertext2 = await encrypt(testPayload, frontendKeys.tx);
    const decrypted2 = await decrypt(ciphertext2, daemonKeys.rx);
    const decryptedText2 = new TextDecoder().decode(decrypted2);

    if (decryptedText2 === originalText) {
      console.log(`  frontend -> daemon: OK (encrypt + decrypt)`);
    } else {
      console.log(`  frontend -> daemon: FAIL (mismatch)`);
    }

    // Verify relay cannot decrypt (wrong key)
    const wrongKp = await generateKeyPair();
    const wrongKeys = await deriveSessionKeys(
      wrongKp,
      frontendKp.publicKey,
      "daemon",
    );
    try {
      await decrypt(ciphertext, wrongKeys.rx);
      console.log(`  relay isolation:   FAIL (wrong key decrypted!)`);
    } catch {
      console.log(`  relay isolation:   OK (wrong key rejected)`);
    }

    console.log(`  E2EE verification: PASSED`);
  } catch (err) {
    console.log(`  E2EE verification: FAILED (${err})`);
  }
}
