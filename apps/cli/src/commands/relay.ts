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
      return;
    default:
      console.error(
        `Usage: tp relay start [options]\n` +
          `\n` +
          `  --port <port>           Server port (default: 7090)\n` +
          `  --cache-size <n>        Max cached frames per session (default: 10, env: TP_RELAY_CACHE_SIZE)\n` +
          `  --max-frame-size <n>    Max WebSocket frame size in bytes (default: 1048576, env: TP_RELAY_MAX_FRAME_SIZE)\n` +
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
      "cache-size": { type: "string" },
      "max-frame-size": { type: "string" },
      "register-pairing": { type: "boolean", default: false },
    },
    strict: false,
  });

  const port = parseInt(values.port as string, 10);
  const relay = new RelayServer({
    cacheSize: values["cache-size"]
      ? parseInt(values["cache-size"] as string, 10)
      : undefined,
    maxFrameSize: values["max-frame-size"]
      ? parseInt(values["max-frame-size"] as string, 10)
      : undefined,
  });
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
