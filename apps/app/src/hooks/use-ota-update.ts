import * as Updates from "expo-updates";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

export type OtaStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error"
  | "unavailable"; // dev build or web

export function useOtaUpdate() {
  const [status, setStatus] = useState<OtaStatus>("idle");

  const isAvailable = Platform.OS !== "web" && !__DEV__ && Updates.isEnabled;

  const checkAndFetch = useCallback(async () => {
    if (!isAvailable) {
      setStatus("unavailable");
      return;
    }

    try {
      setStatus("checking");
      const check = await Updates.checkForUpdateAsync();

      if (!check.isAvailable) {
        setStatus("up-to-date");
        return;
      }

      setStatus("downloading");
      await Updates.fetchUpdateAsync();
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [isAvailable]);

  const restart = useCallback(async () => {
    if (!isAvailable) return;
    await Updates.reloadAsync();
  }, [isAvailable]);

  // Auto-check on mount
  useEffect(() => {
    checkAndFetch();
  }, [checkAndFetch]);

  return { status, checkAndFetch, restart, isAvailable };
}
