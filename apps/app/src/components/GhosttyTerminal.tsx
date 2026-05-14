import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { TerminalSearch } from "../lib/terminal-search";
import { TERMINAL_COLORS } from "../lib/tokens";
import { useSettingsStore } from "../stores/settings-store";

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
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;

  useEffect(() => {
    if (Platform.OS !== "web") return;

    let disposed = false;

    async function setup() {
      const { init, Terminal } = await import("ghostty-web");
      const { TerminalSearch: Search } = await import("../lib/terminal-search");

      // Load WASM (safe to call multiple times — returns cached instance)
      await init();

      if (disposed || !containerRef.current) return;

      const settings = useSettingsStore.getState();
      const term = new Terminal({
        cursorBlink: true,
        fontSize: settings.fontSize,
        fontFamily: `${settings.terminalFont}, Menlo, Monaco, 'Courier New', monospace`,
        theme: { ...TERMINAL_COLORS },
        scrollback: 10000,
      });

      // NOTE: Use dispose() only. Never call free() — causes WASM memory corruption.
      term.open(containerRef.current);

      // Custom fit: ghostty-web's FitAddon reserves 15px on the right for the
      // scrollbar, which on a 375px mobile viewport eats 2 columns and makes
      // claude TUI's status bar look clipped. Skip the reservation — the
      // scrollbar fades in/out and overlays the last column briefly, which
      // is the standard behavior in xterm/Alacritty/iTerm and is much less
      // jarring than a permanently empty gutter.
      const fit = () => {
        if (!containerRef.current || !term.renderer) return;
        const metrics = term.renderer.getMetrics();
        if (!metrics || metrics.width === 0 || metrics.height === 0) return;
        const el = containerRef.current;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === 0 || h === 0) return;
        const cols = Math.max(2, Math.floor(w / metrics.width));
        const rows = Math.max(1, Math.floor(h / metrics.height));
        if (cols !== term.cols || rows !== term.rows) {
          term.resize(cols, rows);
        }
      };
      fit();

      termInstanceRef.current = term;
      if (termRef) termRef.current = term;
      if (searchRef) searchRef.current = new Search(term);

      onReadyRef.current?.();

      term.onData((data: string) => {
        onDataRef.current?.(data);
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        onResizeRef.current?.(cols, rows);
      });

      // Emit an initial size so the consumer (and the PTY behind it) starts
      // at the actual canvas dimensions, not the runner's hard-coded 120x40.
      // claude TUI paints its splash on first byte from the PTY; if the
      // child's winsize is wrong at that moment, the splash anchors at the
      // wrong column count and a later SIGWINCH only partially repaints —
      // leaving the orange-box pixel residue users saw on viewport changes.
      onResizeRef.current?.(term.cols, term.rows);

      // Debounce resize callbacks: ResizeObserver fires frequently during
      // window drag, and every one of these turns into a relay round-trip
      // and a SIGWINCH on the PTY. Coalesce to 100ms to keep the wire and
      // the child process from being hammered.
      let pending: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          fit();
          // `term.resize()` fires onResize only when dimensions actually
          // change. If the proposed dimensions are unchanged (e.g. layout
          // settled and the next observe fires at the same size) the event
          // is suppressed. Emit explicitly so the daemon always learns the
          // post-layout size — cheap and self-healing if the runner missed
          // an earlier resize.
          onResizeRef.current?.(term.cols, term.rows);
        }, 100);
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        if (pending) clearTimeout(pending);
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
  }, [termRef, searchRef]);

  // Keyboard escape from the terminal. ghostty-web mounts internal
  // tabIndex=0 elements (a hidden textarea + an a11y mirror div) that
  // Tab cycles between forever — keyboard users get trapped inside the
  // Terminal tab with no way out. Intercept Tab/Shift+Tab at the
  // container in the capture phase and manually move focus to the
  // next/previous focusable outside, so keyboard users can leave the
  // terminal the same way they leave any other widget. Tab as a typed
  // character is rarely useful in claude TUI (which navigates with
  // arrow keys), so we don't forward it to the PTY.
  //
  // Use a native capture-phase listener (not React onKeyDownCapture)
  // because ghostty's internal handlers may call stopPropagation in the
  // capture phase before React's synthetic event system runs.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const root = containerRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
      const outside = focusables.filter((el) => !root.contains(el));
      if (outside.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // compareDocumentPosition(root) returns flags relative to `el`: if
      // root comes AFTER el in DOM order, the flag is
      // DOCUMENT_POSITION_FOLLOWING (so el is "before" root). The reverse
      // is DOCUMENT_POSITION_PRECEDING.
      if (e.shiftKey) {
        const before = outside.filter(
          (el) =>
            !!(
              el.compareDocumentPosition(root) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        );
        (before[before.length - 1] ?? outside[outside.length - 1])?.focus();
      } else {
        const after = outside.find(
          (el) =>
            !!(
              el.compareDocumentPosition(root) &
              Node.DOCUMENT_POSITION_PRECEDING
            ),
        );
        (after ?? outside[0])?.focus();
      }
    };
    root.addEventListener("keydown", onKey, { capture: true });
    return () => root.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (Platform.OS !== "web") return null;

  // The ghostty-web canvas paints over this background, but the parent div
  // shows through briefly before the WASM renderer initializes. Match the
  // canvas background exactly (TERMINAL_COLORS.background) so first paint
  // doesn't flash a different color. Inline style — `bg-black` would be a
  // raw Tailwind color and the terminal palette intentionally lives outside
  // the tp-* semantic system (see tokens.ts).
  return (
    <div
      ref={containerRef}
      data-testid="terminal-container"
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: TERMINAL_COLORS.background,
      }}
    />
  );
}
