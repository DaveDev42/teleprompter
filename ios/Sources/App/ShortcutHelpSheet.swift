import SwiftUI

/// Keyboard shortcut help sheet, ported from the Expo `ShortcutHelpModal`.
///
/// Differences from the Expo version:
/// - Web single-key global shortcuts ("?", "1", "2", "3") dropped.
/// - Native iPad/macOS keyboard shortcuts documented instead.
/// - Presented as a SwiftUI `.sheet` (not a modal overlay).
/// - Game-controller section restored natively (MFi/Xbox/PlayStation via
///   `GamepadCoordinator`) — connect a controller and the listed actions apply.
///
/// The sheet is opened by:
/// - macOS: Help → Keyboard Shortcuts menu item (wired in `MacCommands`).
/// - iOS / iPadOS / visionOS: the ⌘/ keyboard shortcut on the root window
///   (wired as a hidden button in `RootView.tabNavShortcuts`).
struct ShortcutHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(ShortcutSection.all) { section in
                    Section(section.title) {
                        ForEach(section.items) { item in
                            ShortcutRow(item: item)
                        }
                    }
                }

                Section {
                    Text("Tab navigation (⌘1/⌘2/⌘3) always works. While you are typing or the Terminal pane is open, the session-movement shortcuts (⌘[ / ⌘] / ⌘K) are inactive so they don't steal a keystroke. The pane switches (⌃⌘C / ⌘T) and Find (⌘F) stay active so you can always leave the terminal.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Keyboard Shortcuts")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Data

struct ShortcutSection: Identifiable {
    let id = UUID()
    let title: String
    let items: [ShortcutEntry]

    static let all: [ShortcutSection] = [
        ShortcutSection(title: "Navigation", items: [
            ShortcutEntry(keys: ["⌘1"], description: "Go to Sessions"),
            ShortcutEntry(keys: ["⌘2"], description: "Go to Daemons"),
            ShortcutEntry(keys: ["⌘3"], description: "Go to Settings"),
        ]),
        ShortcutSection(title: "Session screen", items: [
            ShortcutEntry(keys: ["⌃⌘C"], description: "Chat tab"),
            ShortcutEntry(keys: ["⌘T"], description: "Terminal tab"),
            ShortcutEntry(keys: ["⌘F"], description: "Find in terminal"),
            ShortcutEntry(keys: ["⌘["], description: "Previous session"),
            ShortcutEntry(keys: ["⌘]"], description: "Next session"),
            ShortcutEntry(keys: ["⌘K"], description: "Quick switch session"),
        ]),
        ShortcutSection(title: "Global", items: [
            ShortcutEntry(keys: ["⌘/"], description: "Show keyboard shortcuts"),
            ShortcutEntry(keys: ["⌘N"], description: "New Pairing"),
            // macOS menu-bar commands (MacCommands.swift); inert on iOS/iPadOS.
            ShortcutEntry(keys: ["⌘⇧C"], description: "Copy daemon ID (macOS)"),
            ShortcutEntry(keys: ["⌘⌫"], description: "Disconnect daemon (macOS)"),
        ]),
        // Game controller (MFi/Xbox/PlayStation) — handled by GamepadCoordinator.
        // Connect a controller and these apply; D-pad/stick focus moves over the
        // Sessions list, A opens the focused session, B leaves the terminal / goes
        // back, bumpers cycle the tabs.
        ShortcutSection(title: "Game controller", items: [
            ShortcutEntry(keys: ["D-pad", "Stick"], description: "Move focus (Sessions list)"),
            ShortcutEntry(keys: ["A"], description: "Open focused session"),
            ShortcutEntry(keys: ["B"], description: "Leave terminal / back"),
            ShortcutEntry(keys: ["LB", "RB"], description: "Cycle tabs"),
        ]),
    ]
}

struct ShortcutEntry: Identifiable {
    let id = UUID()
    let keys: [String]
    let description: String
}

// MARK: - ShortcutRow

private struct ShortcutRow: View {
    let item: ShortcutEntry

    var body: some View {
        HStack {
            Text(item.description)
                .font(.system(size: 14))
            Spacer()
            HStack(spacing: 4) {
                ForEach(item.keys, id: \.self) { key in
                    KeyChipView(label: key)
                }
            }
        }
    }
}

private struct KeyChipView: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.system(size: 13, design: .monospaced))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(.background.secondary)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(.separator, lineWidth: 0.5)
            )
    }
}

// MARK: - View modifier

extension View {
    /// Attach the shortcut-help sheet, driven by a binding.
    ///
    /// Usage:
    /// ```swift
    /// .shortcutHelpSheet(isPresented: $showShortcutHelp)
    /// ```
    func shortcutHelpSheet(isPresented: Binding<Bool>) -> some View {
        sheet(isPresented: isPresented) {
            ShortcutHelpSheet()
        }
    }
}
