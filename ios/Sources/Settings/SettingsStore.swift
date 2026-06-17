import Security
import SwiftUI
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
///
/// `@MainActor` because every call site is main-actor-bound: SwiftUI views
/// (`SettingsTab`, `ChatCard`, `ChatMarkdown`) and `VoiceStore` which is itself
/// `@MainActor`. The class holds mutable `var` backing fields, so `Sendable` is
/// not appropriate — main-actor isolation serializes all reads and writes.
@MainActor
@Observable
final class SettingsStore {
    static let shared = SettingsStore()

    // MARK: Persisted settings

    /// Font family for chat message text. Default: "System".
    var chatFont: String {
        get { _chatFont }
        set {
            _chatFont = newValue
            UserDefaults.standard.set(newValue, forKey: Keys.chatFont)
        }
    }

    /// Font family for inline code spans in chat. Default: "Menlo".
    var codeFont: String {
        get { _codeFont }
        set {
            _codeFont = newValue
            UserDefaults.standard.set(newValue, forKey: Keys.codeFont)
        }
    }

    /// Font family for the terminal tab. Default: "Menlo".
    var terminalFont: String {
        get { _terminalFont }
        set {
            _terminalFont = newValue
            UserDefaults.standard.set(newValue, forKey: Keys.terminalFont)
        }
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

    /// Which voice backend to use for voice input. Default: `.auto`
    /// (on-device when no OpenAI key is configured, OpenAI Realtime when a key
    /// is present). Resolve to a concrete kind via `resolvedVoiceBackendKind(hasKey:)`.
    var voiceBackend: VoiceBackendPreference {
        get { _voiceBackend }
        set {
            _voiceBackend = newValue
            UserDefaults.standard.set(newValue.rawValue, forKey: Keys.voiceBackend)
        }
    }

    // MARK: Backing storage

    private var _chatFont: String
    private var _codeFont: String
    private var _terminalFont: String
    private var _fontSize: Int
    private var _voiceBackend: VoiceBackendPreference

    // MARK: UserDefaults keys

    private enum Keys {
        static let chatFont = "tp.settings.chatFont"
        static let codeFont = "tp.settings.codeFont"
        static let terminalFont = "tp.settings.terminalFont"
        static let fontSize = "tp.settings.fontSize"
        static let voiceBackend = "tp.settings.voiceBackend"
    }

    init() {
        let ud = UserDefaults.standard
        _chatFont = ud.string(forKey: Keys.chatFont) ?? "System"
        _codeFont = ud.string(forKey: Keys.codeFont) ?? "Menlo"
        _terminalFont = ud.string(forKey: Keys.terminalFont) ?? "Menlo"
        let stored = ud.integer(forKey: Keys.fontSize)
        _fontSize = (stored >= 10 && stored <= 24) ? stored : 15
        _voiceBackend =
            ud.string(forKey: Keys.voiceBackend)
            .flatMap(VoiceBackendPreference.init(rawValue:)) ?? .auto
    }

    // MARK: Voice backend resolution

    /// Resolves the persisted preference to a concrete `VoiceBackendKind`, or
    /// `nil` for `.auto`. `VoiceStore.resolveBackendKind()` owns the `.auto`
    /// default + the "OpenAI chosen but no key → fall back to on-device" guard,
    /// so this accessor stays a pure preference→kind mapping.
    var voiceBackendPreference: VoiceBackendKind? {
        switch voiceBackend {
        case .auto: return nil
        case .onDevice: return .onDevice
        case .openAI: return .openAIRealtime
        }
    }
}

// MARK: - VoiceBackendPreference

/// User-selectable voice backend preference, persisted in UserDefaults
/// (`tp.settings.voiceBackend`). Resolved to a concrete `VoiceBackendKind`
/// via `SettingsStore.resolvedVoiceBackendKind(hasKey:)`.
enum VoiceBackendPreference: String, CaseIterable {
    /// On-device when no OpenAI key, OpenAI Realtime when a key is present.
    case auto
    /// Always on-device (offline STT/TTS, no API key required).
    case onDevice
    /// Always OpenAI Realtime (requires an API key).
    case openAI

    /// Human-readable title for pickers.
    var title: String {
        switch self {
        case .auto: return "Auto"
        case .onDevice: return "On-device"
        case .openAI: return "OpenAI Realtime"
        }
    }
}

// MARK: - VoiceBackendKind

/// Concrete voice backend to instantiate. Canonical definition lives here so
/// `SettingsStore.resolvedVoiceBackendKind(hasKey:)` compiles standalone; the
/// voice seam's adapter (`Voice/VoiceBackend.swift`) consumes this type and MUST
/// NOT redeclare it (same module = single definition).
enum VoiceBackendKind: String, CaseIterable {
    /// On-device STT (SFSpeechRecognizer) + optional FoundationModels refine + AVSpeechSynthesizer TTS.
    case onDevice
    /// OpenAI Realtime API over WebSocket (RealtimeClient).
    case openAIRealtime
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
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
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
        // API key is device-local (not shared across devices).
        let syncValue: CFBoolean = kCFBooleanFalse!
        #endif
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: syncValue,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    // MARK: Delete

    /// Removes the stored API key from the Keychain (idempotent).
    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: Existence check (no value)

    /// Returns `true` if a key is present without reading the key value.
    static func isPresent() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: false,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }
}
