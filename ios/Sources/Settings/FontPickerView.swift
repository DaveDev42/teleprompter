import SwiftUI

// MARK: - FontPickerMode

enum FontPickerMode {
    case chat, code, terminal

    var title: String {
        switch self {
        case .chat: return "Chat Font"
        case .code: return "Code Font"
        case .terminal: return "Terminal Font"
        }
    }

    var options: [String] {
        switch self {
        case .chat: return chatFontOptions
        case .code, .terminal: return monoFontOptions
        }
    }
}

// MARK: - FontPickerSheet

/// A sheet that lets the user pick a font family for one of the three font slots.
struct FontPickerSheet: View {
    let mode: FontPickerMode
    @Binding var currentFont: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(mode.options, id: \.self) { font in
                Button {
                    currentFont = font
                    dismiss()
                } label: {
                    HStack {
                        Text(font)
                            .font(fontValue(for: font))
                            .foregroundStyle(.primary)
                        Spacer()
                        if font == currentFont {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.tint)
                                .fontWeight(.semibold)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle(mode.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func fontValue(for name: String) -> Font {
        if name == "System" { return .body }
        return .custom(name, size: 17, relativeTo: .body)
    }
}

// MARK: - FontSizeView

/// A sheet that lets the user pick a font size via stepper (range 10–24).
struct FontSizeSheet: View {
    @Binding var fontSize: Int
    @Environment(\.dismiss) private var dismiss

    private let minSize = 10
    private let maxSize = 24

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // Large preview
                    HStack {
                        Spacer()
                        Text("\(fontSize)")
                            .font(.system(size: 64, weight: .bold, design: .rounded))
                            .contentTransition(.numericText())
                            .animation(.spring(duration: 0.2), value: fontSize)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }

                Section {
                    Stepper(
                        "Font Size: \(fontSize)pt",
                        value: Binding(
                            get: { fontSize },
                            set: { fontSize = $0 }
                        ),
                        in: minSize...maxSize)
                }

                Section {
                    HStack {
                        Text("Range")
                        Spacer()
                        Text("\(minSize)–\(maxSize)pt")
                            .foregroundStyle(.secondary)
                            .font(.callout.monospaced())
                    }
                }
            }
            .navigationTitle("Font Size")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
