import { RelayServer } from "./relay-server";

const port = parseInt(process.env.RELAY_PORT ?? "7090", 10);

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
