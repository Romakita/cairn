import Foundation

/// Langues prises en charge par Cairn.
public enum AppLanguage: String, CaseIterable, Sendable {
    case enUS = "en-US"
    case frFR = "fr-FR"

    /// Dossier `.lproj` du catalogue.
    public var lproj: String { self == .frFR ? "fr" : "en" }
    public var locale: Locale { Locale(identifier: rawValue) }

    /// `auto`, `en-US` ou `fr-FR` (valeur de `config.toml` ou de `--lang`).
    public static func parse(_ value: String?) -> AppLanguage? {
        guard let v = value?.lowercased() else { return nil }
        switch v {
        case "en", "en-us", "en_us": return .enUS
        case "fr", "fr-fr", "fr_fr": return .frFR
        default: return nil
        }
    }

    /// Langue du système : fr-FR si le français est la première langue prise en charge, en-US sinon.
    public static func system(preferred: [String] = Locale.preferredLanguages) -> AppLanguage {
        for code in preferred {
            let lang = code.lowercased()
            if lang.hasPrefix("fr") { return .frFR }
            if lang.hasPrefix("en") { return .enUS }
        }
        return .enUS
    }
}

/// Accès aux textes traduits. Les clés sont des identifiants anglais stables.
public enum L10n {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _current: AppLanguage = .system()
    nonisolated(unsafe) private static var cache: [AppLanguage: [String: String]] = [:]

    /// Langue active.
    public static var current: AppLanguage {
        get { lock.withLock { _current } }
        set { lock.withLock { _current = newValue } }
    }

    public static var locale: Locale { current.locale }

    /// Choisit la langue : valeur explicite (`--lang`, `config.toml`), sinon le système. `auto` = système.
    public static func configure(explicit: String?) {
        current = AppLanguage.parse(explicit) ?? .system()
    }

    /// Table d'une langue, chargée depuis le bundle de ressources.
    public static func table(_ lang: AppLanguage) -> [String: String] {
        lock.lock()
        defer { lock.unlock() }
        if let t = cache[lang] { return t }
        var t: [String: String] = [:]
        if let url = Bundle.module.url(forResource: "Localizable", withExtension: "strings", subdirectory: nil,
                                       localization: lang.lproj),
           let dict = NSDictionary(contentsOf: url) as? [String: String] {
            t = dict
        }
        cache[lang] = t
        return t
    }

    /// Texte traduit ; repli en anglais, puis sur la clé.
    public static func tr(_ key: String, _ args: CVarArg...) -> String {
        tr(key, args: args)
    }

    public static func tr(_ key: String, args: [CVarArg]) -> String {
        let format = table(current)[key] ?? table(.enUS)[key] ?? key
        return args.isEmpty ? format : String(format: format, locale: locale, arguments: args)
    }
}

/// Formats régionaux selon la langue active.
public enum Fmt {
    /// Tailles en unités décimales (comme le Finder) : « 1,23 Go » en français, « 1.23 GB » en anglais.
    public static func bytes(_ b: Int64) -> String {
        let fr = L10n.current == .frFR
        let units = fr ? ["o", "ko", "Mo", "Go", "To", "Po"] : ["bytes", "KB", "MB", "GB", "TB", "PB"]
        if b < 1000 { return "\(max(b, 0)) " + units[0] }
        var v = Double(b)
        var i = 0
        while v >= 1000 && i < units.count - 1 { v /= 1000; i += 1 }
        let maxDigits = i >= 3 ? 2 : (i == 2 ? 1 : 0)
        let n = v.formatted(.number.precision(.fractionLength(0...maxDigits)).locale(L10n.locale))
        return n + " " + units[i]
    }

    public static func percent(_ part: Int64, of total: Int64) -> String {
        guard total > 0 else { return "–" }
        let p = Double(part) / Double(total)
        if p > 0 && p < 0.001 { return "<" + number(0.1, digits: 1) + " %" }
        return p.formatted(.percent.precision(.fractionLength(1)).locale(L10n.locale))
    }

    public static func count(_ n: Int) -> String {
        n.formatted(.number.locale(L10n.locale))
    }

    public static func number(_ v: Double, digits: Int) -> String {
        v.formatted(.number.precision(.fractionLength(digits)).locale(L10n.locale))
    }

    public static func date(_ d: Date) -> String {
        d.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(L10n.locale))
    }

    public static func duration(_ seconds: TimeInterval) -> String {
        number(seconds, digits: 1) + " s"
    }
}
