import { RelayServer } from "@teleprompter/relay";
import { parseArgs } from "util";

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
          `  --max-frame-size <n>    Max WebSocket frame size in bytes (default: 1048576, env: TP_RELAY_MAX_FRAME_SIZE)`,
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

  console.log("[Relay] press Ctrl+C to stop");

  function shutdown() {
    console.log("\n[Relay] shutting down...");
    relay.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
