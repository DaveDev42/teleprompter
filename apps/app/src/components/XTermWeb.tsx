import { useEffect, useRef } from "react";
import { Platform } from "react-native";

/**
 * xterm.js terminal component for Expo Web.
 * Renders nothing on native platforms (iOS/Android will use WebView in Stage 5).
 */
export function XTermWeb({
  onData,
  onResize,
  termRef,
  onReady,
}: {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  termRef?: React.MutableRefObject<any>;
  onReady?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;

    let disposed = false;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      const { SearchAddon } = await import("@xterm/addon-search");

      // Dynamic CSS import for xterm
      if (!document.querySelector('link[data-xterm-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@6/css/xterm.min.css";
        link.setAttribute("data-xterm-css", "true");
        document.head.appendChild(link);
      }

      if (disposed || !containerRef.current) return;

      const fitAddon = new FitAddon();
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
        convertEol: false,
      });

      const searchAddon = new SearchAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(searchAddon);
      term.open(containerRef.current);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      if (termRef) {
        termRef.current = term;
        (term as any).searchAddon = searchAddon;
      }

      // Signal ready — triggers resume/replay in terminal screen
      onReady?.();

      term.onData((data: string) => {
        onData?.(data);
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        onResize?.(cols, rows);
      });

      // Handle window resize
      const resizeObserver = new ResizeObserver(() => {
        if (!disposed) fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup.then((fn) => fn?.());
      xtermRef.current?.dispose();
      xtermRef.current = null;
    };
  }, []);

  if (Platform.OS !== "web") return null;

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-black"
    />
  );
}
