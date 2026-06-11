import type { MutableRefObject } from "react";
import type { TerminalSearch } from "./terminal-search";

/**
 * Shared contract between SessionTerminalView and the platform terminal
 * implementations (GhosttyTerminal on web, GhosttyNative's WebView bridge
 * on iOS/Android, and any future native module — see
 * docs/native-terminal-plan.md). Consumers must treat everything beyond
 * `write` as a capability: probe for presence instead of branching on
 * Platform.OS, so a richer native implementation lights features up
 * without touching call sites.
 */

/** One line of a terminal buffer (ghostty-web / xterm.js compatible). */
export interface TermBufferLine {
  translateToString(trimRight?: boolean): string;
}

/** Scrollback + viewport buffer read surface. */
export interface TermBuffer {
  length: number;
  getLine(y: number): TermBufferLine | undefined;
}

export interface TermHandle {
  /**
   * Feed decrypted PTY output. SessionTerminalView passes Uint8Array for
   * base64-decoded io records and falls back to the raw string when atob
   * throws — implementations must accept both.
   */
  write(data: string | Uint8Array): void;
  /** Buffer reads (terminal search, voice context). Web only today. */
  buffer?: { active?: TermBuffer };
  cols?: number;
  rows?: number;
}

/** Props every platform terminal component accepts. */
export interface TerminalViewProps {
  /** Keystrokes captured by the terminal, bound for the PTY. */
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  termRef?: MutableRefObject<TermHandle | null>;
  /** Fired once the renderer can accept writes — gates record replay. */
  onReady?: () => void;
  searchRef?: MutableRefObject<TerminalSearch | null>;
}
