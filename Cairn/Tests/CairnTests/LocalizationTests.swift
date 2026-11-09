import CairnCore
import Foundation
import Testing

private func formatSpecifiers(_ s: String) -> [String] {
    let regex = try! NSRegularExpression(pattern: "%(?:\\d+\\$)?(?:lld|ld|d|@|f|\\.\\d+f)")
    let ns = s as NSString
    return regex.matches(in: s, range: NSRange(location: 0, length: ns.length))
        .map { ns.substring(with: $0.range).replacingOccurrences(of: "\\d+\\$", with: "", options: .regularExpression) }
        .sorted()
}

extension CairnTests {
    @Suite struct LocalizationTests {
        @Test func catalogs_have_same_keys() throws {
            let en = L10n.table(.enUS), fr = L10n.table(.frFR)
            try #require(!en.isEmpty && !fr.isEmpty, "catalogues introuvables")
            let missingFr = Set(en.keys).subtracting(fr.keys).sorted()
            let missingEn = Set(fr.keys).subtracting(en.keys).sorted()
            #expect(missingFr.isEmpty, "clés absentes en fr-FR : \(missingFr)")
            #expect(missingEn.isEmpty, "clés absentes en en-US : \(missingEn)")
        }

        @Test func catalogs_have_same_format_specifiers() {
            let en = L10n.table(.enUS), fr = L10n.table(.frFR)
            for (k, v) in en {
                guard let f = fr[k] else { continue }
                #expect(formatSpecifiers(v) == formatSpecifiers(f), "format différent pour \(k)")
            }
        }

        @Test func no_untranslated_ui_strings() throws {
            // Toute chaîne visible doit passer par T(…) / L10n.tr(…).
            let patterns = ["Text(\"", "Button(\"", "Label(\"", "TableColumn(\"", ".help(\"", "ProgressView(\"",
                            "TextField(\"", "Picker(\"", ".navigationTitle(\"", "Toggle(\"", "Section(\"",
                            "out(\"", "err(\"", ".alert(\"", "confirmationDialog(\""]
            let letters = CharacterSet.letters
            var offenders: [String] = []
            for dir in ["Sources/Cairn", "Sources/CairnCore"] {
                let url = packageRoot.appendingPathComponent(dir)
                let files = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
                // Garde-fou : un packageRoot faux ferait passer le test sans rien lire.
                try #require(files.contains { $0.hasSuffix(".swift") }, "aucune source Swift dans \(url.path)")
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
            #expect(offenders.isEmpty, "chaînes non traduites :\n      \(offenders.joined(separator: "\n      "))")
        }

        @Test func language_follows_system() {
            #expect(AppLanguage.system(preferred: ["de-DE", "en-US"]) == .enUS)
            #expect(AppLanguage.system(preferred: ["fr-CA", "en-US"]) == .frFR)
            #expect(AppLanguage.system(preferred: ["de-DE"]) == .enUS)
            #expect(AppLanguage.parse("fr-FR") == .frFR)
            #expect(AppLanguage.parse("auto") == nil)
        }

        @Test(.globalState) func regional_formats() {
            let saved = L10n.current
            defer { L10n.current = saved }
            L10n.current = .frFR
            #expect(Fmt.bytes(1_234_567_890) == "1,23 Go")
            #expect(L10n.tr("action.cancel") == "Annuler")
            L10n.current = .enUS
            #expect(Fmt.bytes(1_234_567_890) == "1.23 GB")
            #expect(Fmt.bytes(512) == "512 bytes")
            #expect(L10n.tr("action.cancel") == "Cancel")
        }

        @Test func missing_key_falls_back() {
            #expect(L10n.tr("does.not.exist") == "does.not.exist")
        }
    }
}
