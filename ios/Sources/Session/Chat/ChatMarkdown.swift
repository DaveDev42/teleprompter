import SwiftUI

// MARK: - Block parser

/// A parsed markdown block. Mirrors the `Block` type in the old `ChatCard.tsx`.
enum MdBlock {
    case heading(level: Int, text: String)
    case code(lang: String, code: String)
    case list(ordered: Bool, items: [String])
    case para(text: String)
}

/// Parse a markdown string into top-level blocks.
/// Supports: fenced code blocks, ATX headings (h1–h3), unordered/ordered
/// lists, and paragraphs. Blank lines are consumed as separators.
func parseMdBlocks(_ markdown: String) -> [MdBlock] {
    var blocks: [MdBlock] = []
    let lines = markdown
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n")
    var i = 0

    while i < lines.count {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .init(charactersIn: " \t"))

        // ── fenced code block ─────────────────────────────────────────
        if trimmed.hasPrefix("```") {
            let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var codeLines: [String] = []
            i += 1
            while i < lines.count {
                let cl = lines[i].trimmingCharacters(in: .init(charactersIn: " \t"))
                if cl.hasPrefix("```") { i += 1; break }
                codeLines.append(lines[i])
                i += 1
            }
            blocks.append(.code(lang: lang, code: codeLines.joined(separator: "\n")))
            continue
        }

        // ── ATX heading (h1–h3) ───────────────────────────────────────
        if let m = line.range(of: "^(#{1,3})\\s+(.*)", options: .regularExpression) {
            let raw = String(line[m])
            let hashes = raw.prefix(while: { $0 == "#" })
            let level = min(hashes.count, 3)
            let text = raw.drop(while: { $0 == "#" || $0 == " " })
                .trimmingCharacters(in: .whitespaces)
            blocks.append(.heading(level: level, text: text))
            i += 1
            continue
        }

        // ── unordered list item ───────────────────────────────────────
        if let m = line.range(of: "^\\s*[-*]\\s+(.*)", options: .regularExpression) {
            var items: [String] = []
            func extractUl(_ l: String) -> String? {
                guard let r = l.range(of: "^\\s*[-*]\\s+(.*)", options: .regularExpression) else { return nil }
                let full = String(l[r])
                return String(full.drop(while: { $0 == " " || $0 == "\t" || $0 == "-" || $0 == "*" })
                    .drop(while: { $0 == " " }))
            }
            items.append(extractUl(line) ?? "")
            i += 1
            while i < lines.count, let item = extractUl(lines[i]) {
                items.append(item)
                i += 1
            }
            _ = m // silence unused warning
            blocks.append(.list(ordered: false, items: items))
            continue
        }

        // ── ordered list item ─────────────────────────────────────────
        if let m = line.range(of: "^\\s*\\d+\\.\\s+(.*)", options: .regularExpression) {
            var items: [String] = []
            func extractOl(_ l: String) -> String? {
                guard let r = l.range(of: "^\\s*\\d+\\.\\s+(.*)", options: .regularExpression) else { return nil }
                let full = String(l[r])
                // drop the "N. " prefix
                if let dotIdx = full.firstIndex(of: ".") {
                    return String(full[full.index(after: dotIdx)...])
                        .trimmingCharacters(in: .whitespaces)
                }
                return nil
            }
            items.append(extractOl(line) ?? "")
            i += 1
            while i < lines.count, let item = extractOl(lines[i]) {
                items.append(item)
                i += 1
            }
            _ = m
            blocks.append(.list(ordered: true, items: items))
            continue
        }

        // ── blank line ────────────────────────────────────────────────
        if trimmed.isEmpty {
            i += 1
            continue
        }

        // ── paragraph (accumulate until blank/heading/list/fence) ─────
        var paraLines: [String] = [line]
        i += 1
        while i < lines.count {
            let nl = lines[i]
            let nt = nl.trimmingCharacters(in: .init(charactersIn: " \t"))
            if nt.isEmpty { break }
            if nt.hasPrefix("```") { break }
            if nl.range(of: "^#{1,3}\\s", options: .regularExpression) != nil { break }
            if nl.range(of: "^\\s*[-*]\\s", options: .regularExpression) != nil { break }
            if nl.range(of: "^\\s*\\d+\\.\\s", options: .regularExpression) != nil { break }
            paraLines.append(nl)
            i += 1
        }
        blocks.append(.para(text: paraLines.joined(separator: "\n")))
    }

    return blocks
}

// MARK: - Inline segment parser

