import { TERMINAL_COLORS } from "./tokens";

/**
 * Pure HTML builder for the native WebView terminal (GhosttyNative).
 *
 * The ghostty-web UMD build (assets/ghostty-web.umd.txt, copied verbatim
 * from node_modules/ghostty-web/dist/ghostty-web.umd.cjs — equality is
 * pinned by ghostty-web-asset.test.ts) is inlined into a classic script
 * tag. The UMD exposes `globalThis.GhosttyWeb` and embeds the WASM binary
 * as a base64 data URL, so the page needs no network and no module graph.
 *
 * Bridge protocol (JSON over postMessage):
 * - RN → WebView: `{type:"write", b64}` (base64 bytes — binary-safe) and
 *   `{type:"fit"}`.
 * - WebView → RN: `{type:"data", data}` (keystrokes), `{type:"resize",
 *   cols, rows}`, `{type:"ready"}`, `{type:"error", message}`.
 */

/** Escape a string for safe injection into an HTML attribute/JS string. */
export function escapeHtml(s: string): string {
  return s.replace(/[&"'<>\\]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Make arbitrary JS source safe to inline inside a `<script>` element.
 * The HTML parser ends a script at the first `</script` regardless of JS
 * string/regex context; `<\/script` is byte-identical JS in a string or
 * regex position. (`<!--` would also need care per the script-content
 * spec, but the asset oracle test asserts the UMD contains neither.)
 */
export function escapeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

export function buildGhosttyHtml(
  umdJs: string,
  terminalFont: string,
  fontSize: number,
): string {
  const safeFont = escapeHtml(terminalFont);
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  body { margin: 0; background: ${TERMINAL_COLORS.background}; overflow: hidden; }
  #terminal { width: 100%; height: 100vh; }
</style>
</head>
<body>
<div id="terminal"></div>
<script>${escapeInlineScript(umdJs)}</script>
<script>
(async () => {
  function post(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  try {
    const { Terminal, FitAddon, init } = globalThis.GhosttyWeb;
    // Loads the WASM from the base64 data URL embedded in the UMD bundle.
    await init();

    const term = new Terminal({
      cursorBlink: true,
      fontSize: ${fontSize},
      fontFamily: "${safeFont}, Menlo, Monaco, 'Courier New', monospace",
      theme: { background: '${TERMINAL_COLORS.background}', foreground: '${TERMINAL_COLORS.foreground}', cursor: '${TERMINAL_COLORS.cursor}' },
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // Keyboard input to React Native
    term.onData((data) => post({ type: 'data', data }));
    term.onResize(({ cols, rows }) => post({ type: 'resize', cols, rows }));

    function b64ToBytes(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }

    // Messages from React Native
    function handleMessage(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'write') {
          term.write(b64ToBytes(msg.b64));
        } else if (msg.type === 'fit') {
          fitAddon.fit();
        }
      } catch (err) {
        post({ type: 'error', message: 'message handling failed: ' + String((err && err.message) || err) });
      }
    }
    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage); // iOS

    window.addEventListener('resize', () => fitAddon.fit());

    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
})();
</script>
</body>
</html>`;
}
