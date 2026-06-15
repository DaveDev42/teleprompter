// Local relay loopback for the iOS M2 smoke test (ADR-0001 Phase 3).
//
// Starts an in-process RelayServer and pre-seeds the deterministic smoke-test
// token so the Simulator app can send `relay.auth` (role=frontend) and receive
// `relay.auth.ok` without a real daemon. This is the exact pattern the relay
// test suite uses (`relay-server.test.ts` calls `registerToken` in beforeEach) —
// the relay has no auth-bypass dev mode, so the token must be seeded.
//
// The seeded token is `derive_relay_token` of the golden 32-incrementing-byte
// pairing secret (0x00..0x1f), matching `rust/tp-core/tests/fixtures/
// wire-vectors.json` (`kdf.relayToken`). The Simulator app gets that secret from
// a `tp://p?d=…` link whose relay URL points here (`ws://localhost:<port>`).
//
// Run: RELAY_PORT=7090 bun run scripts/local-relay-loopback.ts
// Prints `LOOPBACK_READY port=<port>` once listening, then stays up until killed.

import { RelayServer } from "../packages/relay/src/relay-server";

// derive_relay_token(0x00..0x1f) — must match the Swift FFI deriveRelayToken
// output and the Rust golden vector. If the golden secret changes, update this
// AND scripts/ios.sh's smoke_pair_link AND RelayAuthTests.swift in lockstep.
const TOKEN =
  "a16760de00195ffd72a318d567eca9c2ee0fa7003e7e87cfec03538c4e7aa5c9";
const DAEMON_ID = "daemon-smoketest";
const PORT = parseInt(process.env["RELAY_PORT"] ?? "7090", 10);

const relay = new RelayServer();
const bound = relay.start(PORT);
relay.registerToken(TOKEN, DAEMON_ID);

// Single greppable readiness line for the harness to wait on.
console.log(`LOOPBACK_READY port=${bound}`);
console.log(`[loopback] token ${TOKEN.slice(0, 12)}… → ${DAEMON_ID} seeded`);
console.log(`[loopback] health: http://localhost:${bound}/health`);

function shutdown() {
  relay.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
