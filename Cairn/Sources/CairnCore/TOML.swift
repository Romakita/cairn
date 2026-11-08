import Foundation

// Lecteur/écrivain TOML « sans perte » limité au sous-ensemble dont Cairn a besoin :
// tables, tableaux de tables, chaînes, entiers, flottants, booléens, tableaux et tables en ligne.
// Le texte d'origine est conservé ligne à ligne : réécrire un document non modifié redonne le même texte,
// commentaires et clés inconnues compris. Une modification ne touche que la valeur concernée.

public indirect enum TOMLValue: Equatable, Sendable {
    case string(String)
    case integer(Int64)
    case double(Double)
    case bool(Bool)
    case array([TOMLValue])
    case inlineTable([(String, TOMLValue)])

    public static func == (a: TOMLValue, b: TOMLValue) -> Bool {
        switch (a, b) {
        case let (.string(x), .string(y)): x == y
        case let (.integer(x), .integer(y)): x == y
        case let (.double(x), .double(y)): x == y
        case let (.bool(x), .bool(y)): x == y
        case let (.array(x), .array(y)): x == y
        case let (.inlineTable(x), .inlineTable(y)): x.map(\.0) == y.map(\.0) && x.map(\.1) == y.map(\.1)
        default: false
        }
    }

    public var string: String? { if case let .string(s) = self { s } else { nil } }
    public var integer: Int64? { if case let .integer(i) = self { i } else { nil } }
    public var bool: Bool? { if case let .bool(b) = self { b } else { nil } }
    public var double: Double? {
        switch self {
        case let .double(d): d
        case let .integer(i): Double(i)
        default: nil
        }
    }
    public var array: [TOMLValue]? { if case let .array(a) = self { a } else { nil } }
    public var inlineTable: [(String, TOMLValue)]? { if case let .inlineTable(t) = self { t } else { nil } }

    /// Nom du type, pour les messages d'erreur.
    public var typeName: String {
        switch self {
        case .string: "string"
        case .integer: "integer"
        case .double: "float"
        case .bool: "boolean"
        case .array: "array"
        case .inlineTable: "table"
        }
    }

    /// Écriture TOML de la valeur.
    public func render() -> String {
        switch self {
        case let .string(s): return TOMLValue.quote(s)
        case let .integer(i): return String(i)
        case let .double(d):
            let s = String(d)
            return s.contains(".") || s.contains("e") ? s : s + ".0"
        case let .bool(b): return b ? "true" : "false"
        case let .array(a): return "[" + a.map { $0.render() }.joined(separator: ", ") + "]"
        case let .inlineTable(t):
            return t.isEmpty ? "{}" : "{ " + t.map { "\(TOMLValue.renderKey($0.0)) = \($0.1.render())" }.joined(separator: ", ") + " }"
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default:
                if ch.value < 0x20 { out += String(format: "\\u%04X", ch.value) } else { out.unicodeScalars.append(ch) }
            }
        }
        return out + "\""
    }

    static func renderKey(_ k: String) -> String {
        let bare = !k.isEmpty && k.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-"
        }
        return bare ? k : quote(k)
    }
}

public struct TOMLError: Error, Equatable, CustomStringConvertible, Sendable {
    public let line: Int
    public let message: String
    public var description: String { "line \(line): \(message)" }
}

/// Document TOML conservant le texte d'origine.
public struct TOMLDocument: Sendable {
    /// Un élément du document : une ou plusieurs lignes de texte brut.
    public enum Kind: Sendable, Equatable {
        case trivia                         // ligne vide ou commentaire
        case table([String])                // [a.b]
        case arrayTable([String])           // [[a.b]]
        case keyValue([String])             // a.b = valeur (clé relative à la table courante)
    }

    public struct Item: Sendable {
        public var kind: Kind
        public var raw: String              // texte exact, saut de ligne final compris
        public var line: Int                // numéro de la première ligne (1-based)
        var value: TOMLValue?
        var valueRange: Range<String.Index>? // position de la valeur dans `raw`
    }

