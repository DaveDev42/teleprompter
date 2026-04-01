import { View } from "react-native";
import { useLayout } from "../hooks/use-layout";

/**
 * Adaptive layout for different screen sizes:
 * - Mobile: returns null (tab navigation handles switching)
 * - Tablet: side-by-side split (Chat + Terminal)
 * - Desktop: sidebar (Daemons/Sessions) + Chat + Terminal
 */
export function AdaptiveLayout({
  sidebarContent,
  chatContent,
  terminalContent,
}: {
  sidebarContent: React.ReactNode;
  chatContent: React.ReactNode;
  terminalContent: React.ReactNode;
}) {
  const { mode } = useLayout();

  if (mode === "desktop") {
    return (
      <View className="flex-1 flex-row bg-tp-bg">
        {/* Sidebar — Daemons + Sessions */}
        <View className="w-[260px] border-r border-tp-border bg-tp-bg-secondary">
          {sidebarContent}
        </View>
        {/* Chat */}
        <View className="flex-[0.45] border-r border-tp-border">
          {chatContent}
        </View>
        {/* Terminal */}
        <View className="flex-[0.55]">{terminalContent}</View>
      </View>
    );
  }

  if (mode === "tablet") {
    return (
      <View className="flex-1 flex-row bg-tp-bg">
        {/* Chat */}
        <View className="flex-1 border-r border-tp-border">{chatContent}</View>
        {/* Terminal */}
        <View className="flex-1">{terminalContent}</View>
      </View>
    );
  }

  // Mobile: return null — tab navigation handles the layout
  return null;
}
