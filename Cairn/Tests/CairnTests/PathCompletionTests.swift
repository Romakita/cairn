import CairnCore
import Foundation
import Testing

extension CairnTests {
    @Suite struct PathCompletionTests {
        @Test func suggests_hidden_entries_when_prefix_starts_with_dot() throws {
            try withTempDir { home in
                try writeFile(home.appendingPathComponent(".zshrc"), size: 1)
                try writeFile(home.appendingPathComponent(".config/starship.toml"), size: 1)
                try writeFile(home.appendingPathComponent("Documents/a.txt"), size: 1)
                let s = PathCompletion.suggestions(for: ".", base: home)
                #expect(s.map(\.path) == [".config/", ".zshrc"]) // dossiers d'abord
                #expect(PathCompletion.suggestions(for: "", base: home).map(\.path) == ["Documents/"])
            }
        }

        @Test func completes_inside_subfolders_and_ignores_case() throws {
            try withTempDir { home in
                try writeFile(home.appendingPathComponent(".config/Starship.toml"), size: 1)
                try writeFile(home.appendingPathComponent(".config/gh/hosts.yml"), size: 1)
                #expect(PathCompletion.suggestions(for: "~/.config/st", base: home).map(\.path) == [".config/Starship.toml"])
                #expect(PathCompletion.suggestions(for: ".config/", base: home).map(\.path) == [".config/gh/", ".config/Starship.toml"])
            }
        }

        @Test func excludes_existing_items_and_refuses_escaping_paths() throws {
            try withTempDir { home in
                try writeFile(home.appendingPathComponent(".zshrc"), size: 1)
                try writeFile(home.appendingPathComponent(".zprofile"), size: 1)
                #expect(PathCompletion.suggestions(for: ".z", base: home, excluding: [".zshrc"]).map(\.path) == [".zprofile"])
                #expect(PathCompletion.suggestions(for: "../", base: home) == [])
                #expect(PathCompletion.suggestions(for: "/etc/", base: home) == [])
                #expect(PathCompletion.suggestions(for: "nope/", base: home) == [])
            }
        }
    }
}