    public private(set) var items: [Item] = []

    // MARK: Lecture

    public init(parsing text: String) throws {
        var p = Parser(text: text)
        items = try p.parseAll()
        _ = try tree() // détecte les clés en double
    }

    /// Texte du document.
    public func render() -> String { items.map(\.raw).joined() }

    /// Contexte (table courante) de chaque élément : chemin de table et, pour un tableau de tables, l'index.
    struct Section: Equatable { var path: [String]; var arrayIndex: Int? }

    func sections() -> [Section] {
        var result: [Section] = []
        var current = Section(path: [], arrayIndex: nil)
        var counts: [[String]: Int] = [:]
        for item in items {
            switch item.kind {
            case let .table(path): current = Section(path: path, arrayIndex: nil)
            case let .arrayTable(path):
                let i = counts[path, default: 0]
                counts[path] = i + 1
                current = Section(path: path, arrayIndex: i)
            default: break
            }
            result.append(current)
        }
        return result
    }

    /// Arbre des valeurs : table racine.
    public func tree() throws -> TOMLTable {
        var root = TOMLTable()
        let secs = sections()
        for (i, item) in items.enumerated() {
            let sec = secs[i]
            switch item.kind {
            case let .table(path):
                try root.ensureTable(path, line: item.line)
            case let .arrayTable(path):
                try root.appendArrayTable(path, line: item.line)
            case let .keyValue(key):
                guard let v = item.value else { continue }
                try root.insert(value: v, section: sec, key: key, line: item.line)
            case .trivia:
                break
            }
        }
        return root
    }

    /// Ligne d'une clé (pour les messages d'erreur), si elle existe.
    public func line(section: [String], arrayIndex: Int? = nil, key: [String]) -> Int? {
        let secs = sections()
        for (i, item) in items.enumerated() {
            if case let .keyValue(k) = item.kind, k == key, secs[i] == Section(path: section, arrayIndex: arrayIndex) {
                return item.line
            }
        }
        return nil
    }

    // MARK: Écriture

    /// Remplace ou ajoute `key = value` dans une table (`section` vide = racine). Les commentaires restent en place.
    public mutating func set(_ value: TOMLValue, section: [String] = [], arrayIndex: Int? = nil, key: [String]) {
        let target = Section(path: section, arrayIndex: arrayIndex)
        let secs = sections()
        // 1. Clé existante : on ne remplace que la valeur.
        for (i, item) in items.enumerated() {
            if case let .keyValue(k) = item.kind, k == key, secs[i] == target, let r = item.valueRange {
                var raw = item.raw
                raw.replaceSubrange(r, with: value.render())
                items[i] = TOMLDocument.reparse(raw, line: item.line) ?? items[i]
                renumber()
                return
            }
        }
        // 2. Nouvelle clé : après la dernière paire clé/valeur de la table, sinon juste après son en-tête.
        let newLine = key.map(TOMLValue.renderKey).joined(separator: ".") + " = " + value.render() + "\n"
        let newItem = TOMLDocument.reparse(newLine, line: 0)!
        var insertAt: Int?
        var headerIndex: Int?
        for (i, item) in items.enumerated() where secs[i] == target {
            switch item.kind {
            case .table, .arrayTable: headerIndex = i
            case .keyValue: insertAt = i + 1
            default: break
            }
        }
        if target.path.isEmpty && headerIndex == nil && insertAt == nil {
            // Racine vide : avant le premier en-tête.
            let firstHeader = items.firstIndex { if case .table = $0.kind { true } else if case .arrayTable = $0.kind { true } else { false } }
            insertAt = firstHeader.map { idx in
                // Garder une ligne vide avant l'en-tête si elle existe.
                idx > 0 && items[idx - 1].kind == .trivia ? idx - 1 : idx
            } ?? items.count
        }
        if let at = insertAt ?? headerIndex.map({ $0 + 1 }) {
            items.insert(newItem, at: at)
        } else {
            // La table n'existe pas : on l'ajoute à la fin.
            ensureTrailingNewline()
            if !items.isEmpty { items.append(TOMLDocument.reparse("\n", line: 0)!) }
            let header = "[" + section.map(TOMLValue.renderKey).joined(separator: ".") + "]\n"
            items.append(TOMLDocument.reparse(header, line: 0)!)
            items.append(newItem)
        }
        renumber()
    }

