import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { useNotificationStore } from "../stores/notification-store";
import { useSessionStore } from "../stores/session-store";
import { resolveForegroundToast } from "./push-toast";
import { getRelayClients } from "./use-relay";

let _currentToken: string | null = null;

export function getCurrentPushToken(): string | null {
  return _currentToken;
}

async function registerForPushToken(
  Notifications: typeof import("expo-notifications"),
): Promise<void> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") return;

  const tokenData = await Notifications.getExpoPushTokenAsync();
  _currentToken = tokenData.data;
  sendTokenToRelays();
}

function sendTokenToRelays(): void {
  if (!_currentToken || Platform.OS === "web") return;
  const platform = Platform.OS as "ios" | "android";
  const clients = getRelayClients();
  for (const client of clients) {
    client.sendPushToken(_currentToken, platform);
  }
}

export function usePushNotifications() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === "web") return;

    const Notifications =
      require("expo-notifications") as typeof import("expo-notifications");

    // Suppress the OS banner while the app is in the foreground — we surface
    // foreground pushes as an in-app toast instead (richer: tap-to-navigate,
    // a11y live region, matches the relay.notification in-band path). The
    // toast is driven by the addNotificationReceivedListener below.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      }),
    });

    // Register for push token. Swallow permission-denied and network errors
    // so a failed registration never becomes an unhandled rejection.
    registerForPushToken(Notifications).catch((e: unknown) => {
      console.warn("[push] registration failed:", e);
    });

    // Foreground push → in-app toast. Without this, a push that arrives while
    // the app is open is silently swallowed (the handler above hides the OS
    // banner, and nothing else surfaces it). Mirror the relay.notification
    // path (use-relay.ts onNotification): skip the toast when the user is
    // already viewing the target session, since they're looking right at it.
    const receivedSub = Notifications.addNotificationReceivedListener(
      (notification) => {
        const { activeSession } = useSessionStore.getState();
        const currentSid = activeSession.active ? activeSession.sid : null;
        const toast = resolveForegroundToast(
          notification.request.content,
          currentSid,
        );
        if (toast) useNotificationStore.getState().showToast(toast);
      },
    );

    // Handle notification tap (app backgrounded → user taps the OS banner)
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as
          | { sid?: string }
          | undefined;
        if (data?.sid) {
          router.push(`/session/${data.sid}`);
        }
      },
    );

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [router.push]);
}
