import { completionsCommand } from "./commands/completions";
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { logsCommand } from "./commands/logs";
import { pairCommand } from "./commands/pair";
import { passthroughCommand } from "./commands/passthrough";
import { relayCommand } from "./commands/relay";
import { runCommand } from "./commands/run";
import { statusCommand } from "./commands/status";
import { checkForUpdates, upgradeCommand } from "./commands/upgrade";
import { versionCommand } from "./commands/version";

const command = process.argv[2];

const SUBCOMMANDS = new Set([
  "daemon",
  "run",
  "relay",
  "pair",
  "status",
  "logs",
  "doctor",
  "upgrade",
  "completions",
  "version",
]);

// Background version check (non-blocking, only for passthrough mode)
if (
  !SUBCOMMANDS.has(command ?? "") &&
  command !== "--help" &&
  command !== "-h" &&
  command !== undefined
) {
  checkForUpdates().then((newVersion) => {
    if (newVersion) {
      console.error(
        `\x1b[33m[tp] New version available: ${newVersion}. Run 'tp upgrade' to update.\x1b[0m`,
      );
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
tp — Teleprompter: remote Claude Code controller

Usage:
  tp [flags] [claude args]            Run claude through teleprompter
  tp pair [--relay URL]               Pair with mobile app (QR code)
  tp status                           Show sessions & daemon status
  tp logs [session]                   Tail live session output
  tp doctor                           Diagnose environment & connectivity
  tp upgrade                          Upgrade tp + Claude Code
  tp version                          Print version

Flags:
  --tp-sid <id>                       Session ID (default: auto-generated)
  --tp-cwd <path>                     Working directory (default: current)

Daemon management:
  tp daemon start [options]           Start daemon in foreground
  tp daemon install                   Auto-start on login (launchd/systemd)
  tp daemon uninstall                 Remove auto-start

Advanced:
  tp relay start [--port 7090]        Run a relay server
  tp completions <bash|zsh|fish>      Generate shell completions

Examples:
  tp -p "explain this code"           Quick one-shot
  tp --model sonnet -p "fix the bug"  Pass flags to claude
  tp pair                             First-time setup
`);
}
