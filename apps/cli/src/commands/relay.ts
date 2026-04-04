import { RelayServer } from "@teleprompter/relay";
import { parseArgs } from "util";
import { loadPairingData } from "./pair";

export async function relayCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  switch (subcommand) {
    case "start":
      return startRelay(argv.slice(1));
    case "ping":
      console.log("tp relay ping has moved to tp doctor.\n  → Run: tp doctor");
      process.exit(0);
      break;
    default:
      console.error(
        `Usage: tp relay start [options]\n` +
          `\n` +
          `  --port <port>           Server port (default: 7090)\n` +
          `  --register-pairing      Auto-register token from pairing data`,
      );
      process.exit(1);
  }
}

async function startRelay(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "7090" },
      "register-pairing": { type: "boolean", default: false },
    },
    strict: false,
  });

  const port = parseInt(values.port as string, 10);
  const relay = new RelayServer();
  relay.start(port);

  // Auto-register pairing token from saved pairing data
  if (values["register-pairing"]) {
    const pairing = await loadPairingData();
    if (pairing) {
      relay.registerToken(pairing.relayToken, pairing.daemonId);
      console.log(`[Relay] registered token for daemon ${pairing.daemonId}`);
    } else {
      console.warn(
        "[Relay] --register-pairing: no pairing data found (run `tp pair` first)",
      );
    }
  }

  console.log("[Relay] press Ctrl+C to stop");

  function shutdown() {
    console.log("\n[Relay] shutting down...");
    relay.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
