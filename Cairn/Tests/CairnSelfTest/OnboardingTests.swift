import CairnCore
import Foundation

let onboardingTests: [TestCase] = [
    TestCase("detects_folders_home_and_ai_tools") {
        let home = URL(fileURLWithPath: "/Users/test")
        let existing: Set<String> = ["/Volumes/workspaces", "/Users/test/Projets", "/Users/test/.zshrc", "/Users/test/.ssh",
                                     "/Users/test/.codex", "/Users/test/.claude.json"]
        let d = OnboardingDraft.detect(home: home, legacyRootPath: "/Volumes/workspaces", exists: existing.contains)
        try expectEqual(d.folders.map(\.path), ["/Volumes/workspaces", "/Users/test/Projets"])
        try expectEqual(d.folders.map(\.selected), [true, false])
        try expectEqual(d.home.map(\.path), [".zshrc", ".ssh"])
        try expectEqual(d.ai.filter(\.detected).map(\.id), ["claude-code", "codex"])
    },
    TestCase("make_config_is_valid") {
        var d = OnboardingDraft.detect(home: URL(fileURLWithPath: "/Users/test"),
                                       exists: { ["/tmp", "/Users/test/.codex", "/Users/test/.zshrc"].contains($0) || $0 == "/Volumes/workspaces" })
        d.folders = [.init(path: "/tmp", selected: true), .init(path: "/nope", selected: false)]
        d.destination = .smb(url: "smb://nas.local/backups", username: "romain")
        d.background = true
        let c = d.makeConfig()
        try expectEqual(c.folders.map(\.path), ["/tmp"])
        try expectEqual(c.destinations.first?.keychain, OnboardingDraft.destinationID)
        try expectEqual(c.ai.first?.categories, ["conversations", "config", "memories", "credentials"])
        let (back, issues) = try ConfigDecoder.decode(try TOMLDocument(parsing: ConfigWriter.newDocument(c).render()))
        try expect(!issues.contains { $0.severity == .error }, "\(issues)")
        try expectEqual(back, c)
    },
    TestCase("credentials_only_with_encrypted_destination") {
        var d = OnboardingDraft()
        d.ai = [.init(id: "codex", detected: true, categories: ["conversations", "credentials"])]
        d.destination = .local(path: "/tmp")
        d.encrypted = false
        try expectEqual(d.makeConfig().ai.first?.categories, ["conversations"])
        d.encrypted = true
        try expectEqual(d.makeConfig().ai.first?.categories, ["conversations", "credentials"])
        d.destination = .later
        try expectEqual(d.makeConfig().ai.first?.categories, ["conversations"])
    },
    TestCase("abandon_writes_nothing_and_finish_writes_valid_file") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            let store = ConfigStore(paths: paths)
            _ = OnboardingDraft.detect() // l'assistant ne fait que lire
            try expect(!store.exists, "l'assistant ne doit rien écrire avant la fin")
            var d = OnboardingDraft()
            d.folders = [.init(path: "/tmp", selected: true)]
            try store.save(d.makeConfig())
            let loaded = try store.load()
            try expect(!loaded.hasErrors, "\(loaded.issues)")
            try expectEqual(loaded.config.folders.map(\.path), ["/tmp"])
        }
    },
    TestCase("settings_change_keeps_hand_comment") {
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
            try expect(after.contains("# mon commentaire à moi\n[schedule]"), after)
            try expectEqual(try store.load().config.folders.map(\.path), ["/tmp"])
        }
    },
]
