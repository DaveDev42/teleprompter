import { daemonCommand } from "./commands/daemon";
import { runCommand } from "./commands/run";
import { relayCommand } from "./commands/relay";
import { versionCommand } from "./commands/version";
import { passthroughCommand } from "./commands/passthrough";

const command = process.argv[2];

const SUBCOMMANDS = new Set(["daemon", "run", "relay", "version"]);

switch (command) {
  case "daemon":
    await daemonCommand(process.argv.slice(3));
    break;
  case "run":
    await runCommand(process.argv.slice(3));
    break;
  case "relay":
    relayCommand(process.argv.slice(3));
    break;
  case "version":
  case "--version":
  case "-v":
    versionCommand();
    break;
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    // No recognized subcommand → passthrough to claude
    // Pass all args from argv[2] onward (including the unrecognized "command")
    await passthroughCommand(process.argv.slice(2));
    break;
}

function printUsage(): void {
  console.log(`
tp — Teleprompter CLI

Usage:
  tp [--tp-*] <claude args>           Run claude through teleprompter (default)
  tp daemon start [--ws-port 7080]    Start the daemon service
  tp run --sid X --cwd Y              Start a runner (used by daemon internally)
  tp relay start [--port 8080]        Start a relay server
  tp version                          Print version information

Passthrough mode (default):
  tp -p "explain this code"           Run claude with teleprompter recording
  tp --tp-sid my-session -p "hello"   Specify session ID
  tp --tp-cwd /path/to/project        Specify working directory
  tp --tp-ws-port 9090                Specify WebSocket port

  --tp-* flags are consumed by tp; everything else is passed to claude.
`);
}
