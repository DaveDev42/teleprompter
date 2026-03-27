import { parseArgs } from "util";
import { join } from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import {
  createPairingBundle,
  encodePairingData,
  toBase64,
} from "@teleprompter/protocol";
import qrcode from "qrcode-terminal";

const PAIRING_DIR = join(
  process.env.HOME ?? "/tmp",
  ".config",
  "teleprompter",
);

export async function pairCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      relay: { type: "string", default: "wss://relay.tpmt.dev" },
      "daemon-id": { type: "string" },
      save: { type: "boolean", default: true },
    },
    strict: false,
  });

  const relayUrl = values.relay as string;
  const daemonId =
    (values["daemon-id"] as string) ??
    `daemon-${Date.now().toString(36)}`;

  console.log("[Pair] Generating pairing data...\n");

  const bundle = await createPairingBundle(relayUrl, daemonId);
  const qrString = encodePairingData(bundle.qrData);

  // Show QR code in terminal
  qrcode.generate(qrString, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log(`\nDaemon ID:    ${daemonId}`);
  console.log(`Relay:        ${relayUrl}`);
  console.log(`Relay Token:  ${bundle.relayToken.substring(0, 16)}...`);

  console.log(`\nPairing data (paste into frontend):`);
  console.log(qrString);

  // Save pairing data for daemon CLI to use
  if (values.save !== false) {
    await mkdir(PAIRING_DIR, { recursive: true });
    const pairingFile = join(PAIRING_DIR, "pairing.json");
    const pairingData = {
      daemonId,
      relayUrl,
      relayToken: bundle.relayToken,
      publicKey: await toBase64(bundle.keyPair.publicKey),
      secretKey: await toBase64(bundle.keyPair.secretKey),
      qrData: bundle.qrData,
      createdAt: Date.now(),
    };
    await writeFile(pairingFile, JSON.stringify(pairingData, null, 2));
    console.log(`\nPairing saved to ${pairingFile}`);
    console.log(
      `Use with: tp daemon start --relay-url ${relayUrl} --relay-token ${bundle.relayToken} --daemon-id ${daemonId}`,
    );
  }
}

/**
 * Load saved pairing data (used by daemon CLI).
 */
export async function loadPairingData(): Promise<{
  daemonId: string;
  relayUrl: string;
  relayToken: string;
  publicKey: string;
  secretKey: string;
  qrData?: { ps: string; pk: string; relay: string; did: string; v: number };
} | null> {
  try {
    const pairingFile = join(PAIRING_DIR, "pairing.json");
    const raw = await readFile(pairingFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