    /// Supprime une clé si elle existe.
    public mutating func remove(section: [String] = [], arrayIndex: Int? = nil, key: [String]) {
        let target = Section(path: section, arrayIndex: arrayIndex)
        let secs = sections()
        if let i = items.indices.first(where: {
            if case let .keyValue(k) = items[$0].kind { k == key && secs[$0] == target } else { false }
        }) {
            items.remove(at: i)
            renumber()
        }
    }

    /// Nombre d'éléments d'un tableau de tables.
    public func arrayTableCount(_ path: [String]) -> Int {
        items.filter { $0.kind == .arrayTable(path) }.count
    }

    /// Ajoute un élément `[[path]]` après le dernier existant (ou à la fin) et renvoie son index.
    @discardableResult
    public mutating func appendArrayTable(_ path: [String], values: [(String, TOMLValue)]) -> Int {
        let index = arrayTableCount(path)
        var block = "[[" + path.map(TOMLValue.renderKey).joined(separator: ".") + "]]\n"
        for (k, v) in values { block += "\(TOMLValue.renderKey(k)) = \(v.render())\n" }
        var parser = Parser(text: block)
        let newItems = (try? parser.parseAll()) ?? []
        let secs = sections()
        if let last = secs.indices.last(where: { secs[$0].path == path && secs[$0].arrayIndex != nil }) {
            // Fin du dernier bloc : après sa dernière ligne non vide.
            var at = last + 1
            while at - 1 > 0, items[at - 1].kind == .trivia, secs[at - 1].path == path { at -= 1 }
            let sep = TOMLDocument.reparse("\n", line: 0)!
            items.insert(contentsOf: [sep] + newItems, at: at)
        } else {
            ensureTrailingNewline()
            if !items.isEmpty { items.append(TOMLDocument.reparse("\n", line: 0)!) }
            items.append(contentsOf: newItems)
        }
        renumber()
        return index
    }

    /// Supprime l'élément `index` d'un tableau de tables (en-tête et ses lignes, jusqu'à l'en-tête suivant).
    public mutating func removeArrayTable(_ path: [String], index: Int) {
        let secs = sections()
        let target = Section(path: path, arrayIndex: index)
        let idx = items.indices.filter { secs[$0] == target }
        guard let first = idx.first, var last = idx.last else { return }
        // Garder les commentaires/vides qui précèdent l'en-tête suivant.
        while last > first, items[last].kind == .trivia { last -= 1 }
        items.removeSubrange(first...last)
        if first > 0, first < items.count, items[first - 1].kind == .trivia, items[first].kind == .trivia,
           items[first].raw.trimmingCharacters(in: .whitespaces) == "\n" {
            items.remove(at: first)
        }
        renumber()
    }

