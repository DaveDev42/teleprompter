import SwiftUI

/// App color-scheme preference. Persisted via `@AppStorage("theme")` at the root.
enum AppTheme: String, CaseIterable, Identifiable {
    case system, dark, light

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .dark: return "Dark"
        case .light: return "Light"
        }
    }

    /// The SwiftUI color scheme to apply, or nil to follow the system default.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .dark: return .dark
        case .light: return .light
        }
    }
}
