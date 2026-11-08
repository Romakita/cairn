import CairnCore
import Foundation

private func decode(_ text: String) throws -> (CairnConfig, [ConfigIssue]) {
    try ConfigDecoder.decode(try TOMLDocument(parsing: text))
}

private func run(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args, out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

let configTests: [TestCase] = [
    TestCase("example_file_is_valid") {
        let store = ConfigStore(fileURL: packageRoot.appendingPathComponent("config.example.toml"))
        let loaded = try store.load()
        try expect(!loaded.hasErrors, "\(loaded.issues)")
        try expect(!loaded.migrated)
        try expectEqual(loaded.config.destinations.first?.retention, .tiered(days: 30, weeks: 48))
        try expectEqual(loaded.config.ai.map(\.id), ["claude-code", "codex"])
        try expectEqual(loaded.config.schedule.frequency, .daily)
    },
    TestCase("defaults") {
        let (c, issues) = try decode("version = 1\n")
        try expect(issues.isEmpty, "\(issues)")
        try expectEqual(c.analysis.bigFileThresholdMB, 50)
        try expectEqual(c.schedule.frequency, .daily)
        try expectEqual(c.schedule.background, false)
        try expectEqual(c.logRetentionDays, 90)
        try expectEqual(c.git.worktreeStaleDays, 30)
    },
    TestCase("unknown_keys_are_warnings_with_line") {
        let (_, issues) = try decode("version = 1\nfoo = 1\n[schedule]\nfrequency = \"weekly\"\nbar = 2\n")
        try expect(!issues.contains { $0.severity == .error }, "\(issues)")
        let foo = issues.first { $0.key == "foo" }
        try expectEqual(foo?.line, 2)
        try expectEqual(issues.first { $0.key == "schedule.bar" }?.line, 5)
    },
    TestCase("type_error_reports_key_and_line") {
        let (_, issues) = try decode("version = 1\n\n[schedule]\nfrequency = 3\n")
        let e = issues.first { $0.severity == .error }
        try expectEqual(e?.key, "schedule.frequency")
        try expectEqual(e?.line, 4)
    },
    TestCase("invalid_values_are_errors") {
        let text = """
        version = 1
        language = "de-DE"
        [[destinations]]
        id = "nas"
        provider = "smb"
        url = "http://nas"
        retention = { mode = "count", count = 0 }
        [schedule]
        time = "25:00"
        """
        let (_, issues) = try decode(text)
        let keys = Set(issues.filter { $0.severity == .error }.map(\.key))
        try expect(keys.isSuperset(of: ["language", "destinations[0].url", "destinations[0].retention", "schedule.time"]), "\(keys)")
    },
    TestCase("missing_folder_is_unavailable_not_error") {
        let (c, issues) = try decode("version = 1\n[[folders]]\npath = \"/nonexistent-cairn\"\n[[folders]]\npath = \"/tmp\"\n")
        try expect(!issues.contains { $0.severity == .error })
        try expectEqual(issues.filter { $0.severity == .warning }.map(\.key), ["folders[0].path"])
        try expectEqual(c.folders.map(\.isAvailable), [false, true])
    },
    TestCase("writer_roundtrip") {
        var c = CairnConfig()
        c.language = "fr-FR"
        c.folders = [.init(path: "/tmp", exclude: ["*.iso"])]
        c.home.include = [".zshrc", ".ssh"]
        c.ai = [.init(id: "codex", categories: ["conversations", "config"])]
        c.destinations = [.init(id: "nas", provider: .smb, url: "smb://nas.local/b", username: "r", keychain: "nas",
                                retention: .count(12))]
        c.schedule.frequency = .weekly
        c.schedule.background = true
        let (back, issues) = try decode(ConfigWriter.newDocument(c).render())
        try expect(!issues.contains { $0.severity == .error }, "\(issues)")
        try expectEqual(back, c)
    },
    TestCase("writer_keeps_comments_and_unknown_keys") {
        let original = try String(contentsOf: packageRoot.appendingPathComponent("config.example.toml"), encoding: .utf8)
            + "\n[custom]\nmine = \"à moi\"\n"
        var doc = try TOMLDocument(parsing: original)
        var (c, _) = try ConfigDecoder.decode(doc)
        c.folders.append(.init(path: "/tmp", backup: false))
        c.schedule.time = "08:00"
        ConfigWriter.apply(c, to: &doc)
        let out = doc.render()
        try expect(out.contains("# Dossiers suivis : analysés et, si backup = true, sauvegardés."))
        try expect(out.contains("time = \"08:00\""))
        try expect(out.contains("mine = \"à moi\""))
        let (back, _) = try ConfigDecoder.decode(try TOMLDocument(parsing: out))
        try expectEqual(back.folders.map(\.path), ["/Volumes/workspaces", "/tmp"])
    },
    TestCase("migration_v0_keeps_backup") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            try paths.ensure()
            let v0 = "# ancienne configuration\nroot_path = \"/Volumes/workspaces\"\n"
            try v0.write(to: paths.config, atomically: true, encoding: .utf8)
            let loaded = try ConfigStore(paths: paths).load()
            try expect(loaded.migrated)
            try expectEqual(loaded.config.version, 1)
            try expectEqual(loaded.config.folders.map(\.path), ["/Volumes/workspaces"])
            try expectEqual(try String(contentsOf: paths.config.appendingPathExtension("bak"), encoding: .utf8), v0)
            let migrated = try String(contentsOf: paths.config, encoding: .utf8)
            try expect(migrated.contains("version = 1") && !migrated.contains("root_path"), migrated)
            try expect(migrated.contains("# ancienne configuration"))
            let again = try ConfigStore(paths: paths).load()
            try expect(!again.migrated, "deuxième chargement sans migration")
        }
    },
    TestCase("save_creates_private_folder") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            try ConfigStore(paths: paths).save(CairnConfig())
            let perms = try FileManager.default.attributesOfItem(atPath: paths.root.path)[.posixPermissions] as? Int
            try expectEqual(perms, 0o700)
            let reloaded = try ConfigStore(paths: paths).load()
            try expect(!reloaded.hasErrors)
        }
    },
    TestCase("watcher_detects_manual_edit") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir)
            let store = ConfigStore(paths: paths)
            try store.save(CairnConfig())
            let sem = DispatchSemaphore(value: 0)
            let queue = DispatchQueue(label: "watch")
            let watcher = store.watch(queue: queue) { sem.signal() }
            defer { watcher.cancel() }
            Thread.sleep(forTimeInterval: 1.1) // horodatage différent
            var text = try String(contentsOf: paths.config, encoding: .utf8)
            text = text.replacingOccurrences(of: "time = \"12:30\"", with: "time = \"09:15\"")
            try text.write(to: paths.config, atomically: true, encoding: .utf8)
            try expect(sem.wait(timeout: .now() + 4) == .success, "modification non détectée")
            try expectEqual(try store.load().config.schedule.time, "09:15")
        }
    },
    TestCase("keychain_roundtrip_without_secret_in_file") {
        let service = Keychain.servicePrefix + "selftest-\(UUID().uuidString)"
        defer { Keychain.deletePassword(service: service, account: "test") }
        try Keychain.setPassword("s3cr3t-✓", service: service, account: "test")
        try expectEqual(Keychain.password(service: service, account: "test"), "s3cr3t-✓")
        try Keychain.setPassword("autre", service: service, account: "test")
        try expectEqual(Keychain.password(service: service, account: "test"), "autre")
        Keychain.deletePassword(service: service, account: "test")
        try expectEqual(Keychain.password(service: service, account: "test"), nil)
        var c = CairnConfig()
        c.destinations = [.init(id: "nas", provider: .smb, url: "smb://nas/b", keychain: "nas")]
        try expect(!ConfigWriter.newDocument(c).render().contains("autre"))
    },
    TestCase("cli_config_commands") {
        try withTempDir { dir in
            let file = dir.appendingPathComponent("c.toml")
            let (c0, _, e0) = run(["config", "validate", "--config", file.path, "--lang", "en-US"])
            try expectEqual(c0, .usage)
            try expect(e0.contains("No configuration file"))
            let (c1, out1, _) = run(["config", "show", "--config", file.path])
            try expectEqual(c1, .ok)
            try expect(out1.contains("frequency = \"daily\""))
            try "version = 1\n\n[schedule]\nfrequency = 3\n".write(to: file, atomically: true, encoding: .utf8)
            let (c2, _, e2) = run(["config", "validate", "--config", file.path, "--lang", "en-US"])
            try expectEqual(c2, .usage)
            try expect(e2.contains("line 4") && e2.contains("schedule.frequency"), e2)
            try "version = 1\nlanguage = \"fr-FR\"\n".write(to: file, atomically: true, encoding: .utf8)
            let (c3, out3, _) = run(["config", "validate", "--config", file.path])
            try expectEqual(c3, .ok)
            try expect(out3.contains("Configuration valide"), "la langue de config.toml doit s'appliquer : \(out3)")
            let (c4, out4, _) = run(["config", "path", "--config", file.path])
            try expectEqual(c4, .ok)
            try expectEqual(out4.trimmingCharacters(in: .whitespacesAndNewlines), file.path)
        }
    },
    TestCase("log_retention") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir)
            try paths.ensure()
            let fm = FileManager.default
            let now = Date()
            func log(_ name: String, daysAgo: Double) throws {
                let url = paths.logs.appendingPathComponent(name)
                try "x".write(to: url, atomically: true, encoding: .utf8)
                try fm.setAttributes([.modificationDate: now.addingTimeInterval(-daysAgo * 86_400)], ofItemAtPath: url.path)
            }
            try log("analyze-old.log", daysAgo: 120)
            try log("backup-kept.log", daysAgo: 200)
            try log("analyze-recent.log", daysAgo: 10)
            let removed = LogJanitor.prune(paths: paths, retentionDays: 90, keep: ["backup-kept.log"], now: now)
            try expectEqual(removed, ["analyze-old.log"])
            try expect(fm.fileExists(atPath: paths.logs.appendingPathComponent("backup-kept.log").path))
            try expect(fm.fileExists(atPath: paths.logs.appendingPathComponent("analyze-recent.log").path))
        }
    },
]
