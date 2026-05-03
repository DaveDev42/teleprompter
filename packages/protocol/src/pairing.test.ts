import { describe, expect, test } from "bun:test";
import { decrypt, deriveSessionKeys, encrypt, generateKeyPair } from "./crypto";
import {
  createPairingBundle,
  DEFAULT_PAIRING_RELAY_URL,
  decodePairingData,
  encodePairingData,
  parsePairingForFrontend,
} from "./pairing";

describe("pairing", () => {
  test("creates pairing bundle with all required fields", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.example.com",
      "daemon-123",
    );

    expect(bundle.qrData.v).toBe(2);
    expect(bundle.qrData.relay).toBe("wss://relay.example.com");
    expect(bundle.qrData.did).toBe("daemon-123");
    expect(bundle.qrData.ps).toBeTruthy();
    expect(bundle.qrData.pk).toBeTruthy();
    expect(bundle.keyPair.publicKey.length).toBe(32);
    expect(bundle.keyPair.secretKey.length).toBe(32);
    expect(bundle.pairingSecret.length).toBe(32);
    expect(bundle.relayToken.length).toBe(64);
  });

  test("encode/decode pairing data round-trip", async () => {
    const bundle = await createPairingBundle("wss://relay.test", "daemon-d1");
    const encoded = encodePairingData(bundle.qrData);
    const decoded = decodePairingData(encoded);

    expect(decoded.ps).toBe(bundle.qrData.ps);
    expect(decoded.pk).toBe(bundle.qrData.pk);
    expect(decoded.relay).toBe(bundle.qrData.relay);
    expect(decoded.did).toBe(bundle.qrData.did);
    expect(decoded.v).toBe(2);
  });

  test("PairingData has no label field — label travels via relay.kx", async () => {
    // Label was removed from the QR to shrink it; the daemon now broadcasts
    // its label in the encrypted relay.kx envelope after auth. This test
    // pins the wire shape so anyone re-adding `label` to PairingData has to
    // re-think the migration.
    const bundle = await createPairingBundle("wss://relay.test", "daemon-x");
    expect("label" in bundle.qrData).toBe(false);
    const decoded = decodePairingData(encodePairingData(bundle.qrData));
    expect("label" in decoded).toBe(false);
  });

  test("createPairingBundle ignores label opt for QR purposes", async () => {
    // Label can still be passed for daemon-side bookkeeping (RelayClient
    // config picks it up), but it must not surface on the QR payload.
    const bundle = await createPairingBundle("wss://relay.test", "daemon-lbl", {
      label: "My MacBook",
    });
    expect("label" in bundle.qrData).toBe(false);
  });

  test("decodePairingData rejects invalid format", () => {
    expect(() => decodePairingData('{"foo":1}')).toThrow(
      "Invalid pairing data format",
    );
  });

  test("encoded form is a tp:// deep link", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-deeplinktest",
    );
    const encoded = encodePairingData(bundle.qrData);
    expect(encoded.startsWith("tp://p?d=")).toBe(true);
  });

  test("decodePairingData rejects bare base64url payload (no scheme)", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-bare",
    );
    const url = encodePairingData(bundle.qrData);
    const bare = url.slice("tp://p?d=".length);
    expect(() => decodePairingData(bare)).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects legacy JSON form", () => {
    expect(() =>
      decodePairingData(
        '{"ps":"AAAA","pk":"BBBB","relay":"wss://r","did":"x","v":1}',
      ),
    ).toThrow("Invalid pairing data format");
  });

  test("decodePairingData rejects the legacy teleprompter:// scheme", async () => {
    // We deliberately dropped backwards-compat with the long scheme. A
    // payload that decoded fine under the old prefix must now fail — this
    // catches anyone hand-editing PAIRING_URL_SCHEME back or introducing a
    // looser prefix match.
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-old",
    );
    const newUrl = encodePairingData(bundle.qrData);
    const payload = newUrl.slice("tp://p?d=".length);
    expect(() => decodePairingData(`teleprompter://pair?d=${payload}`)).toThrow(
      "Invalid pairing data format",
    );
  });

  test("typical pairing URL fits comfortably under 130 chars", async () => {
    // Real-world fields: relay 20 chars (wss://relay.tpmt.dev — replaced by
    // relay_len=0 sentinel), daemon id 17 chars (daemon-mob73tr0xx —
    // `daemon-` prefix is stripped on the wire and restored on decode),
    // no label. Prefix is `tp://p?d=` (9 chars).
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-mob73tr0xx",
    );
    const encoded = encodePairingData(bundle.qrData);
    expect(encoded.length).toBeLessThan(130);
  });

  test("encoder strips daemon- prefix on wire and decoder restores it", async () => {
    // Verifies the prefix-stripping optimisation directly: encoding a
    // `daemon-XXXX` id should produce a binary payload that does NOT
    // contain the literal `daemon-` substring (otherwise the optimisation
    // is a no-op).
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-abcdef",
    );
    const encoded = encodePairingData(bundle.qrData);
    const payload = encoded.slice("tp://p?d=".length);
    // Decode the base64url payload back to bytes and inspect them directly.
    const padLen = (4 - (payload.length % 4)) % 4;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
    const bin = atob(b64);
    expect(bin).not.toContain("daemon-");
    expect(bin).toContain("abcdef");
    // And the round-trip still recovers the full id.
    expect(decodePairingData(encoded).did).toBe("daemon-abcdef");
  });

  test("encodePairingData rejects daemon ids without daemon- prefix", async () => {
    // The wire format relies on the prefix being implicit. Encoding an id
    // that doesn't carry it would hand a partially-correct id to the
    // frontend on decode, so we reject it loudly at the source.
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-anchor",
    );
    expect(() =>
      encodePairingData({ ...bundle.qrData, did: "anchor" }),
    ).toThrow(/daemon id must start with/);
  });

  test("default relay URL is omitted from binary form to shrink the QR", async () => {
    const defaultBundle = await createPairingBundle(
      DEFAULT_PAIRING_RELAY_URL,
      "daemon-default",
    );
    const customBundle = await createPairingBundle(
      "wss://relay.example.org",
      "daemon-custom",
    );
    const defaultLen = encodePairingData(defaultBundle.qrData).length;
    const customLen = encodePairingData(customBundle.qrData).length;
    // Custom relay encodes inline; default omits the 21-byte URL. Same daemon
    // id length here, so the gap should reflect the relay savings (~28 chars
    // of base64url for 21 bytes).
    expect(customLen).toBeGreaterThan(defaultLen + 20);
    // And the default form still round-trips back to the canonical URL.
    const decoded = decodePairingData(encodePairingData(defaultBundle.qrData));
    expect(decoded.relay).toBe(DEFAULT_PAIRING_RELAY_URL);
  });

  test("default relay detection tolerates trailing slash and case variants", async () => {
    // Daemon spawned with `wss://Relay.TPMT.dev/` (trailing slash + uppercase
    // host) should still get the compact form. The decoded URL is the
    // canonical default — we drop the variant rather than try to round-trip it.
    const bundle = await createPairingBundle(
      "wss://Relay.TPMT.dev/",
      "daemon-norm",
    );
    const encodedLen = encodePairingData(bundle.qrData).length;
    const customLen = encodePairingData({
      ...bundle.qrData,
      relay: "wss://relay.example.org",
    }).length;
    expect(customLen).toBeGreaterThan(encodedLen + 20);
    const decoded = decodePairingData(encodePairingData(bundle.qrData));
    expect(decoded.relay).toBe(DEFAULT_PAIRING_RELAY_URL);
  });

  test("decodePairingData rejects deep link with no query", () => {
    expect(() => decodePairingData("tp://p")).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects deep link with empty d= param", () => {
    expect(() => decodePairingData("tp://p?d=")).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects deep link with invalid base64url", () => {
    expect(() => decodePairingData("tp://p?d=!!!not-base64url!!!")).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects binary payload with empty did", () => {
    // Manually craft: magic(2)='tp' | ver(1)=2 | didLen=0 | relayLen=1 | r |
    // ps(32) | pk(32)
    const buf = new Uint8Array(2 + 1 + 1 + 1 + 1 + 32 + 32);
    buf[0] = 0x74; // 't'
    buf[1] = 0x70; // 'p'
    buf[2] = 2;
    buf[3] = 0; // didLen
    buf[4] = 1; // relayLen
    buf[5] = 0x78; // 'x'
    // ps + pk left as zeros
    const b64 = btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePairingData(`tp://p?d=${b64}`)).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData treats empty relay as default relay URL", () => {
    // magic(2)='tp' | ver(1)=2 | didLen=1 | did='x' | relayLen=0 |
    // ps(32) | pk(32). Decoder restores `daemon-` prefix on the way out.
    const buf = new Uint8Array(2 + 1 + 1 + 1 + 1 + 32 + 32);
    buf[0] = 0x74; // 't'
    buf[1] = 0x70; // 'p'
    buf[2] = 2;
    buf[3] = 1; // didLen=1
    buf[4] = 0x78; // 'x'
    buf[5] = 0; // relayLen=0
    // ps + pk left as zeros
    const b64 = btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const decoded = decodePairingData(`tp://p?d=${b64}`);
    expect(decoded.relay).toBe(DEFAULT_PAIRING_RELAY_URL);
    expect(decoded.did).toBe("daemon-x");
  });

  test("decodePairingData rejects unknown binary version", () => {
    const buf = new Uint8Array(2 + 1 + 1 + 1 + 1 + 32 + 32);
    buf[0] = 0x74;
    buf[1] = 0x70;
    buf[2] = 99; // unknown version
    buf[3] = 1;
    buf[4] = 0x78;
    buf[5] = 1;
    buf[6] = 0x79;
    const b64 = btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePairingData(`tp://p?d=${b64}`)).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData strips a UTF-8 BOM before parsing", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-bom",
    );
    const url = encodePairingData(bundle.qrData);
    const decoded = decodePairingData(`﻿${url}`);
    expect(decoded.did).toBe("daemon-bom");
  });

  test("full pairing flow: daemon creates, frontend parses, keys match", async () => {
    // Step 1: Daemon creates pairing bundle
    const bundle = await createPairingBundle("wss://relay.test", "daemon-d1");

    // Step 2: QR code contains encoded pairing data
    const qrString = encodePairingData(bundle.qrData);

    // Step 3: Frontend scans QR and parses
    const scanned = decodePairingData(qrString);
    const frontendParsed = await parsePairingForFrontend(scanned);

    // Both sides derive the same relay token
    expect(frontendParsed.relayToken).toBe(bundle.relayToken);
    expect(frontendParsed.daemonId).toBe("daemon-d1");
    expect(frontendParsed.relayUrl).toBe("wss://relay.test");

    // Step 4: Frontend generates its own key pair
    const frontendKp = await generateKeyPair();

    // Step 5: Both sides derive session keys
    const daemonKeys = await deriveSessionKeys(
      bundle.keyPair,
      frontendKp.publicKey,
      "daemon",
    );
    const frontendKeys = await deriveSessionKeys(
      frontendKp,
      frontendParsed.daemonPublicKey,
      "frontend",
    );

    // Step 6: Verify encryption works end-to-end
    const message = new TextEncoder().encode("Hello from daemon!");
    const ct = await encrypt(message, daemonKeys.tx);
    const pt = await decrypt(ct, frontendKeys.rx);
    expect(new TextDecoder().decode(pt)).toBe("Hello from daemon!");

    // Reverse direction too
    const reply = new TextEncoder().encode("Reply from frontend!");
    const ct2 = await encrypt(reply, frontendKeys.tx);
    const pt2 = await decrypt(ct2, daemonKeys.rx);
    expect(new TextDecoder().decode(pt2)).toBe("Reply from frontend!");
  });
});
