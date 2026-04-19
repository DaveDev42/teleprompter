/**
 * tp completions — generate shell completion scripts.
 *
 * Usage:
 *   eval "$(tp completions bash)"
 *   eval "$(tp completions zsh)"
 *   eval "$(tp completions fish)"
 */

import { detectShell, type Shell } from "../lib/shell-detect";
import {
  installCompletion,
  uninstallCompletion,
  type InstallShell,
} from "./completions-install";

const SUBCOMMANDS = [
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
  // Claude utility subcommands (forwarded directly to claude)
  "auth",
  "mcp",
  "install",
  "update",
  "agents",
  "auto-mode",
  "plugin",
  "plugins",
  "setup-token",
];

// Mirrors the verbs in pairCommand() router in pair.ts. No show/qr/export exist.
const PAIR_SUBCOMMANDS = ["new", "list", "delete", "rename"];
const DAEMON_SUBCOMMANDS = ["start", "status", "install", "uninstall"];

const DAEMON_FLAGS = [
  "--repo-root",
  "--relay-url",
  "--relay-token",
  "--daemon-id",
  "--prune",
  "--spawn",
  "--sid",
  "--cwd",
  "--worktree-path",
  "--verbose",
  "--quiet",
  "--watch",
];

// Validate subcommand names and flag formats at module load.
const SUBCOMMAND_NAME_RE = /^[a-z0-9-]+$/;
for (const name of [...SUBCOMMANDS, ...PAIR_SUBCOMMANDS, ...DAEMON_SUBCOMMANDS]) {
  if (!SUBCOMMAND_NAME_RE.test(name)) {
    throw new Error(`Invalid subcommand name: ${name}`);
  }
}
for (const flag of DAEMON_FLAGS) {
  if (!/^--[a-z0-9-]+$/.test(flag)) {
    throw new Error(`Invalid flag: ${flag}`);
  }
}

const INSTALL_USAGE = `Usage: tp completions install [shell] [flags]

Shells: bash, zsh, fish, powershell (alias: pwsh)
Flags:
  --force                Overwrite existing installation
  --uninstall            Remove installed completions
  --dry-run              Show what would change without writing
  --legacy-powershell    Use Windows PowerShell 5.1 profile path
  --profile-dir PATH     PowerShell profile directory override (powershell only)
  --help, -h             Show this help

Notes:
  --profile-dir must be followed by a path (not another flag).
  --profile-dir is used only when <shell> is powershell.
  Fish and PowerShell write completion files to disk; rerun
  'tp completions install <shell> --force' after 'tp upgrade' to refresh.`;

const INSTALL_FLAG_ALLOWLIST = new Set([
  "--force",
  "--dry-run",
  "--uninstall",
  "--legacy-powershell",
  "--profile-dir",
  "--help",
  "-h",
]);

export function completionsCommand(argv: string[]): void {
  if (argv[0] === "uninstall") {
    runInstall(["--uninstall", ...argv.slice(1)]);
    return;
  }

  if (argv[0] === "install") {
    runInstall(argv.slice(1));
    return;
  }

  const shell = argv[0] ?? "bash";
  const normalized = shell === "pwsh" ? "powershell" : shell;

  switch (normalized) {
    case "bash":
      console.log(generateBash());
      break;
    case "zsh":
      console.log(generateZsh());
      break;
    case "fish":
      console.log(generateFish());
      break;
    case "powershell":
      console.log(generatePowerShell());
      break;
    default:
      console.error(`Unknown shell: ${shell}`);
      console.error("Supported: bash, zsh, fish, powershell");
      process.exit(1);
  }
}

function runInstall(argv: string[]): void {
  // Extract --profile-dir value (last occurrence wins) before the help check
  // so that `--profile-dir --help` (allowlist collision) is caught as an error.
  const profileDirIdx = argv.lastIndexOf("--profile-dir");
  let powerShellProfileDir: string | undefined;

  // Build a set of indices consumed by --profile-dir so they don't appear as positionals.
  const consumedIndices = new Set<number>();
  if (profileDirIdx >= 0) {
    const value = argv[profileDirIdx + 1];
    if (value === undefined || INSTALL_FLAG_ALLOWLIST.has(value) || value === "--profile-dir") {
      console.error("--profile-dir requires a path argument.");
      console.error(INSTALL_USAGE);
      process.exit(1);
    }
    powerShellProfileDir = value;
    consumedIndices.add(profileDirIdx);
    consumedIndices.add(profileDirIdx + 1);
  }

  // Help flag check.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(INSTALL_USAGE);
    process.exit(0);
  }

  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const uninstall = argv.includes("--uninstall");
  const legacyPowerShell = argv.includes("--legacy-powershell");

  // Reject unknown flags.
  // consumedIndices skips --profile-dir and its value so they're not re-checked.
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("-") && a !== "-" && !INSTALL_FLAG_ALLOWLIST.has(a) && !consumedIndices.has(i)) {
      console.error(`Unknown flag: ${a}`);
      console.error(INSTALL_USAGE);
      process.exit(1);
    }
  }

  const positional = argv.find(
    (a, i) => !a.startsWith("-") && !consumedIndices.has(i),
  );
  const requested =
    positional === "pwsh" ? "powershell" : (positional as Shell | undefined);

  const shell: Shell | null =
    requested ?? detectShell(process.env, process.platform);

  if (!shell) {
    const hint = process.env.SHELL
      ? `Detected $SHELL=${process.env.SHELL} (unsupported).`
      : "$SHELL is not set and no $ZSH_VERSION / $BASH_VERSION / $FISH_VERSION detected.";
    console.error(
      `Could not detect shell. ${hint} Run 'tp completions install <bash|zsh|fish|powershell>'.`,
    );
    process.exit(1);
  }

  if (uninstall) {
    const r = uninstallCompletion({ shell, legacyPowerShell, dryRun, powerShellProfileDir });
    if (r.status === "dry-run") {
      console.log(r.plan);
    } else if (r.status === "uninstalled") {
      console.error(`tp completions removed for ${shell} (${r.file})`);
    } else {
      console.error(`tp completions not installed for ${shell}`);
    }
    return;
  }

  const r = installCompletion({
    shell,
    force,
    dryRun,
    legacyPowerShell,
    powerShellProfileDir,
  });

  if (r.status === "dry-run") {
    console.log(r.plan);
  } else if (r.status === "already-installed") {
    console.error(`tp completions already installed for ${shell} (${r.file})`);
  } else {
    console.error(`tp completions installed for ${shell} (${r.file})`);
    console.error("Restart your shell or source your rc file to activate.");
  }
}

