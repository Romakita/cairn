import CairnCore
import Foundation
import Testing

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

extension CairnTests {
    @Suite struct TOMLTests {
        @Test func roundtrip_is_lossless() throws {
            let doc = try TOMLDocument(parsing: sample)
            #expect(doc.render() == sample)
            let withNewline = sample + "\n"
            #expect(try TOMLDocument(parsing: withNewline).render() == withNewline)
        }

        @Test func reads_values() throws {
            let t = try TOMLDocument(parsing: sample).tree()
            #expect(t.value("version")?.integer == 1)
            #expect(t.value("language")?.string == "auto")
            #expect(t.table("analysis")?.value("ratio")?.double == 0.5)
            let folders = t.tables("folders")
            try #require(folders.count == 2)
            #expect(folders[0].value("exclude")?.array == [.string("*.iso"), .string("vidéos")])
            #expect(folders[1].value("path")?.string == "~/Projets")
            let retention = t.table("destinations")?.table("nas")?.value("retention")?.inlineTable
            #expect(retention?.first?.0 == "mode")
            #expect(t.table("ai")?.table("claude-code")?.value("categories")?.array?.count == 2)
            #expect(t.table("analysis")?.valueLine("big_file_threshold_mb") == 6)
        }

        @Test func set_existing_keeps_comments() throws {
            var doc = try TOMLDocument(parsing: sample)
            doc.set(.string("fr-FR"), key: ["language"])
            let out = doc.render()
            #expect(out.contains("language = \"fr-FR\"   # suit macOS"), "\(out)")
            #expect(out.contains("# Configuration de test"))
            #expect(out.contains("unknown_key = \"gardée\""))
            #expect(out.components(separatedBy: "\n").count == sample.components(separatedBy: "\n").count)
        }

        @Test func set_in_array_table_and_add_keys() throws {
            var doc = try TOMLDocument(parsing: sample)
            doc.set(.bool(false), section: ["folders"], arrayIndex: 1, key: ["backup"])
            doc.set(.integer(2), section: ["analysis"], key: ["big_folder_threshold_gb"])
            doc.set(.string("daily"), section: ["schedule"], key: ["frequency"])
            let t = try TOMLDocument(parsing: doc.render()).tree()
            let folders = t.tables("folders")
            try #require(folders.count == 2)
            #expect(folders[1].value("backup")?.bool == false)
            #expect(folders[0].value("backup")?.bool == true)
            #expect(t.table("analysis")?.value("big_folder_threshold_gb")?.integer == 2)
            #expect(t.table("schedule")?.value("frequency")?.string == "daily")
        }

        @Test func append_and_remove_array_table() throws {
            var doc = try TOMLDocument(parsing: sample)
            let i = doc.appendArrayTable(["folders"], values: [("path", .string("/tmp/x")), ("backup", .bool(false))])
            #expect(i == 2)
            var t = try TOMLDocument(parsing: doc.render()).tree()
            #expect(t.tables("folders").map { $0.value("path")?.string } == ["/Volumes/workspaces", "~/Projets", "/tmp/x"])
            doc.removeArrayTable(["folders"], index: 1)
            t = try TOMLDocument(parsing: doc.render()).tree()
            #expect(t.tables("folders").map { $0.value("path")?.string } == ["/Volumes/workspaces", "/tmp/x"])
            #expect(doc.render().contains("# Dossiers suivis"))
        }

        @Test func set_on_empty_document() throws {
            var doc = try TOMLDocument(parsing: "")
            doc.set(.integer(1), key: ["version"])
            doc.set(.string("auto"), key: ["language"])
            doc.set(.integer(50), section: ["analysis"], key: ["big_file_threshold_mb"])
            let t = try TOMLDocument(parsing: doc.render()).tree()
            #expect(t.value("version")?.integer == 1)
            #expect(t.value("language")?.string == "auto")
            #expect(t.table("analysis")?.value("big_file_threshold_mb")?.integer == 50)
        }

        @Test func errors_have_line_numbers() {
            func line(_ text: String) -> Int? {
                do {
                    _ = try TOMLDocument(parsing: text)
                    return nil
                } catch let e as TOMLError { return e.line } catch { return -1 }
            }
            #expect(line("a = 1\nb = 1979-05-27\n") == 2)          // dates non prises en charge
            #expect(line("a = 1\n\nc = \"\"\"multi\"\"\"\n") == 3)  // chaînes multilignes
            #expect(line("a = 1\na = 2\n") == 2)                    // clé en double
            #expect(line("a = \"non fermée\n") == 1)
            #expect(line("[t]\nx = [1, 2\n") == 3)                  // tableau non fermé
        }

        @Test func strings_escaped_on_write() throws {
            var doc = try TOMLDocument(parsing: "")
            doc.set(.string("a \"b\" \\ c\nd"), key: ["s"])
            #expect(try TOMLDocument(parsing: doc.render()).tree().value("s")?.string == "a \"b\" \\ c\nd")
        }

        @Test func crlf_line_endings() throws {
            // « \r\n » est un seul graphème Swift : le commentaire initial ne doit pas avaler tout le fichier.
            var doc = try TOMLDocument(parsing: "# commentaire\r\nversion = 1\r\n\r\n[t]\r\nx = \"a\"   # note\r\n")
            #expect(try doc.tree().value("version") == .integer(1))
            #expect(try doc.tree().table("t")?.value("x")?.string == "a")
            #expect(doc.line(section: ["t"], key: ["x"]) == 5)
            doc.set(.integer(2), key: ["version"])
            #expect(doc.render().hasPrefix("# commentaire\r\nversion = 2\r\n"), "\(doc.render())")
            #expect(try TOMLDocument(parsing: doc.render()).tree().value("version") == .integer(2))
        }
    }
}
