import { describe, expect, test } from "bun:test";
import { decrypt, deriveSessionKeys, encrypt, generateKeyPair } from "./crypto";
import {
  createPairingBundle,
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

    expect(bundle.qrData.v).toBe(1);
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
    const bundle = await createPairingBundle("wss://relay.test", "d1");
    const encoded = encodePairingData(bundle.qrData);
    const decoded = decodePairingData(encoded);

    expect(decoded.ps).toBe(bundle.qrData.ps);
    expect(decoded.pk).toBe(bundle.qrData.pk);
    expect(decoded.relay).toBe(bundle.qrData.relay);
    expect(decoded.did).toBe(bundle.qrData.did);
    expect(decoded.v).toBe(1);
  });

  test("createPairingBundle includes label when provided", async () => {
    const bundle = await createPairingBundle("wss://relay.test", "daemon-lbl", {
      label: "My MacBook",
    });
    expect(bundle.qrData.label).toBe("My MacBook");
  });

  test("encoded pairing data round-trips label", async () => {
    const bundle = await createPairingBundle("wss://relay.test", "daemon-lbl", {
      label: "My MacBook",
    });
    const encoded = encodePairingData(bundle.qrData);
    const decoded = decodePairingData(encoded);
    expect(decoded.label).toBe("My MacBook");
  });

  test("pairing bundle omits label cleanly when not provided", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.test",
      "daemon-nolbl",
    );
    expect(bundle.qrData.label).toBeUndefined();
    expect("label" in bundle.qrData).toBe(false);
  });

  test("decodePairingData rejects invalid format", () => {
    expect(() => decodePairingData('{"foo":1}')).toThrow(
      "Invalid pairing data format",
    );
  });

  test("encoded form is a teleprompter:// deep link", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-deeplinktest",
      { label: "My iPhone" },
    );
    const encoded = encodePairingData(bundle.qrData);
    expect(encoded.startsWith("teleprompter://pair?d=")).toBe(true);
  });

  test("decodePairingData rejects bare base64url payload (no scheme)", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-bare",
      { label: "label" },
    );
    const url = encodePairingData(bundle.qrData);
    const bare = url.slice("teleprompter://pair?d=".length);
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

  test("encoded form fits comfortably under 200 chars with typical label", async () => {
    // Real-world fields: relay 20 chars, daemon id 17 chars, label 14 chars.
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-mob73tr0xx",
      { label: "iPhone-build51" },
    );
    const encoded = encodePairingData(bundle.qrData);
    expect(encoded.length).toBeLessThan(200);
  });

  test("round-trips utf-8 label safely", async () => {
    const bundle = await createPairingBundle(
      "wss://relay.tpmt.dev",
      "daemon-utf8",
      { label: "데이브-iPhone-📱" },
    );
    const encoded = encodePairingData(bundle.qrData);
    const decoded = decodePairingData(encoded);
    expect(decoded.label).toBe("데이브-iPhone-📱");
  });

  test("decodePairingData rejects deep link with no query", () => {
    expect(() => decodePairingData("teleprompter://pair")).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects deep link with empty d= param", () => {
    expect(() => decodePairingData("teleprompter://pair?d=")).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects deep link with invalid base64url", () => {
    expect(() =>
      decodePairingData("teleprompter://pair?d=!!!not-base64url!!!"),
    ).toThrow("Invalid pairing data format");
  });

  test("decodePairingData rejects binary payload with empty did", () => {
    // Manually craft: magic(2)='tp' | ver(1)=1 | didLen=0 | relayLen=1 | r |
    // ps(32) | pk(32) | labelLen=0
    const buf = new Uint8Array(2 + 1 + 1 + 1 + 1 + 32 + 32 + 1);
    buf[0] = 0x74; // 't'
    buf[1] = 0x70; // 'p'
    buf[2] = 1;
    buf[3] = 0; // didLen
    buf[4] = 1; // relayLen
    buf[5] = 0x78; // 'x'
    // ps + pk + labelLen left as zeros
    const b64 = btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePairingData(`teleprompter://pair?d=${b64}`)).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData rejects binary payload with empty relay", () => {
    const buf = new Uint8Array(2 + 1 + 1 + 1 + 1 + 32 + 32 + 1);
    buf[0] = 0x74; // 't'
    buf[1] = 0x70; // 'p'
    buf[2] = 1;
    buf[3] = 1; // didLen=1
    buf[4] = 0x78; // 'x'
    buf[5] = 0; // relayLen=0
    // ps + pk + labelLen left as zeros
    const b64 = btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePairingData(`teleprompter://pair?d=${b64}`)).toThrow(
      "Invalid pairing data format",
    );
  });

  test("decodePairingData strips a UTF-8 BOM before parsing", async () => {
    const bundle = await createPairingBundle("wss://relay.tpmt.dev", "d-bom", {
      label: "bom-test",
    });
    const url = encodePairingData(bundle.qrData);
    const decoded = decodePairingData(`﻿${url}`);
    expect(decoded.did).toBe("d-bom");
    expect(decoded.label).toBe("bom-test");
  });

  test("full pairing flow: daemon creates, frontend parses, keys match", async () => {
    // Step 1: Daemon creates pairing bundle
    const bundle = await createPairingBundle("wss://relay.test", "d1");

    // Step 2: QR code contains encoded pairing data
    const qrString = encodePairingData(bundle.qrData);

    // Step 3: Frontend scans QR and parses
    const scanned = decodePairingData(qrString);
    const frontendParsed = await parsePairingForFrontend(scanned);

    // Both sides derive the same relay token
    expect(frontendParsed.relayToken).toBe(bundle.relayToken);
    expect(frontendParsed.daemonId).toBe("d1");
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
