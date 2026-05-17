import type { WsSessionMeta } from "@teleprompter/protocol/client";
import { Platform, Pressable, Text, View } from "react-native";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
import { ModalContainer } from "./ModalContainer";

const MAX_LISTED = 5;

export function ConfirmDeleteSessionsModal({
  visible,
  sessions,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  sessions: WsSessionMeta[];
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const pp = getPlatformProps();
  const count = sessions.length;
  const listed = sessions.slice(0, MAX_LISTED);
  const extra = count - MAX_LISTED;

  // APG Dialog Pattern: wire body text into aria-describedby so the
  // consequences are announced immediately when the dialog opens.
  const DESCRIPTION_ID = "confirm-delete-sessions-description";

  return (
    <ModalContainer
      visible={visible}
      onClose={onCancel}
      accessibilityLabel={`Delete ${count} session${count !== 1 ? "s" : "?"}`}
      accessibilityLabelledBy="confirm-delete-sessions-title"
      accessibilityDescribedBy={DESCRIPTION_ID}
    >
      <View className="px-5 pt-5 pb-6">
        <View className="flex-row items-center justify-between pb-3">
          <Pressable
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="confirm-delete-sessions-cancel"
          >
            <Text className="text-tp-text-secondary text-base">Cancel</Text>
          </Pressable>

          <Text
            nativeID="confirm-delete-sessions-title"
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
            {...ariaLevel(2)}
          >
            {`Delete ${count} Session${count !== 1 ? "s" : ""}?`}
          </Text>

          <Pressable
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={() => void onConfirm()}
            accessibilityRole="button"
            accessibilityLabel={`Confirm delete ${count} sessions`}
            testID="confirm-delete-sessions-confirm"
          >
            <Text className="text-tp-error text-base font-semibold">
              Delete
            </Text>
          </Pressable>
        </View>

        {/* Description: listed sids + overflow count.
            wired via aria-describedby on the dialog so AT announces on open. */}
        <View nativeID={DESCRIPTION_ID}>
          <Text className="text-tp-text-secondary text-[13px] mb-2">
            The following sessions will be permanently removed:
          </Text>
          {listed.map((s) => {
            const lastSeg = s.cwd.replace(/\/+$/, "").split("/").pop() ?? "";
            const desc = lastSeg || s.cwd || s.sid;
            return (
              <Text
                key={s.sid}
                className="text-tp-text-primary text-[13px] font-mono"
                numberOfLines={1}
              >
                {desc}
              </Text>
            );
          })}
          {extra > 0 && (
            <Text
              className="text-tp-text-tertiary text-[13px] mt-1"
              {...(Platform.OS === "web"
                ? ({ "aria-label": `and ${extra} more sessions` } as object)
                : {})}
            >
              {`…and ${extra} more`}
            </Text>
          )}
        </View>
      </View>
    </ModalContainer>
  );
}
