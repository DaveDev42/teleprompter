import { CLAUDE_UTILITY_SUBCOMMANDS } from "./claude-subcommands";

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

/**
 * Commands where a "new version available" stderr line is acceptable and
 * genuinely useful for the interactive user. Everything else — status/logs,
 * daemon/relay long-running processes, run-under-PTY, version output parsed
 * by scripts — should not pay the cost or risk stderr contamination.
 */
const VERSION_CHECK_COMMANDS = new Set(["upgrade", "doctor", "pair"]);

const isPassthrough =
  !SUBCOMMANDS.has(command ?? "") &&
  !CLAUDE_UTILITY_SUBCOMMANDS.has(command ?? "") &&
  command !== "--" &&
  command !== "--help" &&
  command !== "-h" &&
  command !== undefined;

const shouldCheckVersion =
  isPassthrough ||
  (command !== undefined && VERSION_CHECK_COMMANDS.has(command));

async function main(): Promise<void> {
  if (shouldCheckVersion) {
    // Fire and forget; errors inside are already swallowed.
    void import("./commands/upgrade").then(({ checkForUpdates }) =>
      checkForUpdates().then(async (newVersion) => {
        if (!newVersion) return;
        const { yellow } = await import("./lib/colors");
        console.error(
          yellow(
            `[tp] New version available: ${newVersion}. Run 'tp upgrade' to update.`,
          ),
        );
      }),
    );
  }

  switch (command) {
    case "daemon": {
      const { daemonCommand } = await import("./commands/daemon");
      await daemonCommand(process.argv.slice(3));
      break;
    }
    case "run": {
      const { runCommand } = await import("./commands/run");
      await runCommand(process.argv.slice(3));
      break;
    }
    case "relay": {
      const { relayCommand } = await import("./commands/relay");
      await relayCommand(process.argv.slice(3));
      break;
    }
    case "pair": {
      const { pairCommand } = await import("./commands/pair");
      await pairCommand(process.argv.slice(3));
      break;
    }
    case "status": {
      const { statusCommand } = await import("./commands/status");
      await statusCommand(process.argv.slice(3));
      break;
    }
    case "logs": {
      const { logsCommand } = await import("./commands/logs");
      await logsCommand(process.argv.slice(3));
      break;
    }
    case "doctor": {
      const { doctorCommand } = await import("./commands/doctor");
      await doctorCommand(process.argv.slice(3));
      break;
    }
    case "upgrade": {
      const { upgradeCommand } = await import("./commands/upgrade");
      await upgradeCommand(process.argv.slice(3));
      break;
    }
    case "completions": {
      const { completionsCommand } = await import("./commands/completions");
      completionsCommand(process.argv.slice(3));
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      const { versionCommand } = await import("./commands/version");
      await versionCommand(process.argv.slice(3));
      break;
    }
    case "--": {
      const { forwardToClaudeCommand } = await import(
        "./commands/forward-claude"
      );
      await forwardToClaudeCommand(process.argv.slice(3));
      break;
    }
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      if (CLAUDE_UTILITY_SUBCOMMANDS.has(command)) {
        const { forwardToClaudeCommand } = await import(
          "./commands/forward-claude"
        );
        await forwardToClaudeCommand(process.argv.slice(2));
      } else {
        const { passthroughCommand } = await import("./commands/passthrough");
        await passthroughCommand(process.argv.slice(2));
      }
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
  tp completions <bash|zsh|fish|powershell>   Print shell completions to stdout
  tp completions install [shell]      Install completions (--force, --dry-run)
  tp completions uninstall [shell]    Remove installed completions

Claude utility commands (forwarded directly to claude):
  tp auth                             Manage claude authentication
  tp mcp                              Configure claude MCP servers
  tp install                          Install claude native build
  tp update                           Update claude
  tp agents                           List claude agents
  tp auto-mode                        claude auto-mode
  tp plugin                           Manage claude plugins
  tp plugins                          claude plugins (plural alias)
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
