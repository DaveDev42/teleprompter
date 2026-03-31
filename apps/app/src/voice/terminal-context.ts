/**
 * Extract terminal buffer content for voice context injection.
 *
 * Reads the visible lines from the terminal instance (ghostty-web or xterm.js
 * compatible buffer API) and formats them for inclusion in the Realtime API
 * system prompt.
 */

/** Minimal terminal interface for buffer access (ghostty-web or xterm.js compatible) */
interface TerminalLike {
  buffer?: {
    active?: {
      length: number;
      getLine(
        y: number,
      ): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/**
 * Get the last N lines of visible terminal content.
 */
export function getTerminalLines(term: TerminalLike, maxLines = 50): string[] {
  if (!term?.buffer?.active) return [];

  const buffer = term.buffer.active;
  const lines: string[] = [];
  const totalRows = buffer.length;
  const startRow = Math.max(0, totalRows - maxLines);

  for (let i = startRow; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (line) {
      const text = line.translateToString(true); // trim whitespace
      lines.push(text);
    }
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  return lines;
}

/**
 * Format terminal content for inclusion in a system prompt.
 */
export function formatTerminalContext(
  term: TerminalLike,
  maxLines = 30,
): string {
  const lines = getTerminalLines(term, maxLines);
  if (lines.length === 0) return "";

  return `\n\n--- Terminal Output (last ${lines.length} lines) ---\n${lines.join("\n")}\n--- End Terminal ---`;
}
