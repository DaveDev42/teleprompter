import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { TerminalSearch } from "../lib/terminal-search";

/**
 * ghostty-web terminal component for Expo Web.
 * Uses libghostty WASM via Canvas 2D rendering.
 * Renders nothing on native platforms.
 */
export function GhosttyTerminal({
  onData,
  onResize,
  termRef,
  onReady,
  searchRef,
}: {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  termRef?: React.MutableRefObject<any>;
  onReady?: () => void;
  searchRef?: React.MutableRefObject<TerminalSearch | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<any>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: terminal setup must only run on mount — re-creating on prop changes would destroy terminal state
  useEffect(() => {
    if (Platform.OS !== "web") return;

    let disposed = false;

    async function setup() {
      const { init, Terminal, FitAddon } = await import("ghostty-web");
      const { TerminalSearch: Search } = await import("../lib/terminal-search");

      // Load WASM (safe to call multiple times — returns cached instance)
      await init();

      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        theme: {
          background: "#000000",
          foreground: "#ffffff",
          cursor: "#ffffff",
        },
        scrollback: 10000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      // NOTE: Use dispose() only. Never call free() — causes WASM memory corruption.
      term.open(containerRef.current);
      fitAddon.fit();

      termInstanceRef.current = term;
      if (termRef) termRef.current = term;
      if (searchRef) searchRef.current = new Search(term);

      onReady?.();

      term.onData((data: string) => {
        onData?.(data);
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        onResize?.(cols, rows);
      });

      const resizeObserver = new ResizeObserver(() => {
        if (!disposed) fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
      };
    }

    const cleanup = setup();

    return () => {
      disposed = true;
      cleanup.then((fn) => fn?.());
      termInstanceRef.current?.dispose();
      termInstanceRef.current = null;
    };
  }, []);

  if (Platform.OS !== "web") return null;

  return <div ref={containerRef} className="w-full h-full bg-black" />;
}
