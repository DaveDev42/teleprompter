import { parseArgs } from "util";
import {
  createPairingBundle,
  encodePairingData,
  toBase64,
} from "@teleprompter/protocol";
import qrcode from "qrcode-terminal";

export async function pairCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      relay: { type: "string", default: "ws://localhost:7090" },
      "daemon-id": { type: "string" },
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

  console.log(`\nDaemon ID: ${daemonId}`);
  console.log(`Relay:     ${relayUrl}`);
  console.log(`Token:     ${bundle.relayToken.substring(0, 16)}...`);
  console.log(`\nPairing data (paste into frontend):`);
  console.log(qrString);
  console.log(
    `\nScan the QR code above with the Teleprompter app, or paste the JSON data.`,
  );
  console.log(
    `\nNote: Register this token on the relay server before connecting.`,
  );
  console.log(`Relay token (full): ${bundle.relayToken}`);
}
