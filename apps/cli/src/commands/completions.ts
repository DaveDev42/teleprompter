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
  type InstallShell,
  installCompletion,
  uninstallCompletion,
} from "./completions-install";

const SUBCOMMANDS = [
  "daemon",
  "run",
  "relay",
  "pair",
  "session",
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
// Mirrors the verbs in sessionCommand() router in session.ts.
const SESSION_SUBCOMMANDS = ["list", "delete", "prune", "cleanup"];
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
for (const name of [
  ...SUBCOMMANDS,
  ...PAIR_SUBCOMMANDS,
  ...SESSION_SUBCOMMANDS,
  ...DAEMON_SUBCOMMANDS,
]) {
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

Shells: bash, zsh, fish
Flags:
  --force                Overwrite existing installation
  --uninstall            Remove installed completions
  --dry-run              Show what would change without writing
  --help, -h             Show this help

Notes:
  Fish writes completion files to disk; rerun
  'tp completions install fish --force' after 'tp upgrade' to refresh.`;

const INSTALL_FLAG_ALLOWLIST = new Set([
  "--force",
  "--dry-run",
  "--uninstall",
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

  switch (shell) {
    case "bash":
      console.log(generateBash());
      break;
    case "zsh":
      console.log(generateZsh());
      break;
    case "fish":
      console.log(generateFish());
      break;
    default:
      console.error(`Unknown shell: ${shell}`);
      console.error("Supported: bash, zsh, fish");
      process.exit(1);
  }
}

function runInstall(argv: string[]): void {
  // Help flag check.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(INSTALL_USAGE);
    process.exit(0);
  }

  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const uninstall = argv.includes("--uninstall");

  // Reject unknown flags.
  for (const a of argv) {
    if (a.startsWith("-") && a !== "-" && !INSTALL_FLAG_ALLOWLIST.has(a)) {
      console.error(`Unknown flag: ${a}`);
      console.error(INSTALL_USAGE);
      process.exit(1);
    }
  }

  const positional = argv.find((a) => !a.startsWith("-"));
  const requested = positional as Shell | undefined;

  const shell: Shell | null =
    requested ?? detectShell(process.env, process.platform);

  if (!shell) {
    const hint = process.env.SHELL
      ? `Detected $SHELL=${process.env.SHELL} (unsupported).`
      : "$SHELL is not set and no $ZSH_VERSION / $BASH_VERSION / $FISH_VERSION detected.";
    console.error(
      `Could not detect shell. ${hint} Run 'tp completions install <bash|zsh|fish>'.`,
    );
    process.exit(1);
  }

  if (uninstall) {
    const r = uninstallCompletion({ shell, dryRun });
    if (r.status === "dry-run") {
      console.log(r.plan);
    } else if (r.status === "uninstalled") {
      console.error(`tp completions removed for ${shell} (${r.file})`);
    } else {
      console.error(`tp completions not installed for ${shell}`);
    }
    return;
  }

  const r = installCompletion({ shell, force, dryRun });

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
  elif [ "\${COMP_WORDS[1]}" = "session" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "${SESSION_SUBCOMMANDS.join(" ")}" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "session" ] && [ "\${COMP_WORDS[2]}" = "prune" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "--older-than --all --running --dry-run --yes" -- "$cur") )
  elif [ "\${COMP_WORDS[1]}" = "session" ] && [ "\${COMP_WORDS[2]}" = "cleanup" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "--all --yes" -- "$cur") )
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
        session)
          if [ "\${#words[@]}" -le 2 ]; then
            _values 'session subcommand' ${SESSION_SUBCOMMANDS.map((s) => `'${s}'`).join(" ")}
          elif [ "\${words[2]}" = "prune" ]; then
            _arguments '--older-than[age cutoff (Nd|Nh|Nm|Ns)]' '--all[all stopped]' '--running[include running]' '--dry-run[preview only]' '--yes[skip confirmation]'
          elif [ "\${words[2]}" = "cleanup" ]; then
            _arguments '--all[pre-select all stopped]' '--yes[skip confirmation]'
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
    ...SESSION_SUBCOMMANDS.map(
      (s) =>
        `complete -c tp -n '__fish_seen_subcommand_from session' -a '${s}' -d '${s}'`,
    ),
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l older-than -d 'age cutoff (Nd|Nh|Nm|Ns)'`,
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l all -d 'all stopped sessions'`,
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l running -d 'also include running'`,
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l dry-run -d 'preview only'`,
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l yes -d 'skip confirmation'`,
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from cleanup' -l all -d 'pre-select all stopped sessions'`,
    `complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from cleanup' -l yes -d 'skip confirmation'`,
  ];
  return lines.join("\n");
}
