import CairnCore
import Foundation
import Testing

private func decode(_ text: String) throws -> (CairnConfig, [ConfigIssue]) {
    try ConfigDecoder.decode(try TOMLDocument(parsing: text))
}

private func run(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args, out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

extension CairnTests {
    @Suite struct ConfigTests {
        @Test func example_file_is_valid() throws {
            let store = ConfigStore(fileURL: packageRoot.appendingPathComponent("config.example.toml"))
            let loaded = try store.load()
            #expect(!loaded.hasErrors, "\(loaded.issues)")
            #expect(!loaded.migrated)
            #expect(loaded.config.destinations.first?.retention == .tiered(days: 30, weeks: 48))
            #expect(loaded.config.ai.map(\.id) == ["claude-code", "codex"])
            #expect(loaded.config.schedule.frequency == .daily)
        }

        @Test func defaults() throws {
            let (c, issues) = try decode("version = 1\n")
            #expect(issues.isEmpty, "\(issues)")
            #expect(c.analysis.bigFileThresholdMB == 50)
            #expect(c.schedule.frequency == .daily)
            #expect(c.schedule.background == false)
            #expect(c.logRetentionDays == 90)
            #expect(c.git.worktreeStaleDays == 30)
        }

        @Test func unknown_keys_are_warnings_with_line() throws {
            let (_, issues) = try decode("version = 1\nfoo = 1\n[schedule]\nfrequency = \"weekly\"\nbar = 2\n")
            #expect(!issues.contains { $0.severity == .error }, "\(issues)")
            let foo = issues.first { $0.key == "foo" }
            #expect(foo?.line == 2)
            #expect(issues.first { $0.key == "schedule.bar" }?.line == 5)
        }

        @Test func type_error_reports_key_and_line() throws {
            let (_, issues) = try decode("version = 1\n\n[schedule]\nfrequency = 3\n")
            let e = issues.first { $0.severity == .error }
            #expect(e?.key == "schedule.frequency")
            #expect(e?.line == 4)
        }

        @Test func invalid_values_are_errors() throws {
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
            #expect(keys.isSuperset(of: ["language", "destinations[0].url", "destinations[0].retention",
                                         "schedule.time"]), "\(keys)")
        }

        @Test func missing_folder_is_unavailable_not_error() throws {
            let (c, issues) = try decode(
                "version = 1\n[[folders]]\npath = \"/nonexistent-cairn\"\n[[folders]]\npath = \"/tmp\"\n")
            #expect(!issues.contains { $0.severity == .error })
            #expect(issues.filter { $0.severity == .warning }.map(\.key) == ["folders[0].path"])
            #expect(c.folders.map(\.isAvailable) == [false, true])
        }

        @Test func writer_roundtrip() throws {
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
            #expect(!issues.contains { $0.severity == .error }, "\(issues)")
            #expect(back == c)
        }

        @Test func writer_keeps_comments_and_unknown_keys() throws {
            let original = try String(contentsOf: packageRoot.appendingPathComponent("config.example.toml"),
                                      encoding: .utf8)
                + "\n[custom]\nmine = \"à moi\"\n"
            var doc = try TOMLDocument(parsing: original)
            var (c, _) = try ConfigDecoder.decode(doc)
            c.folders.append(.init(path: "/tmp", backup: false))
            c.schedule.time = "08:00"
            ConfigWriter.apply(c, to: &doc)
            let out = doc.render()
            #expect(out.contains("# Dossiers suivis : analysés et, si backup = true, sauvegardés."))
            #expect(out.contains("time = \"08:00\""))
            #expect(out.contains("mine = \"à moi\""))
            let (back, _) = try ConfigDecoder.decode(try TOMLDocument(parsing: out))
            #expect(back.folders.map(\.path) == ["/Volumes/workspaces", "/tmp"])
        }

        @Test func migration_v0_keeps_backup() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                try paths.ensure()
                let v0 = "# ancienne configuration\nroot_path = \"/Volumes/workspaces\"\n"
                try v0.write(to: paths.config, atomically: true, encoding: .utf8)
                let loaded = try ConfigStore(paths: paths).load()
                #expect(loaded.migrated)
                #expect(loaded.config.version == 1)
                #expect(loaded.config.folders.map(\.path) == ["/Volumes/workspaces"])
                #expect(try String(contentsOf: paths.config.appendingPathExtension("bak"), encoding: .utf8) == v0)
                let migrated = try String(contentsOf: paths.config, encoding: .utf8)
                #expect(migrated.contains("version = 1") && !migrated.contains("root_path"), "\(migrated)")
                #expect(migrated.contains("# ancienne configuration"))
                let again = try ConfigStore(paths: paths).load()
                #expect(!again.migrated, "deuxième chargement sans migration")
            }
        }

        @Test func save_creates_private_folder() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                try ConfigStore(paths: paths).save(CairnConfig())
                let perms = try FileManager.default.attributesOfItem(atPath: paths.root.path)[.posixPermissions] as? Int
                #expect(perms == 0o700)
                let reloaded = try ConfigStore(paths: paths).load()
                #expect(!reloaded.hasErrors)
            }
        }

        @Test func watcher_detects_manual_edit() throws {
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
                try #require(sem.wait(timeout: .now() + 4) == .success, "modification non détectée")
                #expect(try store.load().config.schedule.time == "09:15")
            }
        }

        @Test func keychain_roundtrip_without_secret_in_file() throws {
            let service = Keychain.servicePrefix + "selftest-\(UUID().uuidString)"
            defer { Keychain.deletePassword(service: service, account: "test") }
            try Keychain.setPassword("s3cr3t-✓", service: service, account: "test")
            #expect(Keychain.password(service: service, account: "test") == "s3cr3t-✓")
            try Keychain.setPassword("autre", service: service, account: "test")
            #expect(Keychain.password(service: service, account: "test") == "autre")
            Keychain.deletePassword(service: service, account: "test")
            #expect(Keychain.password(service: service, account: "test") == nil)
            var c = CairnConfig()
            c.destinations = [.init(id: "nas", provider: .smb, url: "smb://nas/b", keychain: "nas")]
            #expect(!ConfigWriter.newDocument(c).render().contains("autre"))
        }

        @Test(.globalState) func cli_config_commands() throws {
            try withTempDir { dir in
                let file = dir.appendingPathComponent("c.toml")
                let (c0, _, e0) = run(["config", "validate", "--config", file.path, "--lang", "en-US"])
                #expect(c0 == .usage)
                #expect(e0.contains("No configuration file"))
                let (c1, out1, _) = run(["config", "show", "--config", file.path])
                #expect(c1 == .ok)
                #expect(out1.contains("frequency = \"daily\""))
                try "version = 1\n\n[schedule]\nfrequency = 3\n".write(to: file, atomically: true, encoding: .utf8)
                let (c2, _, e2) = run(["config", "validate", "--config", file.path, "--lang", "en-US"])
                #expect(c2 == .usage)
                #expect(e2.contains("line 4") && e2.contains("schedule.frequency"), "\(e2)")
                try "version = 1\nlanguage = \"fr-FR\"\n".write(to: file, atomically: true, encoding: .utf8)
                let (c3, out3, _) = run(["config", "validate", "--config", file.path])
                #expect(c3 == .ok)
                #expect(out3.contains("Configuration valide"), "la langue de config.toml doit s'appliquer : \(out3)")
                let (c4, out4, _) = run(["config", "path", "--config", file.path])
                #expect(c4 == .ok)
                #expect(out4.trimmingCharacters(in: .whitespacesAndNewlines) == file.path)
            }
        }

        @Test func log_retention() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir)
                try paths.ensure()
                let fm = FileManager.default
                let now = Date()
                func log(_ name: String, daysAgo: Double) throws {
                    let url = paths.logs.appendingPathComponent(name)
                    try "x".write(to: url, atomically: true, encoding: .utf8)
                    try fm.setAttributes([.modificationDate: now.addingTimeInterval(-daysAgo * 86_400)],
                                         ofItemAtPath: url.path)
                }
                try log("analyze-old.log", daysAgo: 120)
                try log("backup-kept.log", daysAgo: 200)
                try log("analyze-recent.log", daysAgo: 10)
                let removed = LogJanitor.prune(paths: paths, retentionDays: 90, keep: ["backup-kept.log"], now: now)
                #expect(removed == ["analyze-old.log"])
                #expect(fm.fileExists(atPath: paths.logs.appendingPathComponent("backup-kept.log").path))
                #expect(fm.fileExists(atPath: paths.logs.appendingPathComponent("analyze-recent.log").path))
            }
        }
    }
}
