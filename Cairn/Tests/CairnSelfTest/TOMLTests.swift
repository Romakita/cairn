import CairnCore
import Foundation

private let sample = """
# Configuration de test
version = 1
language = "auto"   # suit macOS

[analysis]
big_file_threshold_mb = 50
ratio = 0.5

# Dossiers suivis
[[folders]]
path = "/Volumes/workspaces"
backup = true
exclude = [
  "*.iso",   # images
  'vidéos',
]

[[folders]]
path = "~/Projets"

[destinations.nas]
retention = { mode = "tiered", days = 30, weeks = 48 }
unknown_key = "gardée"

[ai."claude-code"]
categories = ["conversations", "config"]
"""

let tomlTests: [TestCase] = [
    TestCase("roundtrip_is_lossless") {
        let doc = try TOMLDocument(parsing: sample)
        try expectEqual(doc.render(), sample)
        let withNewline = sample + "\n"
        try expectEqual(try TOMLDocument(parsing: withNewline).render(), withNewline)
    },
    TestCase("reads_values") {
        let t = try TOMLDocument(parsing: sample).tree()
        try expectEqual(t.value("version")?.integer, 1)
        try expectEqual(t.value("language")?.string, "auto")
        try expectEqual(t.table("analysis")?.value("ratio")?.double, 0.5)
        let folders = t.tables("folders")
        try expectEqual(folders.count, 2)
        try expectEqual(folders[0].value("exclude")?.array, [.string("*.iso"), .string("vidéos")])
        try expectEqual(folders[1].value("path")?.string, "~/Projets")
        let retention = t.table("destinations")?.table("nas")?.value("retention")?.inlineTable
        try expectEqual(retention?.first?.0, "mode")
        try expectEqual(t.table("ai")?.table("claude-code")?.value("categories")?.array?.count, 2)
        try expectEqual(t.table("analysis")?.valueLine("big_file_threshold_mb"), 6)
    },
    TestCase("set_existing_keeps_comments") {
        var doc = try TOMLDocument(parsing: sample)
        doc.set(.string("fr-FR"), key: ["language"])
        let out = doc.render()
        try expect(out.contains("language = \"fr-FR\"   # suit macOS"), out)
        try expect(out.contains("# Configuration de test"))
        try expect(out.contains("unknown_key = \"gardée\""))
        try expectEqual(out.components(separatedBy: "\n").count, sample.components(separatedBy: "\n").count)
    },
    TestCase("set_in_array_table_and_add_keys") {
        var doc = try TOMLDocument(parsing: sample)
        doc.set(.bool(false), section: ["folders"], arrayIndex: 1, key: ["backup"])
        doc.set(.integer(2), section: ["analysis"], key: ["big_folder_threshold_gb"])
        doc.set(.string("daily"), section: ["schedule"], key: ["frequency"])
        let t = try TOMLDocument(parsing: doc.render()).tree()
        try expectEqual(t.tables("folders")[1].value("backup")?.bool, false)
        try expectEqual(t.tables("folders")[0].value("backup")?.bool, true)
        try expectEqual(t.table("analysis")?.value("big_folder_threshold_gb")?.integer, 2)
        try expectEqual(t.table("schedule")?.value("frequency")?.string, "daily")
    },
    TestCase("append_and_remove_array_table") {
        var doc = try TOMLDocument(parsing: sample)
        let i = doc.appendArrayTable(["folders"], values: [("path", .string("/tmp/x")), ("backup", .bool(false))])
        try expectEqual(i, 2)
        var t = try TOMLDocument(parsing: doc.render()).tree()
        try expectEqual(t.tables("folders").map { $0.value("path")?.string }, ["/Volumes/workspaces", "~/Projets", "/tmp/x"])
        doc.removeArrayTable(["folders"], index: 1)
        t = try TOMLDocument(parsing: doc.render()).tree()
        try expectEqual(t.tables("folders").map { $0.value("path")?.string }, ["/Volumes/workspaces", "/tmp/x"])
        try expect(doc.render().contains("# Dossiers suivis"))
    },
    TestCase("set_on_empty_document") {
        var doc = try TOMLDocument(parsing: "")
        doc.set(.integer(1), key: ["version"])
        doc.set(.string("auto"), key: ["language"])
        doc.set(.integer(50), section: ["analysis"], key: ["big_file_threshold_mb"])
        let t = try TOMLDocument(parsing: doc.render()).tree()
        try expectEqual(t.value("version")?.integer, 1)
        try expectEqual(t.value("language")?.string, "auto")
        try expectEqual(t.table("analysis")?.value("big_file_threshold_mb")?.integer, 50)
    },
    TestCase("errors_have_line_numbers") {
        func line(_ text: String) -> Int? {
            do { _ = try TOMLDocument(parsing: text); return nil } catch let e as TOMLError { return e.line } catch { return -1 }
        }
        try expectEqual(line("a = 1\nb = 1979-05-27\n"), 2)          // dates non prises en charge
        try expectEqual(line("a = 1\n\nc = \"\"\"multi\"\"\"\n"), 3)  // chaînes multilignes
        try expectEqual(line("a = 1\na = 2\n"), 2)                    // clé en double
        try expectEqual(line("a = \"non fermée\n"), 1)
        try expectEqual(line("[t]\nx = [1, 2\n"), 3)                  // tableau non fermé
    },
    TestCase("strings_escaped_on_write") {
        var doc = try TOMLDocument(parsing: "")
        doc.set(.string("a \"b\" \\ c\nd"), key: ["s"])
        try expectEqual(try TOMLDocument(parsing: doc.render()).tree().value("s")?.string, "a \"b\" \\ c\nd")
    },
    TestCase("crlf_line_endings") {
        // « \r\n » est un seul graphème Swift : le commentaire initial ne doit pas avaler tout le fichier.
        var doc = try TOMLDocument(parsing: "# commentaire\r\nversion = 1\r\n\r\n[t]\r\nx = \"a\"   # note\r\n")
        try expectEqual(try doc.tree().value("version"), .integer(1))
        try expectEqual(try doc.tree().table("t")?.value("x")?.string, "a")
        try expectEqual(doc.line(section: ["t"], key: ["x"]), 5)
        doc.set(.integer(2), key: ["version"])
        try expect(doc.render().hasPrefix("# commentaire\r\nversion = 2\r\n"), doc.render())
        try expectEqual(try TOMLDocument(parsing: doc.render()).tree().value("version"), .integer(2))
    },
]