/// An inline markdown segment (link / bold / italic / inline-code / plain text).
/// Link is listed first so `[text](url)` is matched before emphasis patterns
/// misinterpret the brackets (M4 — mirrors `ChatCard.tsx:32` ordering).
enum MdInlineSeg {
    case link(text: String, url: String)
    case text(String)
    case bold(String)
    case italic(String)
    case code(String)
}

/// Split one line of text into link/bold/italic/inline-code/plain segments.
/// Matches (in priority order):
///   1. `[text](https://... | http://... | mailto:...)` — inline links (M4)
///   2. `` `code` `` — inline code
///   3. `**bold**`, `__bold__` — bold
///   4. `*italic*`, `_italic_` (with word-boundary guard) — italic
func parseMdInline(_ raw: String) -> [MdInlineSeg] {
    // Link alternative FIRST (before emphasis) so brackets aren't re-interpreted.
    // Only http/https/mailto URLs are permitted (matches Expo ground truth).
    let pattern = "("
        + "\\[[^\\]]+\\]\\((?:https?://|mailto:)[^\\s)]+\\)"   // link
        + "|`[^`]+`"                                             // inline code
        + "|\\*\\*[\\s\\S]+?\\*\\*"                             // **bold**
        + "|(?<![A-Za-z0-9_])__[\\s\\S]+?__(?![A-Za-z0-9_])"  // __bold__
        + "|\\*[\\s\\S]+?\\*"                                   // *italic*
        + "|(?<![A-Za-z0-9_])_[\\s\\S]+?_(?![A-Za-z0-9_])"    // _italic_
        + ")"
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
        return [.text(raw)]
    }
    let ns = raw as NSString
    let full = NSRange(location: 0, length: ns.length)
    let matches = regex.matches(in: raw, range: full)

    var segs: [MdInlineSeg] = []
    var last = 0
    for m in matches {
        let range = m.range
        if range.location > last {
            segs.append(.text(ns.substring(with: NSRange(location: last, length: range.location - last))))
        }
        let tok = ns.substring(with: range)
        if tok.hasPrefix("[") {
            // M4: inline link `[text](url)` — split at `](`.
            if let bracketClose = tok.range(of: "]("),
               let textRange = tok.range(of: "["),
               let urlClose = tok.last, urlClose == ")" {
                let textStart = tok.index(after: textRange.lowerBound)
                let textEnd   = bracketClose.lowerBound
                let urlStart  = bracketClose.upperBound
                let urlEnd    = tok.index(before: tok.endIndex)
                let linkText  = String(tok[textStart..<textEnd])
                let linkUrl   = String(tok[urlStart..<urlEnd])
                segs.append(.link(text: linkText, url: linkUrl))
            } else {
                segs.append(.text(tok))
            }
        } else if tok.hasPrefix("**") || tok.hasPrefix("__") {
            let inner = String(tok.dropFirst(2).dropLast(2))
            segs.append(.bold(inner))
        } else if tok.hasPrefix("`") {
            let inner = String(tok.dropFirst().dropLast())
            segs.append(.code(inner))
        } else {
            // * or _ italic
            let inner = String(tok.dropFirst().dropLast())
            segs.append(.italic(inner))
        }
        last = range.location + range.length
    }
    if last < ns.length {
        segs.append(.text(ns.substring(from: last)))
    }
    return segs.isEmpty ? [.text(raw)] : segs
}

// MARK: - Inline SwiftUI view

/// Renders one line of text with inline bold/italic/code/link formatting.
/// L7: accepts a resolved body font so callers can inject SettingsStore values.
struct MdInlineText: View {
    let raw: String
    /// Body font to apply to plain text segments (L7). Defaults to `.body`.
    var bodyFont: Font = .body
    /// Code font to apply to inline code segments (L7). Defaults to system monospaced caption.
    var codeFont: Font = .system(.caption, design: .monospaced)

