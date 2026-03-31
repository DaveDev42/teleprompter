import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";

/**
 * Native xterm.js terminal via WebView for iOS/Android.
 * Loads xterm.js from CDN inside a WebView and communicates
 * via postMessage bridge.
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

const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11/lib/addon-fit.min.js"></script>
<style>
  body { margin: 0; background: #000; overflow: hidden; }
  #terminal { width: 100%; height: 100vh; }
</style>
</head>
<body>
<div id="terminal"></div>
<script>
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' },
    scrollback: 10000,
    convertEol: false,
  });
  const fitAddon = new FitAddon.FitAddon();
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
  window.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'write') {
        term.write(msg.data);
      } else if (msg.type === 'fit') {
        fitAddon.fit();
      }
    } catch {}
  });

  // Also handle document.addEventListener for iOS
  document.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'write') {
        term.write(msg.data);
      } else if (msg.type === 'fit') {
        fitAddon.fit();
      }
    } catch {}
  });

  window.addEventListener('resize', () => fitAddon.fit());

  // Signal ready
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
</script>
</body>
</html>`;

export function XTermNative({
  onData,
  onResize,
  termRef,
}: {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  termRef?: React.MutableRefObject<any>;
}) {
  const webViewRef = useRef<any>(null);

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
            // Terminal is ready
            break;
        }
      } catch {
        // ignore
      }
    },
    [onData, onResize],
  );

  if (!WebView) return null;

  return (
    <WebView
      ref={webViewRef}
      source={{ html: XTERM_HTML }}
      style={{ flex: 1, backgroundColor: "#000" }}
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
