import { describe, expect, test } from "bun:test";
import type { PairingInfo } from "../stores/pairing-store";
import { labelValueOf } from "./pairing-label";

function makePairingInfo(label: PairingInfo["label"]): PairingInfo {
  return {
    daemonId: "test-daemon-id",
    relayUrl: "wss://relay.example.com",
    relayToken: "token",
    registrationProof: "proof",
    daemonPublicKey: new Uint8Array(32),
    frontendKeyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    },
    frontendId: "frontend-id",
    pairingSecret: new Uint8Array(32),
    pairedAt: Date.now(),
    label,
  };
}

describe("labelValueOf", () => {
  test("returns value when label.set === true", () => {
    const info = makePairingInfo({ set: true, value: "My Daemon" });
    expect(labelValueOf(info)).toBe("My Daemon");
  });

  test("returns undefined when label.set === false", () => {
    const info = makePairingInfo({ set: false });
    expect(labelValueOf(info)).toBeUndefined();
  });
});
