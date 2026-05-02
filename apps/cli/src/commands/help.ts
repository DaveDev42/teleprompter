/**
 * tp --help / -h — print tp's own usage banner, then forward to `claude --help`
 * so the user sees both surfaces in one shot.
 *
 * tp's banner deliberately omits Claude utility forwards (auth, mcp, install,
 * etc.) — claude's own --help covers those, and listing them twice is noise.
 */

import { dim } from "../lib/colors";

export async function helpCommand(): Promise<void> {
  printTpUsage();

  let check: ReturnType<typeof Bun.spawnSync>;
  try {
    check = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    console.log(
      dim("\n(claude not found on PATH — skipping `claude --help` output.)"),
    );
    return;
  }
  if (check.exitCode !== 0) {
    console.log(
      dim("\n(claude not found on PATH — skipping `claude --help` output.)"),
    );
    return;
  }

  console.log(dim("\n--- claude --help ---\n"));
  const proc = Bun.spawn(["claude", "--help"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

function printTpUsage(): void {
  console.log(`tp — Teleprompter: remote Claude Code controller

Usage:
  tp                                  Run claude through teleprompter
  tp [flags] [claude args]            Run claude with args (passthrough)
  tp pair [new|list|delete|rename]    Manage mobile app pairings (QR code)
  tp session [list|delete|prune]      Manage stored sessions
  tp status                           Show sessions & daemon status
  tp logs [session]                   Tail live session output
  tp doctor                           Diagnose environment & connectivity
  tp upgrade                          Upgrade tp + Claude Code
  tp version                          Print tp + claude versions
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

Examples:
  tp                                  Open claude REPL through teleprompter
  tp -p "explain this code"           Quick one-shot
  tp --model sonnet -p "fix the bug"  Pass flags to claude
  tp -- doctor                        Run claude's doctor (not tp's)
  tp pair                             First-time setup`);
}
