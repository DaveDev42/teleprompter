/**
 * Terminal search using ghostty-web buffer API.
 *
 * Walks the buffer (scrollback + visible rows) to find text matches,
 * scrolls to the match, and highlights via selection.
 */

interface Match {
  row: number;
  col: number;
  length: number;
}

export class TerminalSearch {
  private term: any;
  private matches: Match[] = [];
  private currentIndex = -1;
  private lastQuery = "";

  constructor(term: any) {
    this.term = term;
  }

  /**
   * Find all matches for a query in the buffer.
   */
  private search(query: string, caseSensitive = false): void {
    if (query === this.lastQuery && this.matches.length > 0) return;

    this.lastQuery = query;
    this.matches = [];
    this.currentIndex = -1;

    if (!query || !this.term?.buffer?.active) return;

    const buf = this.term.buffer.active;
    const totalLines = buf.length;
    const needle = caseSensitive ? query : query.toLowerCase();

    for (let y = 0; y < totalLines; y++) {
      const line = buf.getLine(y);
      if (!line) continue;

      const text = line.translateToString(false);
      const haystack = caseSensitive ? text : text.toLowerCase();
      let startCol = 0;

      while (startCol < haystack.length) {
        const idx = haystack.indexOf(needle, startCol);
        if (idx === -1) break;
        this.matches.push({ row: y, col: idx, length: query.length });
        startCol = idx + 1;
      }
    }
  }

  /**
   * Find and scroll to the next match.
   * Returns true if a match was found.
   */
  findNext(query: string, caseSensitive = false): boolean {
    this.search(query, caseSensitive);
    if (this.matches.length === 0) return false;

    this.currentIndex = (this.currentIndex + 1) % this.matches.length;
    this.goToMatch();
    return true;
  }

  /**
   * Find and scroll to the previous match.
   */
  findPrevious(query: string, caseSensitive = false): boolean {
    this.search(query, caseSensitive);
    if (this.matches.length === 0) return false;

    this.currentIndex =
      this.currentIndex <= 0 ? this.matches.length - 1 : this.currentIndex - 1;
    this.goToMatch();
    return true;
  }

  /**
   * Get current result info (e.g. "3 of 42").
   */
  get resultInfo(): { index: number; total: number } {
    return {
      index: this.currentIndex + 1,
      total: this.matches.length,
    };
  }

  /**
   * Clear search state.
   */
  clear(): void {
    this.matches = [];
    this.currentIndex = -1;
    this.lastQuery = "";
    this.term?.clearSelection?.();
  }

  private goToMatch(): void {
    const match = this.matches[this.currentIndex];
    if (!match) return;

    // Scroll to the row containing the match
    if (this.term.scrollToLine) {
      this.term.scrollToLine(match.row);
    }

    // Highlight the match using selection
    if (this.term.select) {
      this.term.select(match.col, match.row, match.length);
    }
  }
}
