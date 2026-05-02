import { CLAUDE_UTILITY_SUBCOMMANDS } from "./claude-subcommands";

/**
 * Routing decision made from the first CLI arg (`process.argv[2]`).
 *
 * The router intentionally collapses bare `tp` and unknown first args into
 * `passthrough` — anything that isn't a known tp subcommand, a claude utility
 * forward, an explicit `--`, or a tp-level help/version flag becomes a claude
 * passthrough invocation.
 */
export type Route =
  | { kind: "subcommand"; name: TpSubcommand }
  | { kind: "claude-utility" }
  | { kind: "forward-double-dash" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "passthrough" };

export const TP_SUBCOMMANDS = [
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
] as const;

export type TpSubcommand = (typeof TP_SUBCOMMANDS)[number];

const SUBCOMMAND_SET = new Set<string>(TP_SUBCOMMANDS);
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

export function decideRoute(command: string | undefined): Route {
  if (command === undefined) return { kind: "passthrough" };
  if (SUBCOMMAND_SET.has(command))
    return { kind: "subcommand", name: command as TpSubcommand };
  if (CLAUDE_UTILITY_SUBCOMMANDS.has(command)) return { kind: "claude-utility" };
  if (command === "--") return { kind: "forward-double-dash" };
  if (HELP_FLAGS.has(command)) return { kind: "help" };
  if (VERSION_FLAGS.has(command)) return { kind: "version" };
  return { kind: "passthrough" };
}

/**
 * Commands where a "new version available" stderr line is acceptable and
 * genuinely useful for the interactive user. Everything else — status/logs,
 * daemon/relay long-running processes, run-under-PTY, version output parsed
 * by scripts — should not pay the cost or risk stderr contamination.
 */
const VERSION_CHECK_SUBCOMMANDS = new Set<string>(["upgrade", "doctor", "pair"]);

export function shouldCheckForUpdates(route: Route): boolean {
  if (route.kind === "passthrough") return true;
  if (route.kind === "subcommand")
    return VERSION_CHECK_SUBCOMMANDS.has(route.name);
  return false;
}
