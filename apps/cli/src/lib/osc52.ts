/**
 * OSC 52 clipboard helper — writes to the system clipboard via terminal
 * escape sequences without requiring native dependencies.
 *
 * Design decisions:
 * - BEL (`\x07`) terminator rather than ST (`\x1b\\`) — iTerm2, Alacritty,
 *   WezTerm, Ghostty, Kitty, Terminal.app all honour BEL; some terminals are
 *   flaky with ST.
 * - tmux passthrough: wraps with `\x1bPtmux;\x1b]52;c;<b64>\x07\x1b\\` when
 *   `$TMUX` is set.  Requires `set -g allow-passthrough on` on the user side.
 * - GNU screen passthrough: wraps with `\x1bP]52;c;<b64>\x07\x1b\\` when
 *   `$STY` is set.
 * - No library dependency: the entire implementation is ~40 lines. Evaluated
 *   npm candidates (`osc52`, `clipboardy`, `copy-paste`) — none exist or fit:
 *   `osc52` is not published, `clipboardy` uses native pbcopy/xclip binaries,
 *   `copy-paste` is similarly native.  Inlining avoids native deps and matches
 *   the "zero native" constraint of the Bun compile target.
 *
 * @module
 */

/** Known-good $TERM_PROGRAM values (terminal apps that support OSC 52). */
const KNOWN_GOOD_PROGRAMS = new Set([
  "iTerm.app",
  "vscode",
  "Apple_Terminal",
  "WezTerm",
  "ghostty",
  "Hyper",
]);

/** Known-good $TERM prefixes/values. */
const KNOWN_GOOD_TERMS = ["xterm", "screen", "tmux", "alacritty", "kitty"];

/**
 * Heuristic: is OSC 52 clipboard copy likely to be honoured by this terminal?
 *
 * Returns `false` when we know it can't work (non-TTY stdout, dumb $TERM).
 * Returns `true` when we detect a known-good terminal or a multiplexer.
 * Returns `true` optimistically for unknown terminals so the hint still shows.
 */
export function isClipboardSupportLikely(): boolean {
  if (!process.stdout.isTTY) return false;
  const term = process.env.TERM ?? "";
  if (term === "dumb" || term === "") return false;

  // Multiplexer detected → attempt passthrough
  if (process.env.TMUX || process.env.STY) return true;

  // Known-good terminal program
  const prog = process.env.TERM_PROGRAM ?? "";
  if (KNOWN_GOOD_PROGRAMS.has(prog)) return true;

  // Known-good $TERM prefix
  if (KNOWN_GOOD_TERMS.some((t) => term.startsWith(t))) return true;

  // Unknown terminal — optimistic: show the hint anyway, user finds out on 'c'
  return true;
}

export interface ClipboardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Synchronously write an OSC 52 sequence to process.stdout to copy `text`
 * to the terminal's clipboard.
 *
 * Returns `{ ok: true }` when the sequence was written, or
 * `{ ok: false, reason }` when the environment makes it impossible.
 */
export function copyToClipboard(text: string): ClipboardResult {
  // Sanity-check the environment before writing anything.
  if (!process.stdout.isTTY) {
    return { ok: false, reason: "stdout is not a TTY" };
  }
  const term = process.env.TERM ?? "";
  if (term === "dumb" || term === "") {
    return { ok: false, reason: "$TERM is dumb or unset" };
  }

  const b64 = Buffer.from(text, "utf8").toString("base64");
  const inner = `\x1b]52;c;${b64}\x07`;

  let seq: string;
  if (process.env.TMUX) {
    // tmux DCS passthrough: each ESC inside the payload must be doubled
    const escaped = inner.replace(/\x1b/g, "\x1b\x1b");
    seq = `\x1bPtmux;${escaped}\x1b\\`;
  } else if (process.env.STY) {
    // GNU screen DCS passthrough
    seq = `\x1bP${inner}\x1b\\`;
  } else {
    seq = inner;
  }

  process.stdout.write(seq);
  return { ok: true };
}
