/**
 * Remove ANSI escape sequences and bare control characters from a string so
 * the result is safe to drop into a plain-text chat bubble.
 *
 * Intentionally pragmatic rather than exhaustive: it only has to cover the
 * escape subset that Claude Code's PTY output actually uses. Sequence classes
 * handled:
 *   - CSI (`ESC [ <prefix>* <param>* <intermediate>* <final>`) — SGR colors,
 *     cursor movement, erase, plus private-use prefixes (`?`, `>`, `<`, `=`,
 *     `!`) used for keyboard/mouse mode reporting (e.g. `ESC [ > 4 m`,
 *     `ESC [ < u`)
 *   - OSC (`ESC ] ... BEL`) and the ST-terminated variant (`ESC ] ... ESC \\`)
 *     — window titles, hyperlinks
 *   - SS2/SS3 + charset designators (`ESC ( X`, `ESC ) X`)
 *   - Keypad / cursor-key mode toggles (`ESC >`, `ESC =`, `ESC <`)
 *   - Save/restore cursor (`ESC 7`, `ESC 8`)
 *   - Double-ESC (stray escape-escape pair)
 *   - Bare C0 control bytes other than \t/\n
 *   - CRLF / lone CR normalisation to LF
 *
 * Things it deliberately does not handle (ghostty owns the terminal view;
 * chat view only receives plaintext): DCS, PM, APC, OSC 52 clipboard.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // OSC: ESC ] ... terminated by BEL or ST (ESC \). Match ST first so the
      // CSI rule below doesn't eat the closing ESC of an OSC sequence.
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      // CSI: ESC [ <private-prefix>? <params> <intermediates>? <final>
      // Private-prefix bytes 0x3C..0x3F (`<`, `=`, `>`, `?`) appear *inside*
      // some CSI variants (e.g. `ESC [ > 4 m` set keyboard mode). The earlier
      // pattern only allowed `?`, so other private-prefix sequences leaked
      // their `>`/`<`/`=` characters into the chat bubble (PR #193).
      .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "")
      .replace(/\x1b[>=<78]/g, "")
      .replace(/\x1b\x1b/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/\r\n?/g, "\n")
  );
}
