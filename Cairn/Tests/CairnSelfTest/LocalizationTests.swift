import CairnCore
import Foundation

private func formatSpecifiers(_ s: String) -> [String] {
    let regex = try! NSRegularExpression(pattern: "%(?:\\d+\\$)?(?:lld|ld|d|@|f|\\.\\d+f)")
    let ns = s as NSString
    return regex.matches(in: s, range: NSRange(location: 0, length: ns.length))
        .map { ns.substring(with: $0.range).replacingOccurrences(of: "\\d+\\$", with: "", options: .regularExpression) }
        .sorted()
}

let localizationTests: [TestCase] = [
    TestCase("catalogs_have_same_keys") {
        let en = L10n.table(.enUS), fr = L10n.table(.frFR)
        try expect(!en.isEmpty && !fr.isEmpty, "catalogues introuvables")
        let missingFr = Set(en.keys).subtracting(fr.keys).sorted()
        let missingEn = Set(fr.keys).subtracting(en.keys).sorted()
        try expect(missingFr.isEmpty, "clés absentes en fr-FR : \(missingFr)")
        try expect(missingEn.isEmpty, "clés absentes en en-US : \(missingEn)")
    },
    TestCase("catalogs_have_same_format_specifiers") {
        let en = L10n.table(.enUS), fr = L10n.table(.frFR)
        for (k, v) in en {
            guard let f = fr[k] else { continue }
            try expectEqual(formatSpecifiers(v), formatSpecifiers(f), "format différent pour \(k)")
        }
    },
    TestCase("no_untranslated_ui_strings") {
        // Toute chaîne visible doit passer par T(…) / L10n.tr(…).
        let patterns = ["Text(\"", "Button(\"", "Label(\"", "TableColumn(\"", ".help(\"", "ProgressView(\"",
                        "TextField(\"", "Picker(\"", ".navigationTitle(\"", "Toggle(\"", "Section(\"",
                        "out(\"", "err(\"", ".alert(\"", "confirmationDialog(\""]
        let letters = CharacterSet.letters
        var offenders: [String] = []
        for dir in ["Sources/Cairn", "Sources/CairnCore"] {
            let url = packageRoot.appendingPathComponent(dir)
            let files = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
            for f in files where f.hasSuffix(".swift") {
                let text = try String(contentsOf: url.appendingPathComponent(f), encoding: .utf8)
                for (i, line) in text.components(separatedBy: "\n").enumerated() {
                    for p in patterns {
                        guard let r = line.range(of: p) else { continue }
                        let literal = line[r.upperBound...].prefix { $0 != "\"" }
                        if literal.unicodeScalars.contains(where: { letters.contains($0) }) {
                            offenders.append("\(f):\(i + 1): \(literal)")
                        }
                    }
                }
            }
        }
        try expect(offenders.isEmpty, "chaînes non traduites :\n      " + offenders.joined(separator: "\n      "))
    },
    TestCase("language_follows_system") {
        try expectEqual(AppLanguage.system(preferred: ["de-DE", "en-US"]), .enUS)
        try expectEqual(AppLanguage.system(preferred: ["fr-CA", "en-US"]), .frFR)
        try expectEqual(AppLanguage.system(preferred: ["de-DE"]), .enUS)
        try expectEqual(AppLanguage.parse("fr-FR"), .frFR)
        try expectEqual(AppLanguage.parse("auto"), nil)
    },
    TestCase("regional_formats") {
        let saved = L10n.current
        defer { L10n.current = saved }
        L10n.current = .frFR
        try expectEqual(Fmt.bytes(1_234_567_890), "1,23 Go")
        try expectEqual(L10n.tr("action.cancel"), "Annuler")
        L10n.current = .enUS
        try expectEqual(Fmt.bytes(1_234_567_890), "1.23 GB")
        try expectEqual(Fmt.bytes(512), "512 bytes")
        try expectEqual(L10n.tr("action.cancel"), "Cancel")
    },
    TestCase("missing_key_falls_back") {
        try expectEqual(L10n.tr("does.not.exist"), "does.not.exist")
    },
]
