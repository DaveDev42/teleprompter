/**
 * tp completions — generate shell completion scripts.
 *
 * Usage:
 *   eval "$(tp completions bash)"
 *   eval "$(tp completions zsh)"
 *   eval "$(tp completions fish)"
 */

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
