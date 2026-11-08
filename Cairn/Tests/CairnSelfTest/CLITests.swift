import CairnCore
import Foundation

private func run(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args, out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

let cliTests: [TestCase] = [
    TestCase("detects_command_line_mode") {
        try expect(CLI.isCommandLine(["cairn", "analyze"]))
        try expect(CLI.isCommandLine(["cairn", "--help"]))
        try expect(!CLI.isCommandLine(["cairn"]))
        try expect(!CLI.isCommandLine(["cairn", "-NSDocumentRevisionsDebugMode", "YES"]))
    },
    TestCase("help_in_both_languages") {
        let (c1, en, _) = run(["--help", "--lang", "en-US"])
        try expectEqual(c1, .ok)
        try expect(en.contains("Commands:"), en)
        let (c2, fr, _) = run(["--lang", "fr-FR", "--help"])
        try expectEqual(c2, .ok)
        try expect(fr.contains("Commandes :"), fr)
    },
    TestCase("unknown_command_is_usage_error") {
        let (code, _, err) = run(["frobnicate", "--lang", "en-US"])
        try expectEqual(code, .usage)
        try expect(err.contains("Unknown command"))
    },
    TestCase("invalid_language_is_usage_error") {
        let (code, _, _) = run(["--lang", "de-DE", "--help"])
        try expectEqual(code, .usage)
    },
    TestCase("analyze_json_is_valid") {
        try withTempDir { dir in
            try writeFile(dir.appendingPathComponent("a/file.bin"), size: 200_000)
            let (code, out, _) = run(["analyze", dir.path, "--json"])
            try expectEqual(code, .ok)
            let obj = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any]
            let folders = obj?["folders"] as? [[String: Any]]
            try expectEqual(folders?.count, 1)
            try expect(((folders?.first?["size"] as? Int64) ?? 0) >= 200_000)
        }
    },
    TestCase("analyze_missing_folder_fails") {
        let (code, _, _) = run(["analyze", "/nonexistent-cairn-test"])
        try expectEqual(code, .failure)
    },
]
