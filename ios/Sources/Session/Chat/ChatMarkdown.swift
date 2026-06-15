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

/// An inline markdown segment (bold / italic / inline-code / plain text).
enum MdInlineSeg {
    case text(String)
    case bold(String)
    case italic(String)
    case code(String)
}

/// Split one line of text into bold/italic/inline-code/plain segments.
/// Matches `**bold**`, `__bold__`, `*italic*`, `_italic_` (with word-boundary
/// guard for underscores), and `` `code` ``.
func parseMdInline(_ raw: String) -> [MdInlineSeg] {
    // Regex: longest match first. Inline code before emphasis so backticks
    // inside bold don't confuse the parser.
    let pattern = "(`[^`]+`|\\*\\*[\\s\\S]+?\\*\\*|(?<![A-Za-z0-9_])__[\\s\\S]+?__(?![A-Za-z0-9_])|\\*[\\s\\S]+?\\*|(?<![A-Za-z0-9_])_[\\s\\S]+?_(?![A-Za-z0-9_]))"
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
        if tok.hasPrefix("**") || tok.hasPrefix("__") {
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

/// Renders one line of text with inline bold/italic/code formatting.
struct MdInlineText: View {
    let raw: String

    var body: some View {
        let segs = parseMdInline(raw)
        // Build a single Text from concatenated attributed spans.
        segs.reduce(Text("")) { acc, seg in
            switch seg {
            case .text(let s):
                return acc + Text(s)
            case .bold(let s):
                return acc + Text(s).bold()
            case .italic(let s):
                return acc + Text(s).italic()
            case .code(let s):
                return acc + Text(s)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.green.opacity(0.9))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Rich markdown view

/// Fast-path hasMd check (mirrors the regex in old `ChatCard.tsx`).
private func hasMd(_ text: String) -> Bool {
    // NSRegularExpression with .anchorsMatchLines so ^ and $ match per-line.
    let pattern = "```|^#{1,3}\\s|^\\s*[-*]\\s|^\\s*\\d+\\.\\s|\\*\\*|\\*[^*]|__[^_]|_[^_]|`[^`]"
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
        return false
    }
    return re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
}

/// Renders a markdown string as a rich SwiftUI view.
/// Supports: headings, fenced code blocks (monospaced, copy-on-long-press),
/// ordered/unordered lists, paragraphs with inline bold/italic/code.
struct ChatMarkdownView: View {
    let text: String

    var body: some View {
        if !hasMd(text) {
            // Fast path: no markdown → plain selectable text.
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            let blocks = parseMdBlocks(text)
            if blocks.isEmpty {
                Text(text).font(.body).textSelection(.enabled)
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
            MdInlineText(raw: text)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func headingView(level: Int, text: String) -> some View {
        let font: Font = level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold()
        Text(text)
            .font(font)
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
                .font(.system(.caption, design: .monospaced))
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
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 18, alignment: .trailing)
                    MdInlineText(raw: item)
                        .textSelection(.enabled)
                }
            }
        }
    }
}
