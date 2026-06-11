import { Asset } from "expo-asset";
import { readAsStringAsync } from "expo-file-system/legacy";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import ghosttyUmdAsset from "../../assets/ghostty-web.umd.txt";
import { buildGhosttyHtml } from "../lib/ghostty-native-html";
import type { TerminalViewProps } from "../lib/term-handle";
import { TERMINAL_COLORS } from "../lib/tokens";
import { bytesToBase64, encodeUtf8Base64 } from "../lib/utf8-base64";
import { useSettingsStore } from "../stores/settings-store";

/**
 * Native ghostty-web terminal via WebView for iOS/Android.
 *
 * The ghostty-web UMD build ships as a bundled Metro asset
 * (assets/ghostty-web.umd.txt — same package version as the web terminal,
 * freshness pinned by lib/ghostty-web-asset.test.ts) and is inlined into
 * the WebView HTML by lib/ghostty-native-html.ts. The WASM binary is
 * embedded in the UMD as a base64 data URL, so the terminal works fully
 * offline — no CDN fetch, no version skew with the web bundle.
 */

/** Tagged-union for messages posted from the in-WebView script to React Native. */
type WebViewMsg =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ready" }
  | { type: "error"; message: string };

// Only import WebView on native platforms
let WebView: any = null;
if (Platform.OS !== "web") {
  try {
    WebView = require("react-native-webview").default;
  } catch {
    // Not available
  }
}

export function GhosttyNative({
  onData,
  onResize,
  onReady,
  termRef,
}: TerminalViewProps) {
  const webViewRef = useRef<any>(null);
  const [html, setHtml] = useState<string | null>(null);

  // Read the bundled UMD asset and build the WebView page on mount.
  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;

    async function loadBundledGhostty() {
      try {
        const asset = Asset.fromModule(ghosttyUmdAsset);
        await asset.downloadAsync();
        if (!asset.localUri) {
          throw new Error("asset has no localUri after downloadAsync");
        }
        const umdJs = await readAsStringAsync(asset.localUri, {
          encoding: "utf8",
        });
        if (cancelled) return;
        const settings = useSettingsStore.getState();
        setHtml(
          buildGhosttyHtml(umdJs, settings.terminalFont, settings.fontSize),
        );
      } catch (err) {
        console.error(
          "[GhosttyNative] failed to load bundled ghostty-web:",
          err,
        );
      }
    }

    loadBundledGhostty();
    return () => {
      cancelled = true;
    };
  }, []);

  // Expose the shared TermHandle write surface. All writes cross the
  // postMessage bridge as base64 bytes so binary PTY output (the common
  // case — SessionTerminalView decodes io records to Uint8Array) survives
  // JSON serialization intact.
  useEffect(() => {
    if (termRef) {
      termRef.current = {
        write: (data: string | Uint8Array) => {
          const b64 =
            typeof data === "string"
              ? encodeUtf8Base64(data)
              : bytesToBase64(data);
          webViewRef.current?.postMessage(
            JSON.stringify({ type: "write", b64 }),
          );
        },
      };
    }
    return () => {
      if (termRef) termRef.current = null;
    };
  }, [termRef]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data) as WebViewMsg;
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
          case "error":
            // Surface in-WebView failures (UMD eval, WASM init, bridge
            // decode) to the RN console for on-device debugging.
            console.error("[GhosttyNative] webview error:", msg.message);
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
