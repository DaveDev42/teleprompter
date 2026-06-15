import SwiftUI

/// Settings tab. Tranche 0 content: Appearance (theme) + About (diagnostics, version).
/// Fonts / API Key / Updates are TODO placeholders for later tranches — the section
/// skeleton is laid out here so they just add rows without restructuring.
struct SettingsTab: View {
    let coreStatus: String

    @AppStorage("theme") private var theme: AppTheme = .system

    var body: some View {
        NavigationStack {
            SettingsForm(coreStatus: coreStatus, theme: $theme)
                .navigationTitle("Settings")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.large)
                #endif
        }
    }
}

struct SettingsForm: View {
    let coreStatus: String
    @Binding var theme: AppTheme

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

                // TODO (later tranche): Font size picker
                // TODO (later tranche): Terminal font family
            }

            // MARK: Voice (placeholder for later tranche)
            Section("Voice") {
                // TODO (later tranche): OpenAI API key entry
                // TODO (later tranche): voice model picker
                Text("Voice settings — coming soon")
                    .foregroundStyle(.secondary)
                    .font(.callout)
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

                // TODO (later tranche): Check for updates row
            }
        }
        .sheet(isPresented: $showDiagnostics) {
            NavigationStack {
                ContentView(coreStatus: coreStatus)
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

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
