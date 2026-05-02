import * as Linking from "expo-linking";
import { useEffect, useRef } from "react";

// `Linking.getInitialURL()` keeps returning the launching URL for the entire
// app session, so we must guard against re-dispatching it if the root layout
// remounts (theme change, navigation reset, fast-refresh in dev).
let initialUrlConsumed = false;

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

    const isPairingUrl = (url: string) =>
      url.startsWith("teleprompter://pair?");

    const handleRuntime = (url: string | null) => {
      if (!active || !url) return;
      if (!isPairingUrl(url)) return;
      callbackRef.current(url);
    };

    // Cold-start: dispatch only once per app session.
    if (!initialUrlConsumed) {
      Linking.getInitialURL()
        .then((url) => {
          if (!active || !url || initialUrlConsumed) return;
          if (!isPairingUrl(url)) return;
          initialUrlConsumed = true;
          callbackRef.current(url);
        })
        .catch(() => {});
    }

    // While-running: deep link arrives while the app is foregrounded.
    const sub = Linking.addEventListener("url", ({ url }) =>
      handleRuntime(url),
    );

    return () => {
      active = false;
      sub.remove();
    };
  }, []);
}
