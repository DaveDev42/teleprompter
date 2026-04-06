import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { getRelayClients } from "./use-relay";

let _currentToken: string | null = null;

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

    // Don't show system notification when app is in foreground (we use toast)
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      }),
    });

    // Register for push token
    registerForPushToken(Notifications);

    // Handle notification tap
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
      responseSub.remove();
    };
  }, []);
}