export function renderCompletion(shell: InstallShell): string {
  switch (shell) {
    case "bash":
      return generateBash();
    case "zsh":
      return generateZsh();
    case "fish":
      return generateFish();
    case "powershell":
      return generatePowerShell();
  }
}

function generateBash(): string {
  return `# tp bash completion
_tp_completions() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${SUBCOMMANDS.join(" ")}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "daemon" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "${DAEMON_SUBCOMMANDS.join(" ")}" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "daemon" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "${DAEMON_FLAGS.join(" ")}" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "pair" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "${PAIR_SUBCOMMANDS.join(" ")}" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "pair" ] && [ "\${COMP_WORDS[2]}" = "new" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "--relay --label" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "doctor" ] || [ "\${COMP_WORDS[1]}" = "version" ] || [ "\${COMP_WORDS[1]}" = "upgrade" ]; then
    COMPREPLY=( $(compgen -W "--claude" -- "$cur") )
  fi
}
complete -F _tp_completions tp`;
}

function generateZsh(): string {
  return `# tp zsh completion
_tp() {
  local -a commands
  commands=(
${SUBCOMMANDS.map((c) => `    '${c}:${c} command'`).join("\n")}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'tp commands' commands
      ;;
    args)
      case \${words[1]} in
        daemon)
          if [ "\${#words[@]}" -le 2 ]; then
            _values 'daemon subcommand' ${DAEMON_SUBCOMMANDS.map((s) => `'${s}'`).join(" ")}
          else
            _arguments \\
${DAEMON_FLAGS.map((f) => `              '${f}[${f.replace(/^--/, "")}]'`).join(" \\\n")}
          fi
          ;;
        pair)
          if [ "\${#words[@]}" -le 2 ]; then
            _values 'pair subcommand' ${PAIR_SUBCOMMANDS.map((s) => `'${s}'`).join(" ")}
          elif [ "\${words[2]}" = "new" ]; then
            _arguments '--relay[relay URL]' '--label[pairing label]'
          fi
          ;;
      esac
      ;;
  esac
}
compdef _tp tp`;
}

function generateFish(): string {
  const lines = [
    "# tp fish completion",
    ...SUBCOMMANDS.map(
      (c) => `complete -c tp -n '__fish_use_subcommand' -a '${c}' -d '${c}'`,
    ),
    ...DAEMON_SUBCOMMANDS.map(
      (s) =>
        `complete -c tp -n '__fish_seen_subcommand_from daemon' -a '${s}' -d '${s}'`,
    ),
    ...DAEMON_FLAGS.map(
      (f) =>
        `complete -c tp -n '__fish_seen_subcommand_from daemon' -l '${f.replace("--", "")}' -d '${f}'`,
    ),
    ...PAIR_SUBCOMMANDS.map(
      (s) =>
        `complete -c tp -n '__fish_seen_subcommand_from pair' -a '${s}' -d '${s}'`,
    ),
    `complete -c tp -n '__fish_seen_subcommand_from pair; and __fish_seen_subcommand_from new' -l relay -d 'relay URL'`,
    `complete -c tp -n '__fish_seen_subcommand_from pair; and __fish_seen_subcommand_from new' -l label -d 'pairing label'`,
  ];
  return lines.join("\n");
}

function generatePowerShell(): string {
  // The emitted PowerShell completer is fully self-contained — it needs
  // no profile-dir or external state. --profile-dir only affects the
  // install-time location of this script, not its runtime behavior.
  const commands = SUBCOMMANDS.map((c) => `'${c}'`).join(", ");
  const daemonSubs = DAEMON_SUBCOMMANDS.map((s) => `'${s}'`).join(", ");
  const pairSubs = PAIR_SUBCOMMANDS.map((s) => `'${s}'`).join(", ");
  const daemonFlags = DAEMON_FLAGS.map((f) => `'${f}'`).join(", ");

  return `# tp powershell completion
Register-ArgumentCompleter -Native -CommandName tp -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(${commands})
    $daemonSubs = @(${daemonSubs})
    $pairSubs = @(${pairSubs})
    $daemonFlags = @(${daemonFlags})

    $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
    $pos = $tokens.Count

    if ($pos -le 1) {
        $commands | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    }
    elseif ($tokens[1] -eq 'daemon' -and $pos -eq 2) {
        $daemonSubs | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    }
    elseif ($tokens[1] -eq 'daemon' -and $pos -ge 3) {
        $daemonFlags | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_) }
    }
    elseif ($tokens[1] -eq 'pair' -and $pos -eq 2) {
        $pairSubs | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    }
}`;
}
