import { CLAUDE_UTILITY_SUBCOMMANDS } from "./claude-subcommands";

/**
 * Routing decision made from the first CLI arg (`process.argv[2]`).
 *
 * The router intentionally collapses bare `tp` and unknown first args into
 * `passthrough` — anything that isn't a known tp subcommand, a claude utility
 * forward, an explicit `--`, or a tp-level help/version flag becomes a claude
 * passthrough invocation.
 *
 * The one narrow exception is `maybe-typo`: a bareword (not a `-`-prefixed
 * flag) that is close (edit-distance <= 2) to a known tp subcommand or claude
 * utility name, but isn't an exact match, is very likely a mistyped tp
 * subcommand (`tp sesion list`) rather than a genuine claude passthrough
 * prompt. Flags always stay passthrough — they belong to claude
 * (`-p`, `--model`, ...) — and any bareword too far from a known name (a
 * prompt like `hello`) still falls through to ordinary `passthrough`.
 */
export type Route =
  | { kind: "subcommand"; name: TpSubcommand }
  | { kind: "claude-utility" }
  | { kind: "forward-double-dash" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "passthrough" }
  | { kind: "maybe-typo"; name: string; suggestion: string };

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

/** All known tp-level bareword names — subcommands + claude utility forwards. */
const KNOWN_NAMES: readonly string[] = [
  ...TP_SUBCOMMANDS,
  ...CLAUDE_UTILITY_SUBCOMMANDS,
];

/**
 * Max edit distance for a bareword to be considered a likely typo of a known
 * tp subcommand / claude utility name, rather than a genuine passthrough
 * word (e.g. a prompt like "hello" or "list").
 */
const TYPO_MAX_DISTANCE = 2;

/**
 * Minimum bareword length before typo detection kicks in. Short words (<=3
 * chars) sit within edit-distance 2 of many unrelated known names ("up" vs
 * "run", "ls" vs "logs") purely by virtue of being short — that produces
 * false positives on legitimate short passthrough prompts/flags-without-dash.
 * Names this short are rare enough that requiring length >= 4 costs little
 * real typo-catching ability.
 */
const TYPO_MIN_WORD_LENGTH = 4;

/**
 * Classic Levenshtein (single-character insert/delete/substitute) edit
 * distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) {
    const row = dp[i];
    if (row) row[0] = i;
  }
  for (let j = 0; j <= n; j++) {
    const row = dp[0];
    if (row) row[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const prevRow = dp[i - 1];
      const row = dp[i];
      if (!prevRow || !row) continue;
      row[j] = Math.min(
        (prevRow[j] ?? Infinity) + 1,
        (row[j - 1] ?? Infinity) + 1,
        (prevRow[j - 1] ?? Infinity) + cost,
      );
    }
  }
  return dp[m]?.[n] ?? Math.max(m, n);
}

/**
 * Finds the closest known tp subcommand / claude utility name to `word`
 * within {@link TYPO_MAX_DISTANCE}, or `undefined` if `word` is too short
 * (see {@link TYPO_MIN_WORD_LENGTH}) or too far from every known name.
 */
function findTypoSuggestion(word: string): string | undefined {
  if (word.length < TYPO_MIN_WORD_LENGTH) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const name of KNOWN_NAMES) {
    const distance = levenshteinDistance(word, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (best && best.distance <= TYPO_MAX_DISTANCE) return best.name;
  return undefined;
}

export function decideRoute(command: string | undefined): Route {
  if (command === undefined) return { kind: "passthrough" };
  if (SUBCOMMAND_SET.has(command))
    return { kind: "subcommand", name: command as TpSubcommand };
  if (CLAUDE_UTILITY_SUBCOMMANDS.has(command))
    return { kind: "claude-utility" };
  if (command === "--") return { kind: "forward-double-dash" };
  if (HELP_FLAGS.has(command)) return { kind: "help" };
  if (VERSION_FLAGS.has(command)) return { kind: "version" };
  // Flags belong to claude (`-p`, `--model`, ...) — never typo-check them.
  if (!command.startsWith("-")) {
    const suggestion = findTypoSuggestion(command);
    if (suggestion !== undefined) {
      return { kind: "maybe-typo", name: command, suggestion };
    }
  }
  return { kind: "passthrough" };
}

/**
 * Commands where a "new version available" stderr line is acceptable and
 * genuinely useful for the interactive user. Everything else — status/logs,
 * daemon/relay long-running processes, run-under-PTY, version output parsed
 * by scripts — should not pay the cost or risk stderr contamination.
 */
const VERSION_CHECK_SUBCOMMANDS = new Set<string>([
  "upgrade",
  "doctor",
  "pair",
]);

export function shouldCheckForUpdates(route: Route): boolean {
  if (route.kind === "passthrough") return true;
  if (route.kind === "subcommand")
    return VERSION_CHECK_SUBCOMMANDS.has(route.name);
  return false;
}
