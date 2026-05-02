import * as Linking from "expo-linking";
import { useEffect, useRef } from "react";

/**
 * Listens for `teleprompter://pair?d=<base64url>` deep links (cold-start and
 * while-running) and forwards the full URL to the caller. The caller is
 * responsible for routing the user to a confirmation screen — this hook never
 * pairs automatically.
 */
export function usePairingDeepLink(onPairingUrl: (url: string) => void): void {
  // Latest callback ref so the listener never goes stale across re-renders.
  const callbackRef = useRef(onPairingUrl);
  useEffect(() => {
    callbackRef.current = onPairingUrl;
  }, [onPairingUrl]);

  useEffect(() => {
    let active = true;

    const handle = (url: string | null) => {
      if (!active || !url) return;
      if (!url.startsWith("teleprompter://pair")) return;
      callbackRef.current(url);
    };

    // Cold-start: app opened directly by the deep link.
    Linking.getInitialURL()
      .then(handle)
      .catch(() => {});

    // While-running: deep link arrives while the app is foregrounded.
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));

    return () => {
      active = false;
      sub.remove();
    };
  }, []);
}
