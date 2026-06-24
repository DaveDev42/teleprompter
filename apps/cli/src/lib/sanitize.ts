/**
 * Output-sanitization helpers.
 *
 * These guard the boundary where externally-influenced strings (CLI flag
 * values, a release tag from the GitHub API, PTY bytes from a monitored
 * session, a HOME/XDG path) are written to a terminal or interpolated into a
 * generated config file (launchd plist XML, systemd unit INI). They are
 * DISPLAY/FILE-GENERATION sanitizers only — never apply them to a value that is
 * forwarded over the wire (e.g. a relay URL going into the pairing bundle); the
 * peer needs the verbatim value.
 */

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// CSI (ESC [ ... final-byte) and a broad ESC-introduced sequence catch-all.
const CSI_AND_ESC = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
// OSC (ESC ] ... terminated by BEL or ST). Used both standalone (clipboard /
// hyperlink stripping) and inside stripAnsi.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Strip ANSI/VT escape sequences and stray control bytes from a string so it
 * can be safely printed to a TTY. Preserves newlines and tabs (they are benign
 * and often intentional in multi-line CLI output); removes ESC-introduced
 * sequences (CSI/OSC) and all other C0/C1 control characters.
 */
export function stripAnsi(s: string): string {
  return s.replace(OSC, "").replace(CSI_AND_ESC, "").replace(CONTROL_CHARS, "");
}

/**
 * Strip ONLY the high-risk OSC sequences a terminal acts on — OSC 52
 * (clipboard write) and OSC 8 (hyperlink) — while preserving benign ANSI
 * (colors, cursor movement). Use for relaying trusted-but-untrusted PTY output
 * verbatim where readability of color/cursor sequences matters but
 * clipboard/hyperlink injection must not pass through.
 */
export function stripDangerousOsc(s: string): string {
  return s.replace(/\x1b\](?:8|52)[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Escape the five XML predefined entities so an interpolated value cannot break
 * out of an XML <string> element (used when generating the launchd plist). A
 * stray `&`, `<`, or `>` in a user-controlled path/label otherwise produces
 * malformed XML that launchctl silently fails to parse.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
