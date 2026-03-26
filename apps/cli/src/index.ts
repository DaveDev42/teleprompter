import { daemonCommand } from "./commands/daemon";
import { runCommand } from "./commands/run";
import { relayCommand } from "./commands/relay";
import { versionCommand } from "./commands/version";
import { pairCommand } from "./commands/pair";
import { statusCommand } from "./commands/status";
import { logsCommand } from "./commands/logs";
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import { upgradeCommand, checkForUpdates } from "./commands/upgrade";
import { completionsCommand } from "./commands/completions";
import { passthroughCommand } from "./commands/passthrough";

const command = process.argv[2];

const SUBCOMMANDS = new Set([
  "daemon", "run", "relay", "pair", "status", "logs",
  "doctor", "init", "upgrade", "completions", "version",
]);

// Background version check (non-blocking, only for passthrough mode)
if (!SUBCOMMANDS.has(command ?? "") && command !== "--help" && command !== "-h" && command !== undefined) {
  checkForUpdates().then((newVersion) => {
    if (newVersion) {
      console.error(`\x1b[33m[tp] New version available: ${newVersion}. Run 'tp upgrade' to update.\x1b[0m`);
    }
  });
}

switch (command) {
  case "daemon":
    await daemonCommand(process.argv.slice(3));
    break;
  case "run":
    await runCommand(process.argv.slice(3));
    break;
  case "relay":
    await relayCommand(process.argv.slice(3));
    break;
  case "pair":
    await pairCommand(process.argv.slice(3));
    break;
  case "status":
    await statusCommand(process.argv.slice(3));
    break;
  case "logs":
    await logsCommand(process.argv.slice(3));
    break;
  case "doctor":
    await doctorCommand();
    break;
  case "init":
    await initCommand();
    break;
  case "upgrade":
    await upgradeCommand();
    break;
  case "completions":
    completionsCommand(process.argv.slice(3));
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
    --web-dir /path                    Serve frontend web build at WS port
    --spawn --sid X --cwd Y            Auto-create a session on start
    --verbose / --quiet                Log level control
    --watch                            Auto-restart on crash
    --prune <hours>                    Clean old sessions on startup
  tp relay start [--port 7090]        Start a relay server
  tp pair [--relay URL]               Generate QR pairing data
  tp status [port]                    Show daemon status and sessions
  tp logs [sid] [--port 7080]         Tail live session records
  tp upgrade                          Upgrade tp + Claude Code
  tp doctor                           Diagnose environment
  tp init                             Quick project setup guide
  tp completions <bash|zsh|fish>      Generate shell completions
  tp version                          Print version information

Passthrough mode (default):
  tp -p "explain this code"           Run claude with teleprompter recording
  tp --tp-sid my-session -p "hello"   Specify session ID
  tp --tp-cwd /path/to/project        Specify working directory

Setup shell completions:
  eval "$(tp completions bash)"       # add to ~/.bashrc
  eval "$(tp completions zsh)"        # add to ~/.zshrc
`);
}
