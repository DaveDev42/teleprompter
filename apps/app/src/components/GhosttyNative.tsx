import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { TERMINAL_COLORS } from "../lib/tokens";
import { useSettingsStore } from "../stores/settings-store";

/**
 * Native ghostty-web terminal via WebView for iOS/Android.
 * Loads ghostty-web inside a WebView with the WASM binary
 * inlined as base64 to avoid CORS issues from null-origin fetch.
 */

// Only import WebView on native platforms
let WebView: any = null;
if (Platform.OS !== "web") {
  try {
    WebView = require("react-native-webview").default;
  } catch {
    // Not available
  }
}

/**
 * Build the HTML page that loads ghostty-web inside the WebView.
 * The WASM binary is passed as a base64 string to avoid CORS issues
 * when loading from inline HTML (null origin).
 */
/** Escape a string for safe injection into an HTML template literal. */
function escapeHtml(s: string): string {
  return s.replace(/[&"'<>\\]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function buildGhosttyHtml(
  wasmBase64: string,
  terminalFont: string,
  fontSize: number,
): string {
  const safeFont = escapeHtml(terminalFont);
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  body { margin: 0; background: #000; overflow: hidden; }
  #terminal { width: 100%; height: 100vh; }
</style>
</head>
<body>
<div id="terminal"></div>
<script type="module">
  // Decode base64 WASM and instantiate ghostty-web
  const wasmBase64 = "${wasmBase64}";
  const wasmBytes = Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0));

  // Import ghostty-web from CDN (ESM)
  const { Terminal, FitAddon } = await import("https://esm.sh/ghostty-web@0.3.0");

  // Override WASM loading: compile from our inlined bytes
  const wasmModule = await WebAssembly.compile(wasmBytes);

  // ghostty-web init() fetches WASM, but we already have it.
  // We need to call init() with the module. If init() doesn't accept
  // a pre-compiled module, we'll patch the fetch to return our bytes.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, opts) => {
    if (typeof input === 'string' && input.includes('ghostty-vt.wasm')) {
      return new Response(wasmBytes.buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/wasm' },
      });
    }
    return originalFetch(input, opts);
  };

  const { init } = await import("https://esm.sh/ghostty-web@0.3.0");
  await init();

  // Restore original fetch
  globalThis.fetch = originalFetch;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: ${fontSize},
    fontFamily: "${safeFont}, Menlo, Monaco, 'Courier New', monospace",
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' },
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  // Send keyboard input to React Native
  term.onData(data => {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'data', data }));
  });

  term.onResize(({ cols, rows }) => {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'resize', cols, rows }));
  });

  // Receive messages from React Native
  function handleMessage(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'write') {
        term.write(msg.data);
      } else if (msg.type === 'fit') {
        fitAddon.fit();
      }
    } catch (e) {
      console.warn('[ghostty] failed to handle message from React Native:', e);
    }
  }

  window.addEventListener('message', handleMessage);
  document.addEventListener('message', handleMessage); // iOS

  window.addEventListener('resize', () => fitAddon.fit());

  // Signal ready
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
</script>
</body>
</html>`;
}

export function GhosttyNative({
  onData,
  onResize,
  onReady,
  termRef,
}: {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onReady?: () => void;
  termRef?: React.MutableRefObject<any>;
}) {
  const webViewRef = useRef<any>(null);
  const [html, setHtml] = useState<string | null>(null);

  // Load WASM binary and convert to base64 on mount
  useEffect(() => {
    async function loadWasm() {
      try {
        // Read the WASM file from the installed package
        // In React Native, we can't directly read node_modules files at runtime.
        // Instead, bundle the base64 at build time via a generated module,
        // or fetch from a known CDN at runtime.
        // For now, fetch from CDN (esm.sh serves the WASM too):
        const response = await fetch(
          "https://esm.sh/ghostty-web@0.3.0/ghostty-vt.wasm",
        );
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Convert to base64
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode(...chunk);
        }
        const base64 = btoa(binary);

        const settings = useSettingsStore.getState();
        setHtml(
          buildGhosttyHtml(base64, settings.terminalFont, settings.fontSize),
        );
      } catch (err) {
        console.error("Failed to load ghostty WASM:", err);
      }
    }

    loadWasm();
  }, []);

  // Expose a write method via termRef
  useEffect(() => {
    if (termRef) {
      termRef.current = {
        write: (data: string) => {
          webViewRef.current?.postMessage(
            JSON.stringify({ type: "write", data }),
          );
        },
      };
    }
    return () => {
      if (termRef) termRef.current = null;
    };
  }, [termRef]);

  const handleMessage = useCallback(
    (event: any) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        switch (msg.type) {
          case "data":
            onData?.(msg.data);
            break;
          case "resize":
            onResize?.(msg.cols, msg.rows);
            break;
          case "ready":
            onReady?.();
            break;
        }
      } catch {
        // ignore
      }
    },
    [onData, onResize, onReady],
  );

  if (!WebView || !html) return null;

  return (
    <WebView
      ref={webViewRef}
      source={{ html }}
      style={{ flex: 1, backgroundColor: TERMINAL_COLORS.background }}
      onMessage={handleMessage}
      javaScriptEnabled
      originWhitelist={["*"]}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      keyboardDisplayRequiresUserAction={false}
    />
  );
}
