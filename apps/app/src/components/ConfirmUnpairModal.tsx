import { Pressable, Text, View } from "react-native";
import { getPlatformProps } from "../lib/get-platform-props";
import { ModalContainer } from "./ModalContainer";

export function ConfirmUnpairModal({
  visible,
  displayName,
  daemonId,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  displayName: string;
  daemonId?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const pp = getPlatformProps();

  return (
    <ModalContainer
      visible={visible}
      onClose={onCancel}
      accessibilityLabel="Remove Daemon"
    >
      <View className="px-5 pt-5 pb-6">
        <View className="flex-row items-center justify-between pb-3">
          <Pressable
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel unpair"
          >
            <Text className="text-tp-text-secondary text-base">Cancel</Text>
          </Pressable>
          <Text
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
          >
            Remove Daemon
          </Text>
          <Pressable
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={() => void onConfirm()}
            accessibilityRole="button"
            accessibilityLabel={`Remove pairing with ${displayName}`}
          >
            <Text className="text-tp-error text-base font-semibold">
              Remove
            </Text>
          </Pressable>
        </View>
        <Text className="text-tp-text-primary text-[15px] leading-6">
          Remove pairing with{" "}
          <Text className="font-semibold">{displayName}</Text>? You'll need to
          scan a new QR code from the daemon to reconnect.
        </Text>
        {daemonId ? (
          <Text className="text-tp-text-tertiary text-xs font-mono mt-2">
            {daemonId}
          </Text>
        ) : null}
      </View>
    </ModalContainer>
  );
}
