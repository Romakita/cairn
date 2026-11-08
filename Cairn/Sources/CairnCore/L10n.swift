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

    nonisolated(unsafe) private static var pluralCache: [AppLanguage: (keys: Set<String>, bundle: Bundle?)] = [:]

    /// Clés au pluriel (`Localizable.stringsdict`) d'une langue, avec le bundle `.lproj` qui les résout.
    private static func plurals(_ lang: AppLanguage) -> (keys: Set<String>, bundle: Bundle?) {
        lock.lock()
        defer { lock.unlock() }
        if let p = pluralCache[lang] { return p }
        var p: (keys: Set<String>, bundle: Bundle?) = ([], nil)
        if let url = Bundle.module.url(forResource: "Localizable", withExtension: "stringsdict", subdirectory: nil,
                                       localization: lang.lproj),
           let dict = NSDictionary(contentsOf: url) as? [String: Any] {
            p = (Set(dict.keys), Bundle(url: url.deletingLastPathComponent()))
        }
        pluralCache[lang] = p
        return p
    }

    /// Clés définies dans le `.stringsdict` d'une langue (contrôle de parité).
    public static func pluralKeys(_ lang: AppLanguage) -> Set<String> { plurals(lang).keys }

    /// Format d'une clé : `.stringsdict` puis `.strings` de la langue, sinon les mêmes en anglais, sinon la clé.
    /// Le format issu du `.stringsdict` porte ses règles de pluriel, appliquées par `String(format:locale:arguments:)`.
    static func format(_ key: String, _ lang: AppLanguage) -> String? {
        let p = plurals(lang)
        if p.keys.contains(key), let b = p.bundle { return b.localizedString(forKey: key, value: nil, table: nil) }
        return table(lang)[key]
    }

    /// Repli : langue demandée, puis anglais, puis la clé elle-même. `lookup` est remplaçable dans les tests.
    public static func resolve(_ key: String, in lang: AppLanguage, lookup: (String, AppLanguage) -> String?) -> String {
        lookup(key, lang) ?? (lang == .enUS ? nil : lookup(key, .enUS)) ?? key
    }

    /// Texte traduit ; repli en anglais, puis sur la clé.
    public static func tr(_ key: String, _ args: CVarArg...) -> String {
        tr(key, args: args)
    }

    public static func tr(_ key: String, args: [CVarArg]) -> String {
        let f = resolve(key, in: current, lookup: format)
        return args.isEmpty ? f : String(format: f, locale: locale, arguments: args)
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

    /// Durées : « 12,3 s » / « 12.3 s » sous la minute, puis heures, minutes et secondes abrégées selon la langue
    /// (« 2 min 5 s », « 2 min, 5 sec »).
    public static func duration(_ seconds: TimeInterval) -> String {
        guard seconds >= 60 else { return number(max(seconds, 0), digits: 1) + " s" }
        let style = Duration.UnitsFormatStyle(allowedUnits: [.hours, .minutes, .seconds], width: .abbreviated)
            .locale(L10n.locale)
        return Duration.seconds(Int64(seconds.rounded())).formatted(style)
    }
}
