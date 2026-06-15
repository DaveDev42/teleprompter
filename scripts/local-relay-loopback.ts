// Local relay loopback for the iOS M2/M3 smoke test (ADR-0001 Phase 3).
//
// Starts an in-process RelayServer and pre-seeds the deterministic smoke-test
// token so the Simulator app can send `relay.auth` (role=frontend) and receive
// `relay.auth.ok` without a real daemon (M2). For M3 it ALSO attaches a minimal
// fake daemon WebSocket peer that:
//   - auths as role=daemon with the seeded token,
//   - subscribes to `__meta__`/`__control__`,
//   - broadcasts its kx pubkey via `relay.kx`,
//   - on the frontend's `relay.kx.frame`, derives server session keys, and
//   - pushes an encrypted `hello` (session list) on `__meta__`.
// This drives the app through TP_KX_OK and TP_FRAME_OK sessions=<n> end to end.
//
// The seeded token is `derive_relay_token` of the golden 32-incrementing-byte
// pairing secret (0x00..0x1f), matching `rust/tp-core/tests/fixtures/
// wire-vectors.json` (`kdf.relayToken`). The Simulator app gets that secret from
// a `tp://p?d=…` link whose relay URL points here (`ws://localhost:<port>`).
//
// CRITICAL: the fake daemon must be connected + authed BEFORE the app sends its
// `relay.kx` — `handleKeyExchange` only fans out to currently-connected
// opposite-role peers and does NOT cache kx frames (relay-server.ts). We connect
// the fake daemon at startup and only print LOOPBACK_READY once it has authed.
//
// Run: RELAY_PORT=7090 bun run scripts/local-relay-loopback.ts
// Prints `LOOPBACK_READY port=<port>` once listening + daemon authed, then stays
// up until killed.

import {
  decrypt,
  deriveKxKey,
  deriveSessionKeys,
  encrypt,
  fromBase64,
  generateKeyPair,
  toBase64,
} from "../packages/protocol/src/crypto";
import type { SessionKeys } from "../packages/protocol/src/crypto";
import { RelayServer } from "../packages/relay/src/relay-server";

// derive_relay_token(0x00..0x1f) — must match the Swift FFI deriveRelayToken
// output and the Rust golden vector. If the golden secret changes, update this
// AND scripts/ios.sh's smoke_pair_link AND RelayAuthTests.swift in lockstep.
const TOKEN =
  "a16760de00195ffd72a318d567eca9c2ee0fa7003e7e87cfec03538c4e7aa5c9";
const DAEMON_ID = "daemon-smoketest";
const PORT = parseInt(process.env["RELAY_PORT"] ?? "7090", 10);
// The golden pairing secret (0x00..0x1f) — the kx-envelope key is derived from
// it, byte-exact with the Swift app's deriveKxKey(pairing.pairingSecret).
const GOLDEN_SECRET = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
// One fake session so TP_FRAME_OK sessions=<n> proves a non-empty render.
const FAKE_SESSIONS = [
  {
    sid: "sess-smoketest",
    state: "running",
    cwd: "/tmp/smoke",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastSeq: 0,
  },
];

const relay = new RelayServer();
const bound = relay.start(PORT);
relay.registerToken(TOKEN, DAEMON_ID);