    /// Supprime une table et tout ce qu'elle contient : en-têtes `[path]` et `[path.x]` avec leurs lignes,
    /// et clés pointées (`x.y = …` sous une table parente). Les commentaires qui précèdent l'en-tête suivant restent.
    public mutating func removeTable(_ path: [String]) {
        func under(_ p: [String]) -> Bool { p.count >= path.count && Array(p.prefix(path.count)) == path }
        let secs = sections()
        var drop = IndexSet()
        var i = 0
        while i < items.count {
            let header: [String]? = switch items[i].kind {
            case let .table(p), let .arrayTable(p): p
            default: nil
            }
            if let header, under(header) {
                // Bloc de l'en-tête : jusqu'à l'en-tête suivant, sans les lignes vides et commentaires de fin.
                var end = i + 1
                while end < items.count, secs[end] == secs[i] { end += 1 }
                var last = end - 1
                while last > i, items[last].kind == .trivia { last -= 1 }
                drop.insert(integersIn: i...last)
                i = end
                continue
            }
            if case let .keyValue(k) = items[i].kind, secs[i].arrayIndex == nil, under(secs[i].path + k) { drop.insert(i) }
            i += 1
        }
        guard !drop.isEmpty else { return }
        for r in drop.rangeView.reversed() {
            items.removeSubrange(r)
            // Pas deux lignes vides de suite à la jonction.
            let at = r.lowerBound
            if at > 0, at < items.count, items[at - 1].raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               items[at].raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                items.remove(at: at)
            }
        }
        renumber()
    }

    private mutating func ensureTrailingNewline() {
        // En scalaires : « \r\n » ne se termine pas par le graphème "\n".
        if let last = items.indices.last, items[last].raw.unicodeScalars.last != "\n" { items[last].raw += "\n" }
    }

    private mutating func renumber() {
        var line = 1
        for i in items.indices {
            items[i].line = line
            line += items[i].raw.unicodeScalars.filter { $0 == "\n" }.count
        }
    }

    static func reparse(_ raw: String, line: Int) -> Item? {
        var p = Parser(text: raw)
        guard var item = (try? p.parseAll())?.first else { return nil }
        item.line = line
        return item
    }
}

/// Arbre de lecture.
public struct TOMLTable: Sendable, Equatable {
    public enum Entry: Sendable, Equatable {
        case value(TOMLValue, line: Int)
        case table(TOMLTable)
        case arrayOfTables([TOMLTable])
    }

    public private(set) var keys: [String] = []
    public private(set) var entries: [String: Entry] = [:]
    public internal(set) var line: Int = 0

    public subscript(_ key: String) -> Entry? { entries[key] }

    public func value(_ key: String) -> TOMLValue? {
        if case let .value(v, _) = entries[key] { v } else { nil }
    }

    public func valueLine(_ key: String) -> Int? {
        if case let .value(_, l) = entries[key] { l } else { nil }
    }

    public func table(_ key: String) -> TOMLTable? {
        if case let .table(t) = entries[key] { t } else { nil }
    }

    public func tables(_ key: String) -> [TOMLTable] {
        if case let .arrayOfTables(a) = entries[key] { a } else { [] }
    }

    mutating func set(_ key: String, _ e: Entry) {
        if entries[key] == nil { keys.append(key) }
        entries[key] = e
    }

    mutating func ensureTable(_ path: [String], line: Int) throws {
        guard let head = path.first else { return }
        let rest = Array(path.dropFirst())
        switch entries[head] {
        case nil:
            var t = TOMLTable()
            t.line = line
            try t.ensureTable(rest, line: line)
            set(head, .table(t))
        case var .table(t)?:
            try t.ensureTable(rest, line: line)
            set(head, .table(t))
        case var .arrayOfTables(a)?:
            guard !rest.isEmpty, var last = a.popLast() else { throw TOMLError(line: line, message: L10n.tr("toml.table_defined", head)) }
            try last.ensureTable(rest, line: line)
            a.append(last)
            set(head, .arrayOfTables(a))
        case .value?:
            throw TOMLError(line: line, message: L10n.tr("toml.already_value", head))
        }
    }

    mutating func appendArrayTable(_ path: [String], line: Int) throws {
        guard let head = path.first else { return }
        let rest = Array(path.dropFirst())
        if rest.isEmpty {
            var t = TOMLTable()
            t.line = line
            switch entries[head] {
            case nil: set(head, .arrayOfTables([t]))
            case var .arrayOfTables(a)?: a.append(t); set(head, .arrayOfTables(a))
            default: throw TOMLError(line: line, message: L10n.tr("toml.not_array_table", head))
            }
            return
        }
        switch entries[head] {
        case nil:
            var t = TOMLTable()
            try t.appendArrayTable(rest, line: line)
            set(head, .table(t))
        case var .table(t)?:
            try t.appendArrayTable(rest, line: line)
            set(head, .table(t))
        case var .arrayOfTables(a)?:
            guard var last = a.popLast() else { return }
            try last.appendArrayTable(rest, line: line)
            a.append(last)
            set(head, .arrayOfTables(a))
        case .value?:
            throw TOMLError(line: line, message: L10n.tr("toml.already_value", head))
        }
    }

