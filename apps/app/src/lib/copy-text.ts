import { Platform } from "react-native";
import { useNotificationStore } from "../stores/notification-store";

// WCAG 2.1 SC 4.1.3 Status Messages (AA): clipboard copy is a status
// change with no focus shift, so AT users must be told via a status
// message that the action succeeded (or failed). `showToast` renders
// through InAppToast, which mounts a polite `role="status"` live
// region, so emitting a toast here surfaces the announcement without
// a bespoke live region in every caller.
export async function copyText(text: string): Promise<void> {
  if (Platform.OS === "web" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      useNotificationStore.getState().showToast({
        title: "Copied",
        body: "Text copied to clipboard",
      });
    } catch {
      useNotificationStore.getState().showToast({
        title: "Copy failed",
        body: "Could not copy text to clipboard",
      });
    }
  }
  // Native: would use expo-clipboard
}
