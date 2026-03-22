import { daemonCommand } from "./commands/daemon";
import { runCommand } from "./commands/run";
import { relayCommand } from "./commands/relay";
import { versionCommand } from "./commands/version";
import { pairCommand } from "./commands/pair";
import { statusCommand } from "./commands/status";
import { passthroughCommand } from "./commands/passthrough";

const command = process.argv[2];

const SUBCOMMANDS = new Set(["daemon", "run", "relay", "pair", "status", "version"]);

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
  case "pair":
    await pairCommand(process.argv.slice(3));
    break;
  case "status":
    await statusCommand(process.argv.slice(3));
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
  tp daemon start [options]            Start the daemon service
    --ws-port 7080                     WebSocket port for local frontends
    --repo-root /path                  Enable worktree management
    --relay-url URL                    Connect to relay server
    --relay-token TOKEN                Relay auth token (from tp pair)
    --daemon-id ID                     Daemon identifier
    --web-dir /path                    Serve frontend web build at WS port
    --spawn --sid X --cwd Y            Auto-create a session on start
  tp run --sid X --cwd Y              Start a runner (used by daemon internally)
  tp relay start [--port 7090]        Start a relay server
  tp pair [--relay URL] [--daemon-id] Generate QR pairing data
  tp status [port]                    Show daemon status and sessions
  tp version                          Print version information

Passthrough mode (default):
  tp -p "explain this code"           Run claude with teleprompter recording
  tp --tp-sid my-session -p "hello"   Specify session ID
  tp --tp-cwd /path/to/project        Specify working directory
  tp --tp-ws-port 9090                Specify WebSocket port

  --tp-* flags are consumed by tp; everything else is passed to claude.
`);
}
