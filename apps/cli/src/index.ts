import { daemonCommand } from "./commands/daemon";
import { runCommand } from "./commands/run";
import { relayCommand } from "./commands/relay";
import { versionCommand } from "./commands/version";

const command = process.argv[2];

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
  default:
    printUsage();
    process.exit(command ? 1 : 0);
}

function printUsage(): void {
  console.log(`
tp — Teleprompter CLI

Usage:
  tp daemon start [--ws-port 7080] [--spawn --sid X --cwd Y]
  tp run --sid X --cwd Y [--socket-path P]
  tp relay start [--port 8080]
  tp version

Commands:
  daemon    Start the Teleprompter daemon
  run       Start a runner (typically called by the daemon)
  relay     Start a relay server (not yet implemented)
  version   Print version information
`);
}
