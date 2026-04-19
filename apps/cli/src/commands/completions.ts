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

const PAIR_SUBCOMMANDS = ["new", "list", "delete"];
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

export function completionsCommand(argv: string[]): void {
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
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const uninstall = argv.includes("--uninstall");
  const legacyPowerShell = argv.includes("--legacy-powershell");

  const positional = argv.find((a) => !a.startsWith("--"));
  const requested =
    positional === "pwsh" ? "powershell" : (positional as Shell | undefined);

  const shell: Shell | null =
    requested ?? detectShell(process.env, process.platform);

  if (!shell) {
    console.error(
      "Could not detect shell. Run 'tp completions install <bash|zsh|fish|powershell>'.",
    );
    process.exit(1);
  }

  if (uninstall) {
    const r = uninstallCompletion({ shell, legacyPowerShell });
    if (r.status === "uninstalled") {
      console.log(`tp completions removed for ${shell} (${r.file})`);
    } else {
      console.log(`tp completions not installed for ${shell}`);
    }
    return;
  }

  const r = installCompletion({
    shell: shell as InstallShell,
    force,
    dryRun,
    legacyPowerShell,
  });

  if (r.status === "dry-run") {
    console.log(r.plan);
  } else if (r.status === "already-installed") {
    console.log(`tp completions already installed for ${shell} (${r.file})`);
  } else {
    console.log(`tp completions installed for ${shell} (${r.file})`);
    console.log("Restart your shell or source your rc file to activate.");
  }
}

export function renderCompletion(
  shell: "bash" | "zsh" | "fish" | "powershell",
): string {
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
${DAEMON_FLAGS.map((f) => `              '${f}[${f}]'`).join(" \\\n")}
          fi
          ;;
        pair)
          _values 'pair subcommand' ${PAIR_SUBCOMMANDS.map((s) => `'${s}'`).join(" ")}
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
  ];
  return lines.join("\n");
}

function generatePowerShell(): string {
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
