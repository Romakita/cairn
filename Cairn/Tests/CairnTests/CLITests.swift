import CairnCore
import Foundation
import Testing

private func run(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args, out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

extension CairnTests {
    @Suite struct CLITests {
        @Test func detects_command_line_mode() {
            #expect(CLI.isCommandLine(["cairn", "analyze"]))
            #expect(CLI.isCommandLine(["cairn", "--help"]))
            #expect(!CLI.isCommandLine(["cairn"]))
            #expect(!CLI.isCommandLine(["cairn", "-NSDocumentRevisionsDebugMode", "YES"]))
        }

        @Test(.globalState) func help_in_both_languages() {
            let (c1, en, _) = run(["--help", "--lang", "en-US"])
            #expect(c1 == .ok)
            #expect(en.contains("Commands:"), "\(en)")
            let (c2, fr, _) = run(["--lang", "fr-FR", "--help"])
            #expect(c2 == .ok)
            #expect(fr.contains("Commandes :"), "\(fr)")
        }

        @Test(.globalState) func unknown_command_is_usage_error() {
            let (code, _, err) = run(["frobnicate", "--lang", "en-US"])
            #expect(code == .usage)
            #expect(err.contains("Unknown command"))
        }

        @Test(.globalState) func invalid_language_is_usage_error() {
            let (code, _, _) = run(["--lang", "de-DE", "--help"])
            #expect(code == .usage)
        }

        @Test(.globalState) func analyze_json_is_valid() throws {
            try withTempDir { dir in
                try writeFile(dir.appendingPathComponent("a/file.bin"), size: 200_000)
                let (code, out, _) = run(["analyze", dir.path, "--json"])
                #expect(code == .ok)
                let obj = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any]
                let folders = obj?["folders"] as? [[String: Any]]
                #expect(folders?.count == 1)
                #expect(((folders?.first?["size"] as? Int64) ?? 0) >= 200_000)
            }
        }

        @Test(.globalState) func analyze_missing_folder_fails() {
            let (code, _, _) = run(["analyze", "/nonexistent-cairn-test"])
            #expect(code == .failure)
        }

        @Test(.globalState) func version_file_matches_code_and_cli() throws {
            // Cairn/VERSION est la seule source du numéro de version (release, Info.plist, manifests).
            let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().appendingPathComponent("VERSION")
            let v = try String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            #expect(v.range(of: #"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$"#, options: .regularExpression) != nil, "semver : \(v)")
            #expect(CairnVersion.fallback == v, "constante CairnVersion.fallback = Cairn/VERSION")
            var out = ""
            #expect(CLI.run(["cairn", "--version"], out: { out += $0 }, err: { _ in }) == .ok)
            #expect(out.hasPrefix("cairn "), "\(out)")
        }
    }
}