    /// Insère une valeur dans la section donnée (dernier élément pour un tableau de tables).
    mutating func insert(value: TOMLValue, section: TOMLDocument.Section, key: [String], line: Int) throws {
        try insert(value: value, path: section.path, key: key, line: line)
    }

    private mutating func insert(value: TOMLValue, path: [String], key: [String], line: Int) throws {
        if let head = path.first {
            let rest = Array(path.dropFirst())
            switch entries[head] {
            case var .table(t)?:
                try t.insert(value: value, path: rest, key: key, line: line); set(head, .table(t))
            case var .arrayOfTables(a)?:
                guard var last = a.popLast() else { return }
                try last.insert(value: value, path: rest, key: key, line: line)
                a.append(last); set(head, .arrayOfTables(a))
            default:
                var t = TOMLTable()
                try t.insert(value: value, path: rest, key: key, line: line); set(head, .table(t))
            }
            return
        }
        guard let k = key.first else { return }
        if key.count == 1 {
            if entries[k] != nil { throw TOMLError(line: line, message: L10n.tr("toml.duplicate_key", k)) }
            set(k, .value(value, line: line))
        } else {
            var t = table(k) ?? TOMLTable()
            if entries[k] != nil, table(k) == nil { throw TOMLError(line: line, message: L10n.tr("toml.already_value", k)) }
            try t.insert(value: value, path: [], key: Array(key.dropFirst()), line: line)
            set(k, .table(t))
        }
    }
}

// MARK: - Analyseur

struct Parser {
    let chars: [Character]
    var pos = 0
    var line = 1

    /// Un caractère par scalaire Unicode : en `Character`, « \r\n » ne forme qu'un seul graphème et ne serait égal
    /// ni à "\r" ni à "\n" (fichier CRLF illisible, ou commentaire qui avalerait la suite du fichier).
    init(text: String) { chars = text.unicodeScalars.map(Character.init) }


    mutating func parseAll() throws -> [TOMLDocument.Item] {
        var items: [TOMLDocument.Item] = []
        while pos < chars.count {
            let startPos = pos
            let startLine = line
            skipInlineSpaces()
            var kind: TOMLDocument.Kind = .trivia
            var value: TOMLValue?
            var valueStart = 0, valueEnd = 0
            if pos >= chars.count || chars[pos] == "\n" || chars[pos] == "#" || chars[pos] == "\r" {
                kind = .trivia
            } else if chars[pos] == "[" {
                if peek(1) == "[" {
                    pos += 2
                    let path = try parseKey()
                    skipInlineSpaces()
                    try expectChars("]]")
                    kind = .arrayTable(path)
                } else {
                    pos += 1
                    let path = try parseKey()
                    skipInlineSpaces()
                    try expectChars("]")
                    kind = .table(path)
                }
            } else {
                let key = try parseKey()
                skipInlineSpaces()
                try expectChars("=")
                skipInlineSpaces()
                valueStart = pos
                value = try parseValue()
                valueEnd = pos
                kind = .keyValue(key)
            }
            // Fin de ligne : espaces, commentaire, saut de ligne.
            skipInlineSpaces()
            if pos < chars.count && chars[pos] == "#" {
                while pos < chars.count && chars[pos] != "\n" { pos += 1 }
            }
            if pos < chars.count && chars[pos] == "\r" { pos += 1 }
            if pos < chars.count {
                guard chars[pos] == "\n" else { throw TOMLError(line: line, message: L10n.tr("toml.unexpected_char", String(chars[pos]))) }
                pos += 1
                line += 1
            }
            let raw = String(chars[startPos..<pos])
            var range: Range<String.Index>?
            if value != nil {
                // Positions comptées en scalaires (voir `init`).
                let scalars = raw.unicodeScalars
                let lo = scalars.index(scalars.startIndex, offsetBy: valueStart - startPos)
                let hi = scalars.index(scalars.startIndex, offsetBy: valueEnd - startPos)
                range = lo..<hi
            }
            items.append(TOMLDocument.Item(kind: kind, raw: raw, line: startLine, value: value, valueRange: range))
        }
        return items
    }

