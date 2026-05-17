import type { WsSessionMeta } from "@teleprompter/protocol/client";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConfirmDeleteSessionsModal } from "../../src/components/ConfirmDeleteSessionsModal";
import { ariaLevel, getPlatformProps } from "../../src/lib/get-platform-props";
import { useNotificationStore } from "../../src/stores/notification-store";
import { useSessionStore } from "../../src/stores/session-store";
import { useThemeStore } from "../../src/stores/theme-store";

// Mirrors `--tp-text-tertiary` in global.css. TextInput.placeholderTextColor
// only resolves CSS variables on web; native silently falls back to the
// system default, which is often unreadable on light themes.
const PLACEHOLDER_LIGHT = "#a1a1aa";
const PLACEHOLDER_DARK = "#71717a";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SessionRow({
  session,
  isActive,
  onPress,
  isEditMode,
  isSelected,
  onToggleSelect,
}: {
  session: WsSessionMeta;
  isActive: boolean;
  onPress: () => void;
  isEditMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
}) {
  const isDark = useThemeStore((s) => s.isDark);
  const running = session.state === "running";
  const pp = getPlatformProps();
  const stoppedPp = getPlatformProps({ focusable: isEditMode && !running });

  // Extract a description from cwd (last path segment). Strip a trailing
  // slash first so "/Users/dave/proj/" yields "proj" rather than "". Then
  // fall back through cwd → sid → "Session" because `??` only catches
  // null/undefined and `pop()` returns "" for empty input.
  const lastSeg = session.cwd.replace(/\/+$/, "").split("/").pop() ?? "";
  const desc = lastSeg || session.cwd || session.sid || "Session";

  // The visible relative timestamp ("5m ago") rides inside the Pressable as
  // a sibling Text node. On web `role=button` with an explicit aria-label
  // overrides descendant text for the accessible name (ARIA 1.2 §4.3.2),
  // so screen-reader focus-mode users never hear when the session was last
  // updated — only the button's name. The chevron/dot/divider are
  // decorative duplicates and stay aria-hidden, but the time carries
  // information that isn't in the name, so it must be folded into the
  // accessible name itself. WCAG 4.1.2 (Name Role Value, Level A).
  const updatedLabel = `updated ${timeAgo(session.updatedAt)}`;

  // Checkbox label for screen readers.
  const checkboxLabel = `${isSelected ? "Deselect" : "Select"} ${desc}, ${running ? "running" : session.state}`;

  const rowContent = (
    <View
      className={`flex-row items-center py-4 mx-4 ${
        isActive
          ? isDark
            ? "bg-tp-bg-secondary rounded-lg px-3"
            : "bg-tp-bg-secondary rounded-lg px-3"
          : ""
      }`}
    >
      {/* Active indicator */}
      {isActive && (
        <View
          className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full bg-tp-accent"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        />
      )}

      {/* Edit mode: leading visual checkbox indicator for stopped sessions.
          This is purely decorative — the parent Pressable carries the
          role=checkbox and aria-checked. aria-hidden=true on this View
          prevents double-announcement. */}
      {isEditMode && !running && (
        <View
          className={`w-5 h-5 rounded mr-3 border items-center justify-center ${
            isSelected
              ? "bg-tp-accent border-tp-accent"
              : "bg-transparent border-tp-border"
          }`}
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        >
          {isSelected && (
            <Text
              className="text-tp-text-on-color text-[11px] font-bold"
              {...(Platform.OS === "web"
                ? ({ "aria-hidden": true } as object)
                : {})}
            >
              ✓
            </Text>
          )}
        </View>
      )}

      {/* Status dot */}
      <View
        className={`w-2 h-2 rounded-full mr-3 ${
          running ? "bg-tp-success" : "bg-tp-text-tertiary"
        }`}
        {...(Platform.OS === "web" ? ({ "aria-hidden": true } as object) : {})}
      />

      {/* Content */}
      <View className="flex-1">
        <Text
          className="text-tp-text-primary text-[15px] font-semibold"
          numberOfLines={1}
        >
          {desc}
        </Text>
        <Text
          className="text-tp-text-secondary text-[13px] mt-0.5"
          numberOfLines={1}
        >
          {session.sid}
          {session.worktreePath ? ` · ${session.worktreePath}` : ""}
        </Text>
      </View>

      {/* Time */}
      <Text className="text-tp-text-tertiary text-[11px] ml-2">
        {timeAgo(session.updatedAt)}
      </Text>

      {/* Chevron — hidden in edit mode; hidden on web in normal mode too. */}
      {!isEditMode && (
        <Text
          className="text-tp-text-tertiary text-lg ml-2"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        >
          ›
        </Text>
      )}
    </View>
  );

  // In edit mode: stopped sessions get a full-row checkbox Pressable.
  // Running sessions in edit mode: render as non-interactive (no-op tap).
  if (isEditMode) {
    if (running) {
      // Running: not selectable, render as plain view (no tap action).
      return (
        <View>
          {rowContent}
          {!isActive && (
            <View
              className="h-[0.5px] bg-tp-border ml-[52px] mr-4"
              {...(Platform.OS === "web"
                ? ({ "aria-hidden": true } as object)
                : {})}
            />
          )}
        </View>
      );
    }

    // Stopped: selectable checkbox row.
    // RN Web translates role="checkbox" + accessibilityState.checked
    // to aria-checked automatically. Use the native pattern for
    // cross-platform correctness.
    return (
      <Pressable
        onPress={onToggleSelect}
        accessibilityRole="checkbox"
        accessibilityLabel={checkboxLabel}
        accessibilityState={{ checked: isSelected }}
        tabIndex={stoppedPp.tabIndex}
        className={stoppedPp.className}
        // Web: spread aria-checked + aria-label explicitly because
        // RN Web does NOT translate accessibilityState.checked to
        // aria-checked on Pressable (it only does so on native components).
        // WCAG 4.1.2.
        {...(Platform.OS === "web"
          ? ({
              role: "checkbox",
              "aria-checked": isSelected,
              "aria-label": checkboxLabel,
            } as object)
          : {})}
      >
        {rowContent}
        {!isActive && (
          <View
            className="h-[0.5px] bg-tp-border ml-[52px] mr-4"
            {...(Platform.OS === "web"
              ? ({ "aria-hidden": true } as object)
              : {})}
          />
        )}
      </Pressable>
    );
  }

  // Normal mode: standard navigation row.
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${desc}, ${running ? "running" : session.state}, ${updatedLabel}${isActive ? ", selected" : ""}`}
      accessibilityHint="Open this session"
      tabIndex={pp.tabIndex}
      className={pp.className}
      // ARIA 1.2 §6.6.4 aria-current — the active row's "selected"
      // state must be programmatically determinable. The text suffix
      // ", selected" inside accessibilityLabel reads naturally for
      // native VoiceOver/TalkBack, but on web it bakes state into the
      // accessible name where CSS attribute selectors, axe-core, and
      // SR state announcement can't reach it. RN Web's
      // AccessibilityState union has no `current` field, so the only
      // bridge is a raw aria-current spread guarded by Platform.
      {...(Platform.OS === "web" && isActive
        ? ({ "aria-current": "true" } as object)
        : {})}
    >
      {rowContent}

      {/* Divider */}
      {!isActive && (
        <View
          className="h-[0.5px] bg-tp-border ml-[52px] mr-4"
          {...(Platform.OS === "web"
            ? ({ "aria-hidden": true } as object)
            : {})}
        />
      )}
    </Pressable>
  );
}

export default function SessionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessions = useSessionStore((s) => s.sessions);
  const removeSessions = useSessionStore((s) => s.removeSessions);
  const currentSid = useSessionStore((s) => s.sid);
  const showToast = useNotificationStore((s) => s.showToast);
  const [filter, setFilter] = useState("");
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = isDark ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT;
  const searchRef = useRef<TextInput>(null);

  // ── Edit mode state (local scope — not persisted across tab switches) ──
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedSids, setSelectedSids] = useState<Set<string>>(new Set());
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Live region announcement text (mount-only pattern for NVDA/JAWS:
  // the wrapper exists at all times; only the text content changes so
  // mutation observers fire reliably).
  const [editAnnouncement, setEditAnnouncement] = useState("");

  // Delete button ref — used to set aria-disabled imperatively on web.
  // RN Web's Pressable only emits HTML `disabled` (which removes from Tab
  // order); we want the button to stay focusable but announce itself as
  // inactive, so set aria-disabled via setAttribute instead. Pattern
  // mirrors FontPickerModal's boundary buttons (PR #322).
  const deleteButtonRef = useRef<View>(null);

  // RN Web's createDOMProps does not whitelist `aria-description`, so
  // any prop-level spread is silently dropped. `accessibilityHint` is
  // also dropped — native AT reads it, web AT hears silence. Set the
  // attribute imperatively when the search input mounts so screen
  // readers on web get the same hint as native.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = searchRef.current as unknown as HTMLElement | null;
    if (!el) return;
    el.setAttribute(
      "aria-description",
      "Filter sessions by name, path, or status",
    );
    // APG Combobox/Search pattern: the input is a control over the
    // sessions list — without `aria-controls` AT users hear keystrokes
    // but cannot programmatically navigate to the filtered result
    // container, so the filter feels orphaned.
    el.setAttribute("aria-controls", "sessions-list");
  });

  const selectedCount = selectedSids.size;

  // Set aria-disabled imperatively on the Delete button so screen readers
  // know it's inactive when nothing is selected. Re-fires whenever
  // selectedCount changes so the attribute stays in sync. `isEditMode` is
  // included intentionally: the Delete Pressable only mounts in edit mode,
  // so we need the effect to run on mode-entry to set the initial attribute
  // value before any selection changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isEditMode is intentional — see above
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = deleteButtonRef.current as unknown as HTMLElement | null;
    if (!el) return;
    if (selectedCount === 0) {
      el.setAttribute("aria-disabled", "true");
    } else {
      el.setAttribute("aria-disabled", "false");
    }
  }, [selectedCount, isEditMode]);

  // Sort by updatedAt desc, filter by search
  const filteredSessions = useMemo(() => {
    let list = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      list = list.filter(
        (s) =>
          s.sid.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.worktreePath?.toLowerCase().includes(q) ||
          s.state.toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filter]);

  // Stopped sessions available for selection in edit mode.
  const stoppedSessions = useMemo(
    () => sessions.filter((s) => s.state === "stopped"),
    [sessions],
  );

  const enterEditMode = () => {
    setIsEditMode(true);
    setSelectedSids(new Set());
    setEditAnnouncement(
      stoppedSessions.length === 0
        ? "Edit mode. No stopped sessions to clean up."
        : `Edit mode. ${stoppedSessions.length} stopped session${stoppedSessions.length !== 1 ? "s" : ""} available.`,
    );
  };

  const exitEditMode = () => {
    setIsEditMode(false);
    setSelectedSids(new Set());
    setEditAnnouncement("Edit mode cancelled.");
  };

  const toggleSelect = (sid: string) => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) {
        next.delete(sid);
      } else {
        next.add(sid);
      }
      return next;
    });
  };

  const handleDeletePress = () => {
    if (selectedCount === 0) return;
    setShowConfirmModal(true);
  };

  const handleConfirmDelete = async () => {
    setShowConfirmModal(false);
    const sids = Array.from(selectedSids);
    // Call existing store remove action (equivalent to N single-session removes in parallel).
    removeSessions(sids);
    const count = sids.length;
    setIsEditMode(false);
    setSelectedSids(new Set());
    setEditAnnouncement(`Deleted ${count} session${count !== 1 ? "s" : ""}.`);
    showToast({
      title: `${count} session${count !== 1 ? "s" : ""} deleted`,
      body: "Sessions removed from the list.",
    });
  };

  const handleSessionPress = (session: WsSessionMeta) => {
    router.push(`/session/${session.sid}`);
  };

  // Sessions selected for deletion (only stopped ones).
  const selectedForDelete = useMemo(
    () => sessions.filter((s) => selectedSids.has(s.sid)),
    [sessions, selectedSids],
  );

  return (
    <View
      className="flex-1 bg-tp-bg"
      style={{ paddingTop: insets.top }}
      // WCAG 2.4.1 Bypass Blocks (Level A) + ARIA landmark navigation:
      // screen readers expose `role="main"` as a jump target so AT users
      // can skip the bottom tablist and land on the page body. RN's
      // `AccessibilityRole` union doesn't include "main", so use the
      // `role` prop directly — RN Web passes it through to the DOM
      // `role` attribute verbatim (and also emits a `<main>` element).
      // Native ignores `role` (Pressable et al. read
      // `accessibilityRole`), so this is web-only by design.
      {...(Platform.OS === "web" ? { role: "main" as const } : {})}
    >
      {/* Header */}
      <View className="px-4 pt-2 pb-1 flex-row items-center justify-between">
        {isEditMode ? (
          // Edit mode header: "N selected" title + Cancel + Delete buttons
          <>
            <Pressable
              onPress={exitEditMode}
              accessibilityRole="button"
              accessibilityLabel="Cancel edit"
              tabIndex={pp.tabIndex}
              className={pp.className}
              testID="sessions-edit-cancel"
            >
              <Text className="text-tp-accent text-base">Cancel</Text>
            </Pressable>

            <Text
              accessibilityRole="header"
              {...ariaLevel(1)}
              className="text-tp-text-primary text-[17px] font-semibold"
              testID="sessions-edit-count"
            >
              {selectedCount === 0
                ? "Select Sessions"
                : `${selectedCount} Selected`}
            </Text>

            {/* Delete button.
                aria-disabled is set imperatively via deleteButtonRef useEffect
                (see above) because RN Web's Pressable spread silently drops
                unknown aria-* attributes — createDOMProps allowlist doesn't
                include aria-disabled on non-input elements. The Pressable still
                receives the press event even when visually disabled; the handler
                guards selectedCount === 0 so no action fires. WCAG 4.1.2.
                Pattern mirrors FontPickerModal boundary buttons (PR #322). */}
            <Pressable
              ref={deleteButtonRef}
              onPress={handleDeletePress}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${selectedCount} sessions`}
              accessibilityState={{ disabled: selectedCount === 0 }}
              tabIndex={pp.tabIndex}
              className={pp.className}
              testID="sessions-edit-delete"
            >
              <Text
                className={
                  selectedCount === 0
                    ? "text-tp-text-tertiary text-base font-semibold"
                    : "text-tp-error text-base font-semibold"
                }
              >
                {selectedCount === 0 ? "Delete" : `Delete (${selectedCount})`}
              </Text>
            </Pressable>
          </>
        ) : (
          // Normal mode header: "Sessions" title + Edit button
          <>
            <Text
              accessibilityRole="header"
              {...ariaLevel(1)}
              className="text-tp-text-primary text-[28px] font-bold"
            >
              Sessions
            </Text>

            <Pressable
              onPress={enterEditMode}
              accessibilityRole="button"
              accessibilityLabel="Edit sessions"
              tabIndex={pp.tabIndex}
              className={pp.className}
              testID="sessions-edit-button"
              // aria-pressed: communicates that this toggle button controls
              // an edit mode that's currently inactive. APG Button Pattern.
              {...(Platform.OS === "web"
                ? ({
                    "aria-pressed": false,
                  } as object)
                : {})}
            >
              <Text className="text-tp-accent text-base">Edit</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Edit mode: inline empty notice when no stopped sessions available */}
      {isEditMode && stoppedSessions.length === 0 && (
        <View className="px-4 py-2">
          <Text
            className="text-tp-text-secondary text-[15px]"
            testID="sessions-edit-no-stopped"
          >
            No stopped sessions to clean up
          </Text>
        </View>
      )}

      {/* Search — only when not in edit mode (search adds complexity to edit UX) */}
      {!isEditMode && sessions.length > 2 && (
        // WAI-ARIA 1.2 §5.3.27 + WCAG 2.4.1 Bypass Blocks (Level A):
        // a search facility should live inside a search landmark so
        // AT users can jump to it via landmark navigation (NVDA D,
        // JAWS Q, VoiceOver landmarks rotor). RN's AccessibilityRole
        // union excludes "search", so spread the raw ARIA attribute
        // on web. Native AT doesn't surface search-landmark
        // navigation, so this is web-only.
        <View
          className="px-4 py-2"
          {...(Platform.OS === "web"
            ? ({ role: "search" as const } as object)
            : {})}
        >
          <TextInput
            ref={searchRef}
            testID="session-search"
            className={`bg-tp-bg-secondary text-tp-text-primary rounded-search px-4 py-2.5 text-[15px] ${pp.className}`}
            placeholder="Search sessions..."
            placeholderTextColor={placeholderColor}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            accessibilityLabel="Search sessions"
            // accessibilityHint is read by native AT but dropped by RN
            // Web; the matching aria-description is set imperatively on
            // mount (see useEffect above).
            accessibilityHint="Filter sessions by name, path, or status"
            tabIndex={pp.tabIndex}
          />
        </View>
      )}

      {/* Live region for edit-mode state announcements (always mounted).
          NVDA/JAWS attach a mutation observer when a live region enters
          the DOM — if the region is mounted alongside its first content,
          the observer misses the first change. The wrapper stays in the
          DOM at all times; only the text content changes. WAI-ARIA 1.2
          §6.6.3 + WCAG 4.1.3. */}
      <View
        testID="sessions-edit-live-region"
        accessibilityLiveRegion="polite"
        {...(Platform.OS === "web"
          ? ({ role: "status", "aria-live": "polite" } as object)
          : {})}
        // Visually hidden but present in a11y tree (display:none removes
        // from a11y tree and defeats mutation observer attachment).
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          opacity: 0,
        }}
      >
        <Text>{editAnnouncement}</Text>
      </View>

      {/* Session list. Web uses ScrollView + .map() so role=list owns
          role=listitem children directly — FlatList's internal cell
          wrapper inserts two roleless <div>s between the list and each
          listitem, which violates ARIA's required-context rule (§4.3.3)
          and drops listitems out of the AX tree on Firefox/Safari.
          Native keeps FlatList for virtualization on long lists. */}
      {filteredSessions.length === 0 ? (
        // Keep the list landmark even in the empty branch so screen
        // readers and pre-existing specs (app-listitem-aria.spec.ts)
        // still find `role="list"` on the Sessions screen. The empty
        // CTA sits visually inside it; AT will announce the list as
        // having zero items.
        <View
          className="flex-1 items-center justify-center pt-40"
          nativeID="sessions-list"
          {...(Platform.OS === "web" ? { role: "list" as const } : {})}
          accessibilityRole="list"
        >
          <View
            className="w-16 h-16 rounded-2xl bg-tp-bg-secondary items-center justify-center mb-6"
            {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
          >
            <Text className="text-[28px]">💬</Text>
          </View>
          {/* WCAG 4.1.3 Status Messages (Level AA): when the filter
              empties the list, AT users get no announcement and the
              generic "No active sessions" text falsely implies the
              store is empty. Distinguish the two cases and wrap the
              filtered-empty headline in role="status" so the change
              is announced politely without stealing focus. */}
          <Text
            testID="sessions-empty-headline"
            className="text-tp-text-primary text-xl font-semibold mb-2"
            {...(Platform.OS === "web" && filter.trim()
              ? ({ role: "status" as const, "aria-live": "polite" } as object)
              : {})}
          >
            {filter.trim()
              ? "No sessions match your search"
              : "No active sessions"}
          </Text>
          <Text className="text-tp-text-secondary text-[15px] text-center leading-6 px-8">
            {filter.trim()
              ? "Try a different search term."
              : `Start a new session from the\nDaemons tab or run tp on your machine.`}
          </Text>
          {!filter.trim() && (
            <Pressable
              onPress={() => router.push("/(tabs)/daemons")}
              className={`mt-6 bg-tp-accent rounded-card px-8 py-3 ${pp.className}`}
              // Removed from keyboard tab order: react-navigation renders the
              // tab bar after the scene in DOM, so leaving this CTA tabbable
              // captures Tab 1 ahead of the persistent navigation. Mouse/touch
              // users keep the CTA; keyboard users reach Daemons via the tab
              // bar (also documented in the instructional text above).
              tabIndex={-1}
              accessibilityRole="button"
              accessibilityLabel="Go to Daemons"
            >
              <Text className="text-tp-text-on-color font-semibold text-base">
                Go to Daemons
              </Text>
            </Pressable>
          )}
        </View>
      ) : Platform.OS === "web" ? (
        <ScrollView>
          <View role="list" nativeID="sessions-list">
            {filteredSessions.map((item) => (
              <View key={item.sid} role="listitem">
                <SessionRow
                  session={item}
                  isActive={item.sid === currentSid}
                  onPress={() => handleSessionPress(item)}
                  isEditMode={isEditMode}
                  isSelected={selectedSids.has(item.sid)}
                  onToggleSelect={() => toggleSelect(item.sid)}
                />
              </View>
            ))}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filteredSessions}
          keyExtractor={(item) => item.sid}
          accessibilityRole="list"
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              isActive={item.sid === currentSid}
              onPress={() => handleSessionPress(item)}
              isEditMode={isEditMode}
              isSelected={selectedSids.has(item.sid)}
              onToggleSelect={() => toggleSelect(item.sid)}
            />
          )}
        />
      )}

      {/* Confirm delete modal */}
      <ConfirmDeleteSessionsModal
        visible={showConfirmModal}
        sessions={selectedForDelete}
        onCancel={() => setShowConfirmModal(false)}
        onConfirm={handleConfirmDelete}
      />
    </View>
  );
}
