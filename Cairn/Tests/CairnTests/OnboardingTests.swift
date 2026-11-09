import CairnCore
import Foundation
import Testing

extension CairnTests {
    @Suite struct OnboardingTests {
        @Test func detects_folders_home_and_ai_tools() {
            let home = URL(fileURLWithPath: "/Users/test")
            let existing: Set<String> = ["/Volumes/workspaces", "/Users/test/Projets", "/Users/test/.zshrc",
                                         "/Users/test/.ssh", "/Users/test/.codex", "/Users/test/.claude.json"]
            let d = OnboardingDraft.detect(home: home, legacyRootPath: "/Volumes/workspaces", exists: existing.contains)
            #expect(d.folders.map(\.path) == ["/Volumes/workspaces", "/Users/test/Projets"])
            #expect(d.folders.map(\.selected) == [true, false])
            #expect(d.home.map(\.path) == [".ssh", ".zshrc"])
            #expect(d.ai.filter(\.detected).map(\.id) == ["claude-code", "codex"])
        }

        @Test func home_lists_hidden_folders_sorted() {
            let home = URL(fileURLWithPath: "/Users/test")
            let existing: Set<String> = ["/Users/test/.zshrc", "/Users/test/.ssh", "/Users/test/.aws",
                                         "/Users/test/.config/gh"]
            let hidden = [".ssh", ".aws", ".config", ".oh-my-zsh", ".Trash", ".cache", ".npm", ".claude", ".codex",
                          ".cairn"]
            let d = OnboardingDraft.detect(home: home, exists: existing.contains, hiddenFolders: { _ in hidden })
            // Tri alphabétique sans tenir compte du point ; caches, corbeille, outils IA et Cairn écartés.
            #expect(d.home.map(\.path) == [".aws", ".config", ".config/gh", ".oh-my-zsh", ".ssh", ".zshrc"])
            // Les fichiers connus restent cochés, les autres dossiers cachés sont à cocher.
            #expect(d.home.filter(\.selected).map(\.path) == [".aws", ".config/gh", ".ssh", ".zshrc"])
        }

        @Test func settings_list_every_home_item_sorted() {
            let home = URL(fileURLWithPath: "/Users/test")
            let existing: Set<String> = ["/Users/test/.zshrc", "/Users/test/.gitconfig"]
            let items = OnboardingDraft.homeChoices(include: [".config/mise", ".zshrc"], home: home, exists: existing.contains,
                                                    hiddenFolders: { _ in [".ssh", ".aws", ".cache", ".claude", ".Trash"] },
                                                    visibleFolders: { _ in ["Documents", "bin"] })
            // Éléments sauvegardés, fichiers connus, dossiers cachés et visibles : sans doublon, par ordre alphabétique.
            #expect(items == [".aws", "bin", ".config/mise", "Documents", ".gitconfig", ".ssh", ".zshrc"])
        }

        @Test func make_config_is_valid() throws {
            var d = OnboardingDraft.detect(home: URL(fileURLWithPath: "/Users/test"),
                                           exists: { ["/tmp", "/Users/test/.codex", "/Users/test/.zshrc"].contains($0)
                                               || $0 == "/Volumes/workspaces" })
            d.folders = [.init(path: "/tmp", selected: true), .init(path: "/nope", selected: false)]
            d.destination = .smb(url: "smb://nas.local/backups", username: "romain")
            d.background = true
            let c = d.makeConfig()
            #expect(c.folders.map(\.path) == ["/tmp"])
            // Pas de clé `keychain` : l'entrée du Trousseau se déduit de url + username.
            #expect(c.destinations.first?.keychain == nil)
            #expect(c.destinations.first?.username == "romain")
            #expect(c.ai.first?.categories == ["conversations", "config", "memories", "credentials"])
            let (back, issues) = try ConfigDecoder.decode(try TOMLDocument(parsing: ConfigWriter.newDocument(c).render()))
            #expect(!issues.contains { $0.severity == .error }, "\(issues)")
            #expect(back == c)
        }

        @Test func credentials_only_with_encrypted_destination() {
            var d = OnboardingDraft()
            d.ai = [.init(id: "codex", detected: true, categories: ["conversations", "credentials"])]
            d.destination = .local(path: "/tmp")
            d.encrypted = false
            #expect(d.makeConfig().ai.first?.categories == ["conversations"])
            d.encrypted = true
            #expect(d.makeConfig().ai.first?.categories == ["conversations", "credentials"])
            d.destination = .later
            #expect(d.makeConfig().ai.first?.categories == ["conversations"])
        }

        @Test func abandon_writes_nothing_and_finish_writes_valid_file() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                let store = ConfigStore(paths: paths)
                _ = OnboardingDraft.detect() // l'assistant ne fait que lire
                #expect(!store.exists, "l'assistant ne doit rien écrire avant la fin")
                var d = OnboardingDraft()
                d.folders = [.init(path: "/tmp", selected: true)]
                try store.save(d.makeConfig())
                let loaded = try store.load()
                #expect(!loaded.hasErrors, "\(loaded.issues)")
                #expect(loaded.config.folders.map(\.path) == ["/tmp"])
            }
        }

        @Test func settings_change_keeps_hand_comment() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir)
                let store = ConfigStore(paths: paths)
                try store.save(CairnConfig())
                let text = try String(contentsOf: paths.config, encoding: .utf8)
                    .replacingOccurrences(of: "[schedule]", with: "# mon commentaire à moi\n[schedule]")
                try text.write(to: paths.config, atomically: true, encoding: .utf8)
                var c = try store.load().config
                c.folders.append(.init(path: "/tmp"))
                try store.save(c)
                let after = try String(contentsOf: paths.config, encoding: .utf8)
                #expect(after.contains("# mon commentaire à moi\n[schedule]"), "\(after)")
                #expect(try store.load().config.folders.map(\.path) == ["/tmp"])
            }
        }
    }
}