    func peek(_ offset: Int) -> Character? {
        pos + offset < chars.count ? chars[pos + offset] : nil
    }

    mutating func skipInlineSpaces() {
        while pos < chars.count && (chars[pos] == " " || chars[pos] == "\t") { pos += 1 }
    }

    /// Espaces, sauts de ligne et commentaires (dans les tableaux).
    mutating func skipSpacesAndComments() {
        while pos < chars.count {
            let c = chars[pos]
            if c == " " || c == "\t" || c == "\r" { pos += 1 }
            else if c == "\n" { pos += 1; line += 1 }
            else if c == "#" { while pos < chars.count && chars[pos] != "\n" { pos += 1 } }
            else { break }
        }
    }

    mutating func expectChars(_ s: String) throws {
        for ch in s {
            guard pos < chars.count, chars[pos] == ch else { throw TOMLError(line: line, message: L10n.tr("toml.expected", s)) }
            pos += 1
        }
    }

    mutating func parseKey() throws -> [String] {
        var parts: [String] = []
        while true {
            skipInlineSpaces()
            guard pos < chars.count else { throw TOMLError(line: line, message: L10n.tr("toml.key_expected")) }
            let c = chars[pos]
            if c == "\"" { parts.append(try parseBasicString()) }
            else if c == "'" { parts.append(try parseLiteralString()) }
            else {
                var s = ""
                while pos < chars.count, chars[pos].isLetter && chars[pos].isASCII || chars[pos].isNumber && chars[pos].isASCII
                        || chars[pos] == "_" || chars[pos] == "-" {
                    s.append(chars[pos]); pos += 1
                }
                if s.isEmpty { throw TOMLError(line: line, message: L10n.tr("toml.invalid_key")) }
                parts.append(s)
            }
            skipInlineSpaces()
            if pos < chars.count && chars[pos] == "." { pos += 1; continue }
            return parts
        }
    }

    mutating func parseValue() throws -> TOMLValue {
        guard pos < chars.count else { throw TOMLError(line: line, message: L10n.tr("toml.value_expected")) }
        let c = chars[pos]
        switch c {
        case "\"":
            if peek(1) == "\"" && peek(2) == "\"" { throw TOMLError(line: line, message: L10n.tr("toml.multiline")) }
            return .string(try parseBasicString())
        case "'":
            if peek(1) == "'" && peek(2) == "'" { throw TOMLError(line: line, message: L10n.tr("toml.multiline")) }
            return .string(try parseLiteralString())
        case "[":
            pos += 1
            var values: [TOMLValue] = []
            while true {
                skipSpacesAndComments()
                guard pos < chars.count else { throw TOMLError(line: line, message: L10n.tr("toml.array_unclosed")) }
                if chars[pos] == "]" { pos += 1; return .array(values) }
                values.append(try parseValue())
                skipSpacesAndComments()
                guard pos < chars.count else { throw TOMLError(line: line, message: L10n.tr("toml.array_unclosed")) }
                if chars[pos] == "," { pos += 1; continue }
                if chars[pos] == "]" { pos += 1; return .array(values) }
                throw TOMLError(line: line, message: L10n.tr("toml.array_separator"))
            }
        case "{":
            pos += 1
            var pairs: [(String, TOMLValue)] = []
            skipInlineSpaces()
            if pos < chars.count && chars[pos] == "}" { pos += 1; return .inlineTable([]) }
            while true {
                let key = try parseKey()
                guard key.count == 1 else { throw TOMLError(line: line, message: L10n.tr("toml.inline_dotted")) }
                skipInlineSpaces()
                try expectChars("=")
                skipInlineSpaces()
                let v = try parseValue()
                if pairs.contains(where: { $0.0 == key[0] }) { throw TOMLError(line: line, message: L10n.tr("toml.duplicate_key", key[0])) }
                pairs.append((key[0], v))
                skipInlineSpaces()
                guard pos < chars.count else { throw TOMLError(line: line, message: L10n.tr("toml.inline_unclosed")) }
                if chars[pos] == "," { pos += 1; skipInlineSpaces(); continue }
                if chars[pos] == "}" { pos += 1; return .inlineTable(pairs) }
                throw TOMLError(line: line, message: L10n.tr("toml.inline_separator"))
            }
        case "t":
            try expectChars("true"); return .bool(true)
        case "f":
            try expectChars("false"); return .bool(false)
        default:
            return try parseNumber()
        }
    }

