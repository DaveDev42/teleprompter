import SwiftUI
import Security
import os

// MARK: - Font constants

/// Sans-serif font families available for the Chat font picker.
let chatFontOptions: [String] = [
    "System",
    "SF Pro",
    "Helvetica Neue",
    "Arial",
]

/// Monospaced font families available for Code and Terminal font pickers.
let monoFontOptions: [String] = [
    "Menlo",
    "Monaco",
    "Courier New",
    "SF Mono",
    "JetBrains Mono",
]

// MARK: - SettingsStore

/// Shared app settings: fonts, font size.
///
/// Persisted via `@AppStorage`/UserDefaults. Use `SettingsStore.shared` to
/// read values from non-view contexts (e.g. Chat/Terminal rendering).
///
/// Voice/Chat/Terminal tranches should read these values via the environment
/// object injected at the root, or directly from `SettingsStore.shared`.
@Observable
final class SettingsStore {
    static let shared = SettingsStore()

    // MARK: Persisted settings

    /// Font family for chat message text. Default: "System".
    var chatFont: String {
        get { _chatFont }
        set { _chatFont = newValue; UserDefaults.standard.set(newValue, forKey: Keys.chatFont) }
    }

    /// Font family for inline code spans in chat. Default: "Menlo".
    var codeFont: String {
        get { _codeFont }
        set { _codeFont = newValue; UserDefaults.standard.set(newValue, forKey: Keys.codeFont) }
    }

    /// Font family for the terminal tab. Default: "Menlo".
    var terminalFont: String {
        get { _terminalFont }
        set { _terminalFont = newValue; UserDefaults.standard.set(newValue, forKey: Keys.terminalFont) }
    }

    /// Base font size in points (range 10–24). Default: 15.
    var fontSize: Int {
        get { _fontSize }
        set {
            let clamped = min(24, max(10, newValue))
            _fontSize = clamped
            UserDefaults.standard.set(clamped, forKey: Keys.fontSize)
        }
    }

    // MARK: Backing storage

    private var _chatFont: String
    private var _codeFont: String
    private var _terminalFont: String
    private var _fontSize: Int

    // MARK: UserDefaults keys

    private enum Keys {
        static let chatFont     = "tp.settings.chatFont"
        static let codeFont     = "tp.settings.codeFont"
        static let terminalFont = "tp.settings.terminalFont"
        static let fontSize     = "tp.settings.fontSize"
    }

    init() {
        let ud = UserDefaults.standard
        _chatFont     = ud.string(forKey: Keys.chatFont)     ?? "System"
        _codeFont     = ud.string(forKey: Keys.codeFont)     ?? "Menlo"
        _terminalFont = ud.string(forKey: Keys.terminalFont) ?? "Menlo"
        let stored = ud.integer(forKey: Keys.fontSize)
        _fontSize     = (stored >= 10 && stored <= 24) ? stored : 15
    }
}

// MARK: - OpenAI API key (Keychain)

/// Read/write/clear the OpenAI API key from/to the Keychain.
///
/// The key is stored as a generic password keyed by the account string below.
/// On macOS local dev builds (no keychain-access-groups entitlement) sync is
/// disabled to avoid errSecMissingEntitlement — mirroring PairingStore's logic.
/// The key is NEVER logged or printed.
enum OpenAIKeychain {

    private static let service = "dev.tpmt.teleprompter"
    private static let account = "openai.api.key"

    // MARK: Get

    /// Returns the stored API key, or `nil` if not set or any error occurs.
    /// Never throws — failures silently return nil so UI never blocks on Keychain errors.
    static func get() -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: Set

    /// Saves or replaces the API key in the Keychain.
    /// - Returns: `true` on success.
    @discardableResult
    static func set(_ key: String) -> Bool {
        guard let data = key.data(using: .utf8) else { return false }
        #if os(macOS)
        let syncValue: CFBoolean = kCFBooleanFalse!
        #else
        let syncValue: CFBoolean = kCFBooleanFalse! // API key is device-local (not shared across devices)
        #endif
        let base: [String: Any] = [
            kSecClass as String:             kSecClassGenericPassword,
            kSecAttrService as String:       service,
            kSecAttrAccount as String:       account,
            kSecAttrSynchronizable as String: syncValue,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String]        = data
        add[kSecAttrAccessible as String]   = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    // MARK: Delete

    /// Removes the stored API key from the Keychain (idempotent).
    static func delete() {
        let query: [String: Any] = [
            kSecClass as String:             kSecClassGenericPassword,
            kSecAttrService as String:       service,
            kSecAttrAccount as String:       account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: Existence check (no value)

    /// Returns `true` if a key is present without reading the key value.
    static func isPresent() -> Bool {
        let query: [String: Any] = [
            kSecClass as String:             kSecClassGenericPassword,
            kSecAttrService as String:       service,
            kSecAttrAccount as String:       account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecMatchLimit as String:        kSecMatchLimitOne,
            kSecReturnData as String:        false,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }
}
