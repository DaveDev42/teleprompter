import { describe, expect, test } from "bun:test";
import {
  createPairingBundle,
  decodePairingData,
  decrypt,
  deriveSessionKeys,
  encodePairingData,
  encrypt,
  generateKeyPair,
  parsePairingForFrontend,
  ratchetSessionKeys,
} from "./index";

/**
 * Full E2E pairing flow test:
 * 1. Daemon generates pairing bundle → QR string
 * 2. Frontend scans QR → parses pairing data
 * 3. Both sides derive relay token (match)
 * 4. Frontend generates key pair
 * 5. Both sides derive base session keys
 * 6. Both sides ratchet keys per session ID
 * 7. Bidirectional encrypted communication verified
 */
describe("Full QR Pairing E2E Flow", () => {
  test("complete pairing → ratchet → encrypt/decrypt cycle", async () => {
    // ═══ Step 1: Daemon creates pairing bundle ═══
    const bundle = await createPairingBundle("wss://relay.test", "daemon-1");
    const qrString = encodePairingData(bundle.qrData);

    // ═══ Step 2: Frontend scans QR ═══
    const scanned = decodePairingData(qrString);
    expect(scanned.did).toBe("daemon-1");
    expect(scanned.relay).toBe("wss://relay.test");

    // ═══ Step 3: Relay token matches ═══
    const parsed = await parsePairingForFrontend(scanned);
    expect(parsed.relayToken).toBe(bundle.relayToken);

    // ═══ Step 4: Frontend generates key pair ═══
    const frontendKp = await generateKeyPair();

    // ═══ Step 5: Base session keys ═══
    const daemonBase = await deriveSessionKeys(
      bundle.keyPair,
      frontendKp.publicKey,
      "daemon",
    );
    const frontendBase = await deriveSessionKeys(
      frontendKp,
      parsed.daemonPublicKey,
      "frontend",
    );

    // Verify base keys match across roles
    expect(daemonBase.tx).toEqual(frontendBase.rx);
    expect(daemonBase.rx).toEqual(frontendBase.tx);

    // ═══ Step 6: Ratchet per session ═══
    const sessionId = "session-abc-123";
    const daemonKeys = await ratchetSessionKeys(
      daemonBase,
      sessionId,
      "daemon",
    );
    const frontendKeys = await ratchetSessionKeys(
      frontendBase,
      sessionId,
      "frontend",
    );

    // ═══ Step 7: Bidirectional encryption ═══
    // Daemon → Frontend
    const record = JSON.stringify({
      t: "rec",
      sid: sessionId,
      seq: 42,
      k: "event",
      d: btoa(
        JSON.stringify({
          hook_event_name: "Stop",
          last_assistant_message: "Done!",
        }),
      ),
    });
    const ct1 = await encrypt(new TextEncoder().encode(record), daemonKeys.tx);
    const pt1 = await decrypt(ct1, frontendKeys.rx);
    const decoded1 = JSON.parse(new TextDecoder().decode(pt1));
    expect(decoded1.sid).toBe(sessionId);
    expect(decoded1.seq).toBe(42);

    // Frontend → Daemon
    const input = JSON.stringify({
      t: "in.chat",
      sid: sessionId,
      d: "Fix the login bug",
    });
    const ct2 = await encrypt(new TextEncoder().encode(input), frontendKeys.tx);
    const pt2 = await decrypt(ct2, daemonKeys.rx);
    const decoded2 = JSON.parse(new TextDecoder().decode(pt2));
    expect(decoded2.d).toBe("Fix the login bug");

    // ═══ Verify session isolation ═══
    const otherKeys = await ratchetSessionKeys(
      daemonBase,
      "other-session",
      "daemon",
    );
    // Other session's key cannot decrypt this session's ciphertext
    await expect(decrypt(ct1, otherKeys.rx)).rejects.toThrow();
  });
});
