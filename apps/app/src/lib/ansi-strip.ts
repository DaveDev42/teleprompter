/**
 * Remove ANSI escape sequences and bare control characters from a string so
 * the result is safe to drop into a plain-text chat bubble.
 *
 * Intentionally pragmatic rather than exhaustive: it only has to cover the
 * escape subset that Claude Code's PTY output actually uses. Sequence classes
 * handled:
 *   - CSI (`ESC [ ... letter`) — SGR colors, cursor movement, erase
 *   - OSC (`ESC ] ... BEL`)    — window titles, hyperlinks
 *   - SS2/SS3 + charset designators (`ESC ( X`, `ESC ) X`)
 *   - Keypad / cursor-key mode toggles (`ESC >`, `ESC =`, `ESC <`)
 *   - Double-ESC (stray escape-escape pair)
 *   - Bare C0 control bytes other than \t/\n
 *   - CRLF / lone CR normalisation to LF
 *
 * Things it deliberately does not handle (ghostty owns the terminal view;
 * chat view only receives plaintext): DCS, PM, APC, mouse reports beyond the
 * CSI basics, OSC 52 clipboard.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[>=<]/g, "")
    .replace(/\x1b\x1b/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\r\n?/g, "\n");
}