    mutating func parseNumber() throws -> TOMLValue {
        var s = ""
        while pos < chars.count, let c = Optional(chars[pos]),
              c.isNumber || c == "+" || c == "-" || c == "_" || c == "." || c == "e" || c == "E" || c == ":" || c == "T" || c == "Z" {
            s.append(c); pos += 1
        }
        if s.isEmpty { throw TOMLError(line: line, message: L10n.tr("toml.invalid_value")) }
        // Dates et heures (1979-05-27, 07:32:00) : non prises en charge.
        if s.contains(":") || s.range(of: #"^\d{4}-\d{2}"#, options: .regularExpression) != nil {
            throw TOMLError(line: line, message: L10n.tr("toml.dates"))
        }
        let clean = s.replacingOccurrences(of: "_", with: "")
        if clean.contains(".") || clean.lowercased().contains("e") {
            guard let d = Double(clean) else { throw TOMLError(line: line, message: L10n.tr("toml.invalid_number", s)) }
            return .double(d)
        }
        guard let i = Int64(clean) else { throw TOMLError(line: line, message: L10n.tr("toml.invalid_number", s)) }
        return .integer(i)
    }

    mutating func parseBasicString() throws -> String {
        pos += 1
        var out = ""
        while pos < chars.count {
            let c = chars[pos]
            if c == "\"" { pos += 1; return out }
            if c == "\n" { break }
            if c == "\\" {
                guard let n = peek(1) else { break }
                pos += 2
                switch n {
                case "n": out.append("\n")
                case "t": out.append("\t")
                case "r": out.append("\r")
                case "\"": out.append("\"")
                case "\\": out.append("\\")
                case "b": out.append("\u{08}")
                case "f": out.append("\u{0C}")
                case "u", "U":
                    let len = n == "u" ? 4 : 8
                    guard pos + len <= chars.count, let code = UInt32(String(chars[pos..<pos + len]), radix: 16),
                          let scalar = Unicode.Scalar(code) else { throw TOMLError(line: line, message: L10n.tr("toml.unicode_escape")) }
                    out.unicodeScalars.append(scalar)
                    pos += len
                default: throw TOMLError(line: line, message: L10n.tr("toml.escape", "\\" + String(n)))
                }
                continue
            }
            out.append(c)
            pos += 1
        }
        throw TOMLError(line: line, message: L10n.tr("toml.string_unclosed"))
    }

    mutating func parseLiteralString() throws -> String {
        pos += 1
        var out = ""
        while pos < chars.count {
            let c = chars[pos]
            if c == "'" { pos += 1; return out }
            if c == "\n" { break }
            out.append(c)
            pos += 1
        }
        throw TOMLError(line: line, message: L10n.tr("toml.string_unclosed"))
    }
}