    var body: some View {
        let segs = parseMdInline(raw)
        // Build a single Text from concatenated attributed spans.
        // Link segments use AttributedString so taps open the URL (M4).
        segs.reduce(Text("")) { acc, seg in
            switch seg {
            case .text(let s):
                return acc + Text(s).font(bodyFont)
            case .bold(let s):
                return acc + Text(s).font(bodyFont).bold()
            case .italic(let s):
                return acc + Text(s).font(bodyFont).italic()
            case .code(let s):
                return acc + Text(s)
                    .font(codeFont)
                    .foregroundStyle(Color.green.opacity(0.9))
            case .link(let text, let url):
                // M4: render as tappable attributed string link.
                var attr = AttributedString(text)
                attr.font = bodyFont
                if let u = URL(string: url) {
                    attr.link = u
                }
                attr.foregroundColor = .blue
                attr.underlineStyle = .single
                return acc + Text(attr)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Font helpers (L7)

/// Build a chat body font from SettingsStore values.
/// "System" → `.system(size:)`; any other name → `.custom(_:size:)`.
func chatBodyFont(settings: SettingsStore) -> Font {
    let size = CGFloat(settings.fontSize)
    if settings.chatFont == "System" || settings.chatFont == "SF Pro" {
        return .system(size: size)
    }
    return .custom(settings.chatFont, size: size)
}

/// Build a code/monospaced font from SettingsStore values.
func chatCodeFont(settings: SettingsStore) -> Font {
    let size = CGFloat(settings.fontSize) - 2 // slightly smaller than body
    if settings.codeFont == "Menlo" || settings.codeFont == "SF Mono" {
        return .system(size: size, design: .monospaced)
    }
    return .custom(settings.codeFont, size: size)
}

// MARK: - Rich markdown view

/// Fast-path hasMd check (mirrors the regex in old `ChatCard.tsx`).
/// Also detects markdown links (M4) and fast-paths to markdown render.
private func hasMd(_ text: String) -> Bool {
    // NSRegularExpression with .anchorsMatchLines so ^ and $ match per-line.
    let pattern = "```|^#{1,3}\\s|^\\s*[-*]\\s|^\\s*\\d+\\.\\s|\\*\\*|\\*[^*]|__[^_]|_[^_]|`[^`]|\\[[^\\]]+\\]\\((?:https?://|mailto:)"
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
        return false
    }
    return re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

/// Renders a markdown string as a rich SwiftUI view.
/// Supports: headings, fenced code blocks (monospaced, copy-on-long-press),
/// ordered/unordered lists, paragraphs with inline bold/italic/code/links.
/// L7: reads `SettingsStore.shared` for font/size preferences.
struct ChatMarkdownView: View {
    let text: String

    // L7: observe SettingsStore for reactive font changes.
    // SettingsStore is @Observable, so we read it directly — SwiftUI tracks
    // the accessed properties and re-renders when they change.
    @State private var settingsTick: Int = 0 // forces re-eval when settings change

    private var settings: SettingsStore { SettingsStore.shared }
    private var bodyFont: Font { chatBodyFont(settings: settings) }
    private var codeFont: Font { chatCodeFont(settings: settings) }

    var body: some View {
        if !hasMd(text) {
            // Fast path: no markdown → plain selectable text with user font.
            Text(text)
                .font(bodyFont)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            let blocks = parseMdBlocks(text)
            if blocks.isEmpty {
                Text(text).font(bodyFont).textSelection(.enabled)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        blockView(block)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MdBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            headingView(level: level, text: text)
        case .code(let lang, let code):
            codeBlockView(lang: lang, code: code)
        case .list(let ordered, let items):
            listView(ordered: ordered, items: items)
        case .para(let text):
            MdInlineText(raw: text, bodyFont: bodyFont, codeFont: codeFont)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func headingView(level: Int, text: String) -> some View {
        // Headings use fixed sizes relative to body; apply chatFont family.
        let size = CGFloat(settings.fontSize)
        let headingFont: Font = {
            let name = settings.chatFont == "System" || settings.chatFont == "SF Pro"
                ? nil : settings.chatFont as String?
            switch level {
            case 1:
                return name.map { .custom($0, size: size + 4) } ?? .system(size: size + 4, weight: .bold)
            case 2:
                return name.map { .custom($0, size: size + 2) } ?? .system(size: size + 2, weight: .semibold)
            default:
                return name.map { .custom($0, size: size + 1) } ?? .system(size: size + 1, weight: .semibold)
            }
        }()
        Text(text)
            .font(headingFont)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func codeBlockView(lang: String, code: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !lang.isEmpty {
                Text(lang)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Text(code)
                .font(codeFont)
                .foregroundStyle(Color.green.opacity(0.9))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.background.opacity(0.15))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(.quaternary, lineWidth: 0.5)
                )
        )
        .accessibilityLabel(lang.isEmpty ? "Code block" : "Code block, \(lang)")
        .accessibilityHint("Long press to copy")
        .contextMenu {
            Button {
                #if os(iOS)
                UIPasteboard.general.string = code
                #elseif os(macOS)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
                #endif
            } label: {
                Label("Copy Code", systemImage: "doc.on.doc")
            }
        }
    }

    @ViewBuilder
    private func listView(ordered: Bool, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                HStack(alignment: .top, spacing: 6) {
                    Text(ordered ? "\(idx + 1)." : "•")
                        .font(bodyFont)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 18, alignment: .trailing)
                    MdInlineText(raw: item, bodyFont: bodyFont, codeFont: codeFont)
                        .textSelection(.enabled)
                }
            }
        }
    }
}
