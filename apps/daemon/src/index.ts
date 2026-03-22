import { Daemon } from "./daemon";

const daemon = new Daemon();
const socketPath = daemon.start();

console.log(`[Daemon] listening on ${socketPath}`);
console.log("[Daemon] press Ctrl+C to stop");

function shutdown() {
  console.log("\n[Daemon] shutting down...");
  daemon.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
