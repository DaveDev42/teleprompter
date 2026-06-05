/**
 * Unit tests for TerminalSearch.
 *
 * Uses a minimal Terminal stub that emulates ghostty-web's buffer API.
 * Does NOT import ghostty-web (WASM not available in bun:test environment).
 *
 * Covers:
 *  - Basic case-insensitive and case-sensitive matching
 *  - Cache invalidation when caseSensitive changes for the same query (idx 24/26 fix)
 *  - findNext / findPrevious navigation
 *  - clear() resets state
 *
 * Run with:
 *   bun test apps/app/src/lib/terminal-search.test.ts
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { TerminalSearch } from "./terminal-search";

// ── Minimal Terminal stub ────────────────────────────────────────────────────

/** Represents a single buffer line, matching ghostty-web's IBufferLine API. */
interface StubBufferLine {
  translateToString(trimRight?: boolean): string;
}

function makeLine(text: string): StubBufferLine {
  return {
    translateToString: () => text,
  };
}

/** Stub that emulates ghostty-web Terminal's buffer + selection API. */
function makeTerminalStub(lines: string[]) {
  const bufferLines = lines.map(makeLine);
  const selections: Array<{ col: number; row: number; length: number }> = [];
  let cleared = 0;
  let scrolledTo: number[] = [];

  return {
    buffer: {
      active: {
        get length() {
          return bufferLines.length;
        },
        getLine(y: number) {
          return bufferLines[y];
        },
      },
    },
    select(col: number, row: number, length: number) {
      selections.push({ col, row, length });
    },
    clearSelection() {
      cleared++;
    },
    scrollToLine(line: number) {
      scrolledTo.push(line);
    },
    // Inspection helpers
    get _selections() {
      return selections;
    },
    get _cleared() {
      return cleared;
    },
    get _scrolledTo() {
      return scrolledTo;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TerminalSearch", () => {
  describe("basic matching", () => {
    test("finds case-insensitive matches by default", () => {
      const term = makeTerminalStub(["Hello World", "hello again"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      expect(search.findNext("hello")).toBe(true);
      expect(search.resultInfo.total).toBe(2);
    });

    test("finds case-sensitive matches only when caseSensitive=true", () => {
      const term = makeTerminalStub(["Hello World", "hello again"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      expect(search.findNext("hello", true)).toBe(true);
      // Only "hello again" (line 1) matches case-sensitively
      expect(search.resultInfo.total).toBe(1);
    });

    test("returns false when no match found", () => {
      const term = makeTerminalStub(["foo bar"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      expect(search.findNext("zzz")).toBe(false);
      expect(search.resultInfo.total).toBe(0);
    });
  });

  describe("cache invalidation on caseSensitive toggle (idx 24/26 fix)", () => {
    test("re-runs search when caseSensitive changes with same query", () => {
      // Buffer: line 0 = "ABC" (uppercase), line 1 = "abc" (lowercase)
      const term = makeTerminalStub(["ABC", "abc"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);

      // Case-insensitive: both "ABC" and "abc" match "abc"
      expect(search.findNext("abc", false)).toBe(true);
      const insensitiveTotal = search.resultInfo.total;
      expect(insensitiveTotal).toBe(2);

      // Toggle to case-sensitive with the SAME query — must NOT return cached result
      expect(search.findNext("abc", true)).toBe(true);
      const sensitiveTotal = search.resultInfo.total;
      // Only "abc" (lowercase line 1) matches
      expect(sensitiveTotal).toBe(1);

      // The two totals must differ — proves cache was invalidated
      expect(insensitiveTotal).not.toBe(sensitiveTotal);
    });

    test("re-runs search when toggling back from case-sensitive to case-insensitive", () => {
      const term = makeTerminalStub(["ABC", "abc"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);

      // Start case-sensitive
      search.findNext("abc", true);
      expect(search.resultInfo.total).toBe(1);

      // Toggle back to case-insensitive
      search.findNext("abc", false);
      expect(search.resultInfo.total).toBe(2);
    });

    test("does NOT re-run search when both query and caseSensitive are unchanged", () => {
      const lines = ["abc", "abc"];
      let accessCount = 0;
      const term = {
        buffer: {
          active: {
            get length() {
              return lines.length;
            },
            getLine(y: number) {
              accessCount++;
              return { translateToString: () => lines[y] ?? "" };
            },
          },
        },
        select() {},
        clearSelection() {},
        scrollToLine() {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);

      search.findNext("abc", false);
      const firstAccess = accessCount;
      expect(firstAccess).toBeGreaterThan(0);

      // Second call — identical query + caseSensitive, cache should be hit
      search.findNext("abc", false);
      expect(accessCount).toBe(firstAccess); // No extra buffer reads
    });
  });

  describe("navigation", () => {
    test("findNext wraps around", () => {
      const term = makeTerminalStub(["a", "a"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      search.findNext("a");
      expect(search.resultInfo.index).toBe(1);
      search.findNext("a");
      expect(search.resultInfo.index).toBe(2);
      search.findNext("a");
      expect(search.resultInfo.index).toBe(1); // wrapped
    });

    test("findPrevious wraps around", () => {
      const term = makeTerminalStub(["a", "a"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      search.findPrevious("a");
      expect(search.resultInfo.index).toBe(2); // starts at last
    });
  });

  describe("clear()", () => {
    test("resets state and calls clearSelection", () => {
      const term = makeTerminalStub(["hello"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      search.findNext("hello");
      expect(search.resultInfo.total).toBe(1);

      search.clear();

      expect(search.resultInfo.total).toBe(0);
      expect(search.resultInfo.index).toBe(0);
      expect(term._cleared).toBe(1);
    });

    test("after clear(), toggling caseSensitive re-searches correctly", () => {
      const term = makeTerminalStub(["ABC", "abc"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const search = new TerminalSearch(term as any);
      search.findNext("abc", false);
      expect(search.resultInfo.total).toBe(2);

      search.clear();

      // After clear(), cache is reset; case-sensitive search should give 1
      search.findNext("abc", true);
      expect(search.resultInfo.total).toBe(1);
    });
  });
});
