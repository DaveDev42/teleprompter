//! `tp completions <bash|zsh|fish>` — emit a shell completion script.
//!
//! Byte-exact port of `apps/cli/src/commands/completions.ts:202-313`.
//!
//! Only the script-generation path is ported here (tranche 1). The
//! `install` / `uninstall` sub-actions write to rc files (tranche 2) and
//! are routed to `not_yet_ported` by the caller in `main.rs`.
//!
//! Error path (unknown shell): two lines to **stderr**, exit 1.
//! Matches `completions.ts:124-127`.

use std::process::ExitCode;

// ──────────────────────────────────────────────────────────────────────────────
// Hard-coded command/flag lists (mirrors completions.ts:17-60).
// ──────────────────────────────────────────────────────────────────────────────

const SUBCOMMANDS: &[&str] = &[
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

// completions.ts:42 – mirrors pairCommand() router
const PAIR_SUBCOMMANDS: &[&str] = &["new", "list", "delete", "rename"];
// completions.ts:44 – mirrors sessionCommand() router
const SESSION_SUBCOMMANDS: &[&str] = &["list", "delete", "prune", "cleanup"];
// completions.ts:45
const DAEMON_SUBCOMMANDS: &[&str] = &["start", "status", "install", "uninstall"];

// completions.ts:47-60
const DAEMON_FLAGS: &[&str] = &[
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

// ──────────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────────

/// Emit a completion script for the requested shell, or report an error.
///
/// `shell` defaults to `"bash"` when `None` (completions.ts:112).
pub fn run(shell: Option<&str>) -> ExitCode {
    let shell = shell.unwrap_or("bash");
    match shell {
        "bash" => {
            // completions.ts:116 — console.log adds trailing \n
            println!("{}", generate_bash());
            ExitCode::SUCCESS
        }
        "zsh" => {
            println!("{}", generate_zsh());
            ExitCode::SUCCESS
        }
        "fish" => {
            println!("{}", generate_fish());
            ExitCode::SUCCESS
        }
        other => {
            // completions.ts:124-127
            eprintln!("Unknown shell: {other}");
            eprintln!("Supported: bash, zsh, fish");
            ExitCode::FAILURE
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Generator functions (pure string builders)
// ──────────────────────────────────────────────────────────────────────────────

/// Byte-exact port of `completions.ts:202-229` (`generateBash`).
fn generate_bash() -> String {
    // completions.ts:208 — SUBCOMMANDS.join(" ")
    let commands = SUBCOMMANDS.join(" ");
    // completions.ts:213 — DAEMON_SUBCOMMANDS.join(" ")
    let daemon_subs = DAEMON_SUBCOMMANDS.join(" ");
    // completions.ts:215 — DAEMON_FLAGS.join(" ")
    let daemon_flags = DAEMON_FLAGS.join(" ");
    // completions.ts:217 — PAIR_SUBCOMMANDS.join(" ")
    let pair_subs = PAIR_SUBCOMMANDS.join(" ");
    // completions.ts:221 — SESSION_SUBCOMMANDS.join(" ")
    let session_subs = SESSION_SUBCOMMANDS.join(" ");

    format!(
        r#"# tp bash completion
_tp_completions() {{
  local cur prev commands
  cur="${{COMP_WORDS[COMP_CWORD]}}"
  prev="${{COMP_WORDS[COMP_CWORD-1]}}"
  commands="{commands}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "daemon" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "{daemon_subs}" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "daemon" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "{daemon_flags}" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "pair" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "{pair_subs}" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "pair" ] && [ "${{COMP_WORDS[2]}}" = "new" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "--relay --label" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "session" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "{session_subs}" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "session" ] && [ "${{COMP_WORDS[2]}}" = "prune" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "--older-than --all --running --dry-run --yes" -- "$cur") )
  elif [ "${{COMP_WORDS[1]}}" = "session" ] && [ "${{COMP_WORDS[2]}}" = "cleanup" ] && [ "$COMP_CWORD" -ge 3 ]; then
    COMPREPLY=( $(compgen -W "--all --yes" -- "$cur") )
  fi
}}
complete -F _tp_completions tp"#
    )
}

/// Byte-exact port of `completions.ts:231-278` (`generateZsh`).
///
/// Key formatting details:
/// - `commands=(…)` block: each entry indented 4 spaces, `'name:name command'`
///   (completions.ts:236, `.join("\n")`).
/// - `_arguments -C \` block: trailing ` \` on each line except the last
///   (completions.ts:239-241).
/// - daemon `_arguments \` continuation block: flags joined with `" \\\n"`
///   (completions.ts:254), each flag indented 14 spaces.
fn generate_zsh() -> String {
    // completions.ts:236 — map then join("\n")
    let commands_block = SUBCOMMANDS
        .iter()
        .map(|c| format!("    '{c}:{c} command'"))
        .collect::<Vec<_>>()
        .join("\n");

    // completions.ts:251 — DAEMON_SUBCOMMANDS.map(s => `'${s}'`).join(" ")
    let daemon_subs_values = DAEMON_SUBCOMMANDS
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(" ");

    // completions.ts:254 — DAEMON_FLAGS.map(f => `'${f}[…]'`).join(" \\\n")
    // Each flag is indented 14 spaces.
    let daemon_flags_args = DAEMON_FLAGS
        .iter()
        .map(|f| {
            let name = f.trim_start_matches("--");
            format!("              '{f}[{name}]'")
        })
        .collect::<Vec<_>>()
        .join(" \\\n");

    // completions.ts:259 — PAIR_SUBCOMMANDS.map(s => `'${s}'`).join(" ")
    let pair_subs_values = PAIR_SUBCOMMANDS
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(" ");

    // completions.ts:266 — SESSION_SUBCOMMANDS.map(s => `'${s}'`).join(" ")
    let session_subs_values = SESSION_SUBCOMMANDS
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(" ");

    format!(
        r#"# tp zsh completion
_tp() {{
  local -a commands
  commands=(
{commands_block}
  )

  _arguments -C \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe 'tp commands' commands
      ;;
    args)
      case ${{words[1]}} in
        daemon)
          if [ "${{#words[@]}}" -le 2 ]; then
            _values 'daemon subcommand' {daemon_subs_values}
          else
            _arguments \
{daemon_flags_args}
          fi
          ;;
        pair)
          if [ "${{#words[@]}}" -le 2 ]; then
            _values 'pair subcommand' {pair_subs_values}
          elif [ "${{words[2]}}" = "new" ]; then
            _arguments '--relay[relay URL]' '--label[pairing label]'
          fi
          ;;
        session)
          if [ "${{#words[@]}}" -le 2 ]; then
            _values 'session subcommand' {session_subs_values}
          elif [ "${{words[2]}}" = "prune" ]; then
            _arguments '--older-than[age cutoff (Nd|Nh|Nm|Ns)]' '--all[all stopped]' '--running[include running]' '--dry-run[preview only]' '--yes[skip confirmation]'
          elif [ "${{words[2]}}" = "cleanup" ]; then
            _arguments '--all[pre-select all stopped]' '--yes[skip confirmation]'
          fi
          ;;
      esac
      ;;
  esac
}}
compdef _tp tp"#
    )
}

/// Byte-exact port of `completions.ts:280-313` (`generateFish`).
///
/// Builds a `Vec<String>` of `complete` lines then joins with `"\n"`
/// (completions.ts:312). `println!` appends the final `\n`.
fn generate_fish() -> String {
    let mut lines: Vec<String> = Vec::new();

    // completions.ts:282 — first element is the comment
    lines.push("# tp fish completion".to_owned());

    // completions.ts:283-285
    for c in SUBCOMMANDS {
        lines.push(format!(
            "complete -c tp -n '__fish_use_subcommand' -a '{c}' -d '{c}'"
        ));
    }

    // completions.ts:286-289
    for s in DAEMON_SUBCOMMANDS {
        lines.push(format!(
            "complete -c tp -n '__fish_seen_subcommand_from daemon' -a '{s}' -d '{s}'"
        ));
    }

    // completions.ts:290-293 — flag: strip leading "--"
    for f in DAEMON_FLAGS {
        let name = f.trim_start_matches("--");
        lines.push(format!(
            "complete -c tp -n '__fish_seen_subcommand_from daemon' -l '{name}' -d '{f}'"
        ));
    }

    // completions.ts:294-298
    for s in PAIR_SUBCOMMANDS {
        lines.push(format!(
            "complete -c tp -n '__fish_seen_subcommand_from pair' -a '{s}' -d '{s}'"
        ));
    }

    // completions.ts:298-299 (static lines)
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from pair; and __fish_seen_subcommand_from new' -l relay -d 'relay URL'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from pair; and __fish_seen_subcommand_from new' -l label -d 'pairing label'".to_owned(),
    );

    // completions.ts:300-303
    for s in SESSION_SUBCOMMANDS {
        lines.push(format!(
            "complete -c tp -n '__fish_seen_subcommand_from session' -a '{s}' -d '{s}'"
        ));
    }

    // completions.ts:303-310 (static lines)
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l older-than -d 'age cutoff (Nd|Nh|Nm|Ns)'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l all -d 'all stopped sessions'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l running -d 'also include running'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l dry-run -d 'preview only'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from prune' -l yes -d 'skip confirmation'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from cleanup' -l all -d 'pre-select all stopped sessions'".to_owned(),
    );
    lines.push(
        "complete -c tp -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from cleanup' -l yes -d 'skip confirmation'".to_owned(),
    );

    // completions.ts:312 — lines.join("\n")
    lines.join("\n")
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the substring assertions in completions.test.ts.

    #[test]
    fn bash_contains_all_subcommands() {
        let out = generate_bash();
        // tp subcommands
        for sub in &[
            "run",
            "daemon",
            "relay",
            "pair",
            "session",
            "status",
            "logs",
            "doctor",
            "upgrade",
            "completions",
            "version",
        ] {
            assert!(out.contains(sub), "bash missing subcommand: {sub}");
        }
        // Claude utility subcommands
        for sub in &[
            "auth",
            "mcp",
            "install",
            "update",
            "agents",
            "auto-mode",
            "plugin",
            "plugins",
            "setup-token",
        ] {
            assert!(out.contains(sub), "bash missing claude sub: {sub}");
        }
    }

    #[test]
    fn bash_contains_session_subcommands_joined() {
        // completions.test.ts: expect(result).toContain("list delete prune cleanup")
        assert!(generate_bash().contains("list delete prune cleanup"));
    }

    #[test]
    fn bash_contains_daemon_subcommands_joined() {
        // completions.test.ts: expect(result).toContain("start status install uninstall")
        assert!(generate_bash().contains("start status install uninstall"));
    }

    #[test]
    fn bash_no_legacy_ws_flags() {
        let out = generate_bash();
        assert!(!out.contains("--ws-port"));
        assert!(!out.contains("--web-dir"));
    }

    #[test]
    fn zsh_contains_run_subcommand() {
        // completions.test.ts: expect(result).toContain("'run:run command'")
        assert!(generate_zsh().contains("'run:run command'"));
    }

    #[test]
    fn zsh_contains_session_subcommands() {
        let out = generate_zsh();
        assert!(out.contains("session subcommand"));
        assert!(out.contains("'prune'"));
        assert!(out.contains("'cleanup'"));
    }

    #[test]
    fn fish_contains_run_subcommand() {
        // completions.test.ts: expect(result).toContain("-a 'run'")
        assert!(generate_fish().contains("-a 'run'"));
    }

    #[test]
    fn fish_contains_daemon_status() {
        // completions.test.ts: expect(result).toContain("__fish_seen_subcommand_from daemon' -a 'status'")
        assert!(generate_fish().contains("__fish_seen_subcommand_from daemon' -a 'status'"));
    }

    #[test]
    fn fish_contains_session_prune_flags() {
        let out = generate_fish();
        assert!(out.contains("__fish_seen_subcommand_from session' -a 'prune'"));
        assert!(out.contains("-l older-than"));
        assert!(out.contains("-l dry-run"));
    }

    #[test]
    fn fish_contains_session_cleanup() {
        let out = generate_fish();
        assert!(out.contains("__fish_seen_subcommand_from session' -a 'cleanup'"));
        assert!(out.contains("__fish_seen_subcommand_from cleanup' -l all"));
    }
}
