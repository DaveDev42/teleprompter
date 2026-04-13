import { Store } from "@teleprompter/daemon";
import {
  createPairingBundle,
  encodePairingData,
  toBase64,
} from "@teleprompter/protocol";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import qrcode from "qrcode-terminal";
import { parseArgs } from "util";
import { dim, fail, ok, warn } from "../lib/colors";
import { spinner } from "../lib/spinner";

const PAIRING_DIR = join(process.env.HOME ?? "/tmp", ".config", "teleprompter");

export async function pairCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "list":
      await pairList(argv.slice(1));
      return;
    case "delete":
    case "remove":
    case "rm":
      await pairDelete(argv.slice(1));
      return;
    case "new":
      await pairNew(argv.slice(1));
      return;
    case "--help":
    case "-h":
      printPairUsage();
      return;
    default:
      await pairNew(argv);
      return;
  }
}

async function pairNew(argv: string[]): Promise<void> {
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
    (values["daemon-id"] as string) ?? `daemon-${Date.now().toString(36)}`;

  const stop = spinner("Generating pairing keys...");
  const bundle = await createPairingBundle(relayUrl, daemonId);
  const qrString = encodePairingData(bundle.qrData);
  stop(`${ok("Keys generated")}\n`);

  qrcode.generate(qrString, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log(`\nDaemon ID:    ${daemonId}`);
  console.log(`Relay:        ${relayUrl}`);
  console.log(`Relay Token:  ${bundle.relayToken.substring(0, 16)}...`);

  console.log(`\nPairing data (paste into frontend):`);
  console.log(qrString);

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
  }
}

async function pairList(_argv: string[]): Promise<void> {
  const store = new Store();
  const pairings = store.listPairings();
  store.close();

  if (pairings.length === 0) {
    console.log("No pairings registered.");
    console.log("");
    console.log("Create one with: tp pair new");
    return;
  }

  const rows = pairings.map((p) => ({
    daemonId: p.daemonId,
    relayUrl: p.relayUrl,
    created: formatAge(Date.now() - p.createdAt),
  }));

  const idW = Math.max(9, ...rows.map((r) => r.daemonId.length));
  const relayW = Math.max(5, ...rows.map((r) => r.relayUrl.length));

  console.log(
    `${"DAEMON ID".padEnd(idW)}  ${"RELAY".padEnd(relayW)}  CREATED`,
  );
  for (const r of rows) {
    console.log(
      `${r.daemonId.padEnd(idW)}  ${r.relayUrl.padEnd(relayW)}  ${r.created}`,
    );
  }
}

async function pairDelete(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", short: "y", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const prefix = positionals[0];
  if (!prefix) {
    console.error(fail("Usage: tp pair delete <daemon-id> [--yes]"));
    process.exit(1);
  }

  const store = new Store();
  const pairings = store.listPairings();
  const matches = pairings.filter((p) => p.daemonId.startsWith(prefix));

  if (matches.length === 0) {
    store.close();
    console.error(fail(`No pairing matches '${prefix}'.`));
    if (pairings.length > 0) {
      console.error(dim("Known daemon IDs:"));
      for (const p of pairings) console.error(dim(`  ${p.daemonId}`));
    }
    process.exit(1);
  }

  if (matches.length > 1) {
    store.close();
    console.error(fail(`Prefix '${prefix}' is ambiguous. Candidates:`));
    for (const p of matches) console.error(`  ${p.daemonId}  ${p.relayUrl}`);
    process.exit(1);
  }

  const target = matches[0]!;

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      store.close();
      console.error(
        fail("Refusing to delete without confirmation — pass --yes."),
      );
      process.exit(1);
    }
    const answer = await prompt(
      `Delete pairing for ${target.daemonId} (relay ${target.relayUrl})? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      store.close();
      console.log("Aborted.");
      return;
    }
  }

  store.deletePairing(target.daemonId);
  store.close();

  console.log(ok(`Deleted pairing ${target.daemonId}`));
  console.log(
    warn(
      "Daemon may still hold an active relay connection for this pairing.",
    ),
  );
  console.log(dim("Restart the daemon to fully disconnect."));
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data: string) => {
      process.stdin.pause();
      resolve(data);
    });
  });
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function printPairUsage(): void {
  console.log(`
tp pair — manage mobile app pairings

Usage:
  tp pair [--relay URL]            Alias for 'tp pair new'
  tp pair new [--relay URL]        Generate a new pairing (QR code)
  tp pair list                     List registered pairings
  tp pair delete <daemon-id> [-y]  Delete a pairing (prefix match allowed)
`);
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