// ── Fake daemon WebSocket peer (M3) ──────────────────────────────────────────
//
// Connects back to the in-process relay over a real WebSocket and plays the
// daemon side of the kx handshake + hello push, exactly mirroring
// packages/daemon/src/transport/relay-client.ts but stripped to the smoke path.
async function startFakeDaemon(): Promise<void> {
  const kxKey = await deriveKxKey(GOLDEN_SECRET);
  const daemonKp = await generateKeyPair();
  let sessionKeys: SessionKeys | null = null;
  let metaSeq = 0;

  const ws = new WebSocket(`ws://localhost:${bound}`);

  const sendJson = (obj: unknown) => ws.send(JSON.stringify(obj));

  // Broadcast the daemon's kx pubkey (sealed with the kx-envelope key). The relay
  // fans this out only to *currently-connected* opposite-role peers and does NOT
  // cache it, so a single broadcast at our own auth time is lost: the frontend
  // connects later. We therefore re-broadcast when the frontend's kx.frame
  // arrives (= a frontend just joined) — exactly mirroring the real daemon, whose
  // long-lived RelayClient re-broadcasts on every reconnect/frontend-join
  // (relay-client.ts broadcastDaemonPublicKey). Without this the frontend never
  // gets the daemon pubkey, never derives session keys, and drops the hello.
  const broadcastDaemonKx = async () => {
    const payload = JSON.stringify({
      pk: await toBase64(daemonKp.publicKey),
      role: "daemon",
      v: 2,
      label: { set: false },
    });
    const ct = await encrypt(new TextEncoder().encode(payload), kxKey);
    sendJson({ t: "relay.kx", ct, role: "daemon" });
  };

  ws.addEventListener("open", () => {
    // Pre-seeded token → relay accepts role=daemon without relay.register.
    sendJson({
      t: "relay.auth",
      v: 2,
      role: "daemon",
      daemonId: DAEMON_ID,
      token: TOKEN,
    });
  });

  ws.addEventListener("message", async (ev: MessageEvent) => {
    let msg: { t?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(
        typeof ev.data === "string" ? ev.data : String(ev.data),
      );
    } catch {
      return;
    }

    switch (msg.t) {
      case "relay.auth.ok": {
        // Subscribe so the app's frames reach us, then broadcast our kx pubkey.
        // (This first broadcast is a no-op for a not-yet-connected frontend; the
        // authoritative delivery is the re-broadcast on the frontend's kx.frame.)
        sendJson({ t: "relay.sub", sid: "__meta__", after: 0 });
        sendJson({ t: "relay.sub", sid: "__control__", after: 0 });
        await broadcastDaemonKx();
        console.log("[loopback:daemon] authed + kx broadcast");
        break;
      }
      case "relay.kx.frame": {
        // The frontend's pubkey exchange. Derive server session keys.
        if (msg["from"] !== "frontend") return;
        try {
          const plain = await decrypt(String(msg["ct"]), kxKey);
          const data = JSON.parse(new TextDecoder().decode(plain)) as {
            pk: string;
            frontendId: string;
          };
          const frontendPub = await fromBase64(data.pk);
          sessionKeys = await deriveSessionKeys(
            daemonKp,
            frontendPub,
            "daemon",
          );
          console.log(
            `[loopback:daemon] kx complete frontendId=${data.frontendId.slice(0, 8)}…`,
          );
          // A frontend just joined: re-broadcast our kx pubkey so the frontend
          // (which connected after our auth-time broadcast) receives it and can
          // derive its session keys. THEN push hello — the frontend's rx key is
          // the same regardless of broadcast timing, but it can only decrypt the
          // hello once it has processed our kx.frame, so its `after:0` __meta__
          // subscription + on-demand fallback recover a hello that races ahead.
          await broadcastDaemonKx();
          await pushHello();
        } catch (err) {
          console.error("[loopback:daemon] kx.frame failed:", err);
        }
        break;
      }
      case "relay.frame": {
        // On-demand hello fallback: the app may publish {t:'hello'} on __meta__.
        if (!sessionKeys || msg["from"] !== "frontend") return;
        try {
          const plain = await decrypt(String(msg["ct"]), sessionKeys.rx);
          const inner = JSON.parse(new TextDecoder().decode(plain)) as {
            t?: string;
          };
          if (inner.t === "hello") {
            console.log("[loopback:daemon] on-demand hello request");
            await pushHello();
          }
        } catch {
          // ignore non-hello frames
        }
        break;
      }
      default:
        break;
    }
  });

  async function pushHello(): Promise<void> {
    if (!sessionKeys) return;
    const hello = JSON.stringify({
      t: "hello",
      v: 1,
      d: { sessions: FAKE_SESSIONS, daemonLabel: { set: false } },
    });
    const ct = await encrypt(new TextEncoder().encode(hello), sessionKeys.tx);
    sendJson({ t: "relay.pub", sid: "__meta__", ct, seq: metaSeq++ });
    console.log(`[loopback:daemon] hello pushed sessions=${FAKE_SESSIONS.length}`);
  }

  // Resolve once the daemon has authed so the harness only injects the app's
  // pairing link after the daemon is ready to fan out kx.
  await new Promise<void>((resolve, reject) => {
    const onAuth = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(
          typeof ev.data === "string" ? ev.data : String(ev.data),
        );
        if (m.t === "relay.auth.ok") {
          ws.removeEventListener("message", onAuth);
          resolve();
        } else if (m.t === "relay.auth.err") {
          reject(new Error(`daemon auth rejected: ${m.e}`));
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", onAuth);
    ws.addEventListener("error", () => reject(new Error("daemon ws error")));
    ws.addEventListener("close", () =>
      reject(new Error("daemon ws closed before auth")),
    );
  });
}

await startFakeDaemon();

// Single greppable readiness line for the harness to wait on — printed only
// after the fake daemon is authed, so the app's kx always finds a daemon peer.
console.log(`LOOPBACK_READY port=${bound}`);
console.log(`[loopback] token ${TOKEN.slice(0, 12)}… → ${DAEMON_ID} seeded`);
console.log(`[loopback] health: http://localhost:${bound}/health`);

function shutdown() {
  relay.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
