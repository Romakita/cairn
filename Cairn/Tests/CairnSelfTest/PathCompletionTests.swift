import CairnCore
import Foundation

let pathCompletionTests: [TestCase] = [
    TestCase("suggests_hidden_entries_when_prefix_starts_with_dot") {
        try withTempDir { home in
            try writeFile(home.appendingPathComponent(".zshrc"), size: 1)
            try writeFile(home.appendingPathComponent(".config/starship.toml"), size: 1)
            try writeFile(home.appendingPathComponent("Documents/a.txt"), size: 1)
            let s = PathCompletion.suggestions(for: ".", base: home)
            try expectEqual(s.map(\.path), [".config/", ".zshrc"]) // dossiers d'abord
            try expectEqual(PathCompletion.suggestions(for: "", base: home).map(\.path), ["Documents/"])
        }
    },
    TestCase("completes_inside_subfolders_and_ignores_case") {
        try withTempDir { home in
            try writeFile(home.appendingPathComponent(".config/Starship.toml"), size: 1)
            try writeFile(home.appendingPathComponent(".config/gh/hosts.yml"), size: 1)
            try expectEqual(PathCompletion.suggestions(for: "~/.config/st", base: home).map(\.path), [".config/Starship.toml"])
            try expectEqual(PathCompletion.suggestions(for: ".config/", base: home).map(\.path), [".config/gh/", ".config/Starship.toml"])
        }
    },
    TestCase("excludes_existing_items_and_refuses_escaping_paths") {
        try withTempDir { home in
            try writeFile(home.appendingPathComponent(".zshrc"), size: 1)
            try writeFile(home.appendingPathComponent(".zprofile"), size: 1)
            try expectEqual(PathCompletion.suggestions(for: ".z", base: home, excluding: [".zshrc"]).map(\.path), [".zprofile"])
            try expectEqual(PathCompletion.suggestions(for: "../", base: home), [])
            try expectEqual(PathCompletion.suggestions(for: "/etc/", base: home), [])
            try expectEqual(PathCompletion.suggestions(for: "nope/", base: home), [])
        }
    },
]
