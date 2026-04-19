import { CLAUDE_UTILITY_SUBCOMMANDS } from "./claude-subcommands";
import { completionsCommand } from "./commands/completions";
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { forwardToClaudeCommand } from "./commands/forward-claude";
import { logsCommand } from "./commands/logs";
import { pairCommand } from "./commands/pair";
import { passthroughCommand } from "./commands/passthrough";
import { relayCommand } from "./commands/relay";
import { runCommand } from "./commands/run";
import { statusCommand } from "./commands/status";
import { checkForUpdates, upgradeCommand } from "./commands/upgrade";
import { versionCommand } from "./commands/version";
import { yellow } from "./lib/colors";

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

// Background version check (non-blocking).
// Skip in passthrough AND `run` modes — PTY owns the terminal and stray
// stderr corrupts the display. Other subcommands (status, doctor, etc.)
// are skipped because they print machine-readable output.
const isPassthrough =
  !SUBCOMMANDS.has(command ?? "") &&
  !CLAUDE_UTILITY_SUBCOMMANDS.has(command ?? "") &&
  command !== "--" &&
  command !== "--help" &&
  command !== "-h" &&
  command !== undefined;

// Skip in passthrough (PTY owns terminal), run (runner child), version
// (machine-readable), --help/--/undefined, and claude utility forwards.
const skipVersionCheck =
  isPassthrough ||
  command === "run" ||
  command === "version" ||
  command === "--version" ||
  command === "-v" ||
  command === "--" ||
  command === "--help" ||
  command === "-h" ||
  command === undefined ||
  CLAUDE_UTILITY_SUBCOMMANDS.has(command);

if (!skipVersionCheck) {
  checkForUpdates().then((newVersion) => {
    if (newVersion) {
      console.error(
        yellow(
          `[tp] New version available: ${newVersion}. Run 'tp upgrade' to update.`,
        ),
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
    await doctorCommand(process.argv.slice(3));
    break;
  case "upgrade":
    await upgradeCommand(process.argv.slice(3));
    break;
  case "completions":
    completionsCommand(process.argv.slice(3));
    break;
  case "version":
  case "--version":
  case "-v":
    await versionCommand(process.argv.slice(3));
    break;
  case "--":
    // `tp -- <args>` → forward everything after -- directly to claude
    await forwardToClaudeCommand(process.argv.slice(3));
    break;
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    // Claude utility subcommands → forward directly without daemon
    if (CLAUDE_UTILITY_SUBCOMMANDS.has(command)) {
      await forwardToClaudeCommand(process.argv.slice(2));
    } else {
      // No recognized subcommand → passthrough to claude via daemon+runner
      await passthroughCommand(process.argv.slice(2));
    }
    break;
}

function printUsage(): void {
  console.log(`
tp — Teleprompter: remote Claude Code controller

Usage:
  tp [flags] [claude args]            Run claude through teleprompter
  tp pair [new|list|delete]           Manage mobile app pairings (QR code)
  tp status                           Show sessions & daemon status
  tp logs [session]                   Tail live session output
  tp doctor                           Diagnose environment & connectivity
  tp upgrade                          Upgrade tp + Claude Code
  tp version                          Print version
  tp -- <claude args>                 Forward args directly to claude (no daemon)

Flags:
  --tp-sid <id>                       Session ID (default: auto-generated)
  --tp-cwd <path>                     Working directory (default: current)

Daemon management:
  tp daemon start [options]           Start daemon in foreground
  tp daemon status                    Inspect service registration + run state
  tp daemon install                   Auto-start on login (launchd/systemd)
  tp daemon uninstall                 Remove auto-start

Advanced:
  tp relay start [--port 7090]        Run a relay server
  tp completions <bash|zsh|fish>      Generate shell completions

Claude utility commands (forwarded directly to claude):
  tp auth                             Manage claude authentication
  tp mcp                              Configure claude MCP servers
  tp install                          Install claude native build
  tp update                           Update claude
  tp agents                           List claude agents
  tp plugin                           Manage claude plugins
  tp setup-token                      Set up claude auth token

The --claude flag:
  tp doctor --claude                  Run tp doctor, then claude doctor
  tp version --claude                 Print tp version, then claude version
  tp upgrade --claude                 Run claude update only (skips tp)

Examples:
  tp -p "explain this code"           Quick one-shot
  tp --model sonnet -p "fix the bug"  Pass flags to claude
  tp -- doctor                        Run claude's doctor (not tp's)
  tp pair                             First-time setup
`);
}
