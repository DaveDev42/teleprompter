import SwiftUI

/// Settings tab — Tranche C: full feature-parity.
///
/// Sections:
///   • Appearance: theme + Chat/Code/Terminal font pickers + font size
///   • Voice: OpenAI API key (Keychain via OpenAIKeychain)
///   • About: version + diagnostics panel
///
/// Font and font-size settings are owned by `SettingsStore.shared` (an
/// `@Observable` singleton backed by UserDefaults). Voice/Chat/Terminal tranches
/// consume settings via `SettingsStore.shared` from any context.
struct SettingsTab: View {
    let coreStatus: String
    /// H10: injected for DiagnosticsView relay WS state + E2EE + RTT (M12).
    /// Optional so existing call sites (macOS sidebar) compile without changes.
    var pairings: PairingViewModel? = nil
    /// H10: injected for DiagnosticsView session counts.
    var sessionStore: SessionStore? = nil

    @AppStorage("theme") private var theme: AppTheme = .system

    var body: some View {
        NavigationStack {
            SettingsForm(
                coreStatus: coreStatus,
                theme: $theme,
                pairings: pairings,
                sessionStore: sessionStore
            )
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.large)
            #endif
        }
    }
}

// MARK: - SettingsForm

struct SettingsForm: View {
    let coreStatus: String
    @Binding var theme: AppTheme
    /// H10: forwarded to DiagnosticsView.
    var pairings: PairingViewModel? = nil
    var sessionStore: SessionStore? = nil

    // MARK: Appearance state

    @State private var settings = SettingsStore.shared
    @State private var fontPickerMode: FontPickerMode? = nil
    @State private var showFontSize = false

    // MARK: API key state

    @State private var hasApiKey: Bool = OpenAIKeychain.isPresent()
    @State private var showApiKey = false

    // MARK: Diagnostics state

    @State private var showDiagnostics = false

    var body: some View {
        Form {
            // MARK: Appearance
            Section("Appearance") {
                Picker("Theme", selection: $theme) {
                    ForEach(AppTheme.allCases) { t in
                        Text(t.title).tag(t)
                    }
                }
                .pickerStyle(.menu)

                // Chat Font
                Button {
                    fontPickerMode = .chat
                } label: {
                    SettingsValueRow(label: "Chat Font", value: settings.chatFont)
                }
                .foregroundStyle(.primary)

                // Code Font
                Button {
                    fontPickerMode = .code
                } label: {
                    SettingsValueRow(label: "Code Font", value: settings.codeFont)
                }
                .foregroundStyle(.primary)

                // Terminal Font
                Button {
                    fontPickerMode = .terminal
                } label: {
                    SettingsValueRow(label: "Terminal Font", value: settings.terminalFont)
                }
                .foregroundStyle(.primary)

                // Font Size
                Button {
                    showFontSize = true
                } label: {
                    SettingsValueRow(label: "Font Size", value: "\(settings.fontSize)pt")
                }
                .foregroundStyle(.primary)
            }

            // MARK: Voice
            Section("Voice") {
                Button {
                    showApiKey = true
                } label: {
                    SettingsValueRow(
                        label: "OpenAI API Key",
                        value: hasApiKey ? "Configured" : "Not set"
                    )
                }
                .foregroundStyle(.primary)
            }

            // MARK: About
            Section("About") {
                Button("Diagnostics") {
                    showDiagnostics = true
                }

                HStack {
                    Text("Version")
                    Spacer()
                    Text(appVersion)
                        .foregroundStyle(.secondary)
                        .font(.callout.monospaced())
                }
            }
        }

        // MARK: Font picker sheet
        .sheet(item: $fontPickerMode) { mode in
            fontPickerBinding(for: mode).map { binding in
                FontPickerSheet(mode: mode, currentFont: binding)
            }
        }

        // MARK: Font size sheet
        .sheet(isPresented: $showFontSize) {
            FontSizeSheet(fontSize: Binding(
                get: { settings.fontSize },
                set: { settings.fontSize = $0 }
            ))
        }

        // MARK: API key sheet
        .sheet(isPresented: $showApiKey) {
            ApiKeySheet(hasKey: hasApiKey) {
                hasApiKey = OpenAIKeychain.isPresent()
            }
        }

        // MARK: Diagnostics sheet
        .sheet(isPresented: $showDiagnostics) {
            NavigationStack {
                // H10: inject PairingViewModel + SessionStore so DiagnosticsView
                // can display live relay WS state, E2EE status, session counts,
                // and RTT (M12) instead of TODO placeholders.
                DiagnosticsView(
                    coreStatus: coreStatus,
                    pairings: pairings,
                    sessionStore: sessionStore
                )
                .navigationTitle("Diagnostics")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showDiagnostics = false }
                    }
                }
            }
        }
    }

    // MARK: Helpers

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    /// Return a `Binding<String>` into `SettingsStore.shared` for the given font mode.
    private func fontPickerBinding(for mode: FontPickerMode) -> Binding<String>? {
        switch mode {
        case .chat:
            return Binding(
                get: { settings.chatFont },
                set: { settings.chatFont = $0 }
            )
        case .code:
            return Binding(
                get: { settings.codeFont },
                set: { settings.codeFont = $0 }
            )
        case .terminal:
            return Binding(
                get: { settings.terminalFont },
                set: { settings.terminalFont = $0 }
            )
        }
    }
}

// MARK: - SettingsValueRow

/// A labeled row with a secondary trailing value — for use inside List/Form buttons.
private struct SettingsValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
                .font(.callout)
        }
    }
}

// MARK: - FontPickerMode: Identifiable

extension FontPickerMode: Identifiable {
    var id: String { title }
}
