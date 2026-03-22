import { parseArgs } from "util";
import { RelayServer } from "@teleprompter/relay";

export function relayCommand(argv: string[]): void {
  const subcommand = argv[0];

  if (subcommand !== "start") {
    console.error(`Usage: tp relay start [--port 7090]`);
    process.exit(1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      port: { type: "string", default: "7090" },
    },
    strict: false,
  });

  const port = parseInt(values.port as string, 10);
  const relay = new RelayServer();
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
