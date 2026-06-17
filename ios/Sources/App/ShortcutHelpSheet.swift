import SwiftUI

/// Keyboard shortcut help sheet, ported from the Expo `ShortcutHelpModal`.
///
/// Differences from the Expo version:
/// - Game-controller section dropped (web/tvOS-only).
/// - Web single-key global shortcuts ("?", "1", "2", "3") dropped.
/// - Native iPad/macOS keyboard shortcuts documented instead.
/// - Presented as a SwiftUI `.sheet` (not a modal overlay).
///
/// The sheet is opened by:
/// - macOS: Help → Keyboard Shortcuts menu item (wired in `MacCommands`).
/// - iPad: ⌘/ keyboard shortcut on the root window (wired in `RootView`).
/// - Any platform: the `?` button in `SettingsTab` (future, Phase 3).
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
                    Text("Tab navigation (⌘1/⌘2/⌘3) always works. Session shortcuts are inactive while you are typing or the terminal has focus — except Find (⌘F), which stays active.")
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
