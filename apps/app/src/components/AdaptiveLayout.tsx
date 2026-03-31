import { View } from "react-native";
import { useLayout } from "../hooks/use-layout";
import { SessionDrawer } from "./SessionDrawer";

/**
 * Adaptive layout for different screen sizes:
 * - Mobile: children rendered as-is (tab navigation handles switching)
 * - Tablet: side-by-side split (left=Chat, right=Terminal)
 * - Desktop: sidebar (Sessions) + split (Chat + Terminal)
 */
export function AdaptiveLayout({
  chatContent,
  terminalContent,
}: {
  chatContent: React.ReactNode;
  terminalContent: React.ReactNode;
}) {
  const { mode } = useLayout();

  if (mode === "desktop") {
    return (
      <View className="flex-1 flex-row bg-black">
        {/* Sidebar - Sessions */}
        <View className="w-[280px] border-r border-zinc-800">
          <SessionDrawer />
        </View>
        {/* Chat */}
        <View className="flex-1 border-r border-zinc-800">{chatContent}</View>
        {/* Terminal */}
        <View className="flex-1">{terminalContent}</View>
      </View>
    );
  }

  if (mode === "tablet") {
    return (
      <View className="flex-1 flex-row bg-black">
        {/* Chat */}
        <View className="flex-1 border-r border-zinc-800">{chatContent}</View>
        {/* Terminal */}
        <View className="flex-1">{terminalContent}</View>
      </View>
    );
  }

  // Mobile: return null — tab navigation handles the layout
  return null;
}
