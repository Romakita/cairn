import CairnCore
import Foundation

/// Exécuteur factice : `xcode-select -p` échoue si demandé, `command -v` échoue (rien d'installé).
private final class FakeRunner: CommandRunner, @unchecked Sendable {
    var commands: [[String]] = []
    let cltInstalled: Bool
    let lock = NSLock()
    init(cltInstalled: Bool) { self.cltInstalled = cltInstalled }
    func run(_ command: [String]) -> (status: Int32, output: Data) {
        lock.withLock { commands.append(command) }
        if command.first == "/usr/bin/xcode-select" { return (cltInstalled ? 0 : 2, Data()) }
        if command.first == "/bin/sh" { return (1, Data()) }
        return (0, Data())
    }
}

private func put(_ text: String, _ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
}

private func files(in dir: URL) -> [String] {
    (FileManager.default.enumerator(atPath: dir.path)?.allObjects as? [String]) ?? []
}

/// Sauvegarde héritée minimale (scripts/backup.sh) avec des données IA.
private func legacyBackup(_ dir: URL) throws -> URL {
    let bk = dir.appendingPathComponent("legacy")
    try writeFile(bk.appendingPathComponent("home/.zshrc"), size: 100)
    try writeFile(bk.appendingPathComponent("home/.claude/projects/p/s.jsonl"), size: 200_000)
    try writeFile(bk.appendingPathComponent("home/.codex/config.toml"), size: 50_000)
    try writeFile(bk.appendingPathComponent("ai/claude-desktop/Claude/config.json"), size: 30_000)
    try put("date=2026-11-01 10:00:00\nhost=Old Mac\nhome=/Users/old\narch=arm64\n", bk.appendingPathComponent("manifest/system.txt"))
    try put("brew \"gh\"\n", bk.appendingPathComponent("manifest/Brewfile"))
    return bk
}

let restoreWarningTests: [TestCase] = [
    TestCase("profile_added_in_folder_is_listed_and_excluded_from_home") {
        try withTempDir { dir in
            let profiles = dir.appendingPathComponent("profiles")
            try put("""
            {"id":"aider","name":"Aider","version":1,"root":"~/.aider","detect":[".aider", ".aider.conf.yml"],
             "credentials_in_keychain":false,
             "categories":{"conversations":["history/"],"config":["conf.yml"],"memories":[],"credentials":[]},
             "sqlite":[],"exclude":[],"reinstall":[]}
            """, profiles.appendingPathComponent("aider.json"))
            let all = AIProfiles.bundled + AIProfiles.load(from: profiles)
            let home = dir.appendingPathComponent("home")
            try writeFile(home.appendingPathComponent(".aider/history/h.md"), size: 10)
            try writeFile(home.appendingPathComponent(".zshrc"), size: 10)
            let d = OnboardingDraft.detect(home: home, exists: { FileManager.default.fileExists(atPath: $0) }, profiles: all)
            let aider = d.ai.first { $0.id == "aider" }
            try expect(aider?.detected == true, "\(d.ai)")
            try expectEqual(aider?.categories, ["conversations", "config"], "catégories remplies seulement")
            try expect(BackupExclusions.aiManaged(profiles: all).contains(".aider"))
            try expectEqual(BackupExclusions.homeItems([".aider", "~/.aider.conf.yml", ".zshrc"], home: home.path, profiles: all), [".zshrc"])
            try expectEqual(AIProfiles.name(for: "aider", profiles: all), "Aider")
            // Les dossiers gérés par défaut restent ceux des profils fournis.
            for path in [".claude", ".claude.json", ".codex", "Library/Application Support/Claude"] {
                try expect(BackupExclusions.aiManaged.contains(path), path)
            }
            try expectEqual(AIProfiles.name(for: "claude-code"), "Claude Code")
            // Sans nom dans le profil : repli sur la clé de traduction.
            try expectEqual(AIProfiles.name(for: "inconnu", profiles: []), L10n.tr("ai.inconnu"))
        }
    },
    TestCase("onboarding_does_not_preselect_empty_credentials") {
        let d = OnboardingDraft.detect(home: URL(fileURLWithPath: "/Users/test"),
                                       exists: { ["/Users/test/.claude", "/Users/test/.codex"].contains($0) })
        try expect(!(d.ai.first { $0.id == "claude-code" }?.categories.contains("credentials") ?? true), "Trousseau : rien à copier")
        try expect(d.ai.first { $0.id == "codex" }?.categories.contains("credentials") == true)
    },
    TestCase("open_tools_are_reported_for_the_backup_log") {
        try withTempDir { home in
            try writeFile(home.appendingPathComponent(".codex/config.toml"), size: 10)
            try writeFile(home.appendingPathComponent(".claude/settings.json"), size: 10)
            var c = CairnConfig()
            c.ai = [.init(id: "codex", categories: ["config"]), .init(id: "claude-code", categories: ["config"])]
            try expectEqual(AIBackup.openTools(config: c, home: home.path, running: ["codex", "Finder"]), ["codex"])
            let line = AIBackup.openToolsLogLine(config: c, home: home.path, running: ["claude", "Codex"])
            try expect(line?.contains("claude-code") == true && line?.contains("codex") == true, line ?? "nil")
            try expect(AIBackup.openToolsLogLine(config: c, home: home.path, running: []) == nil)
        }
    },
    TestCase("declared_plugins_are_listed_in_profile_json") {
        try withTempDir { dir in
            let home = dir.appendingPathComponent("home")
            try put("""
            {"version":2,"plugins":{"github@official":[{"scope":"user","version":"abc"}],"tsed@tsed":[{"scope":"user","version":"1"}]}}
            """, home.appendingPathComponent(".claude/plugins/installed_plugins.json"))
            try put("""
            {"official":{"source":{"source":"github","repo":"anthropics/claude-plugins-official"}},
             "tsed":{"source":{"source":"git","url":"https://github.com/tsedio/tsed.git"}}}
            """, home.appendingPathComponent(".claude/plugins/known_marketplaces.json"))
            try writeFile(home.appendingPathComponent(".claude/plugins/cache/official/github/abc/x.js"), size: 10)
            try put("""
            model = "x"
            [plugins."github@openai-curated"]
            enabled = true
            [plugins."tsed@tsed"]
            enabled = false
            [marketplaces.tsed]
            source_type = "git"
            source = "https://github.com/tsedio/tsed.git"
            """, home.appendingPathComponent(".codex/config.toml"))
            var c = CairnConfig()
            c.ai = [.init(id: "claude-code", categories: ["config"]), .init(id: "codex", categories: ["config"])]
            let staging = dir.appendingPathComponent("staging")
            _ = try AIBackup.parts(config: c, staging: staging, home: home.path)
            func profile(_ id: String) throws -> [String: Any] {
                try JSONSerialization.jsonObject(with: Data(contentsOf: staging.appendingPathComponent("ai-\(id)/profile.json"))) as? [String: Any] ?? [:]
            }
            func names(_ p: [String: Any], _ key: String) -> [String] {
                ((p["plugins"] as? [String: Any])?[key] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
            }
            let claude = try profile("claude-code")
            try expectEqual(names(claude, "plugins"), ["github@official", "tsed@tsed"])
            try expectEqual(names(claude, "marketplaces"), ["official", "tsed"])
            let src = ((claude["plugins"] as? [String: Any])?["marketplaces"] as? [[String: Any]])?.first?["source"] as? String
            try expectEqual(src, "anthropics/claude-plugins-official")
            try expectEqual((claude["reinstall"] as? [String: [String]])?[".claude/plugins/"], ["cache", "installed_plugins.json", "known_marketplaces.json"],
                            "repli : noms de dossiers")
            let codex = try profile("codex")
            try expectEqual(names(codex, "plugins"), ["github@openai-curated", "tsed@tsed"])
            try expectEqual(names(codex, "marketplaces"), ["tsed"])
            let enabled = ((codex["plugins"] as? [String: Any])?["plugins"] as? [[String: Any]])?.last?["enabled"] as? Bool
            try expectEqual(enabled, false)
        }
    },
    TestCase("claude_plugin_lists_are_copied_but_not_the_cache") {
        try withTempDir { dir in
            let home = dir.appendingPathComponent("home")
            for f in ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"] {
                try put("{}", home.appendingPathComponent(".claude/plugins/" + f))
            }
            try writeFile(home.appendingPathComponent(".claude/plugins/cache/m/p/1/x.js"), size: 100)
            try writeFile(home.appendingPathComponent(".claude/plugins/marketplaces/m/README.md"), size: 100)
            try writeFile(home.appendingPathComponent(".claude/settings.json"), size: 10)
            var c = CairnConfig()
            c.ai = [.init(id: "claude-code", categories: ["config"])]
            let parts = try AIBackup.parts(config: c, staging: dir.appendingPathComponent("staging"), home: home.path)
            let dest = dir.appendingPathComponent("dest")
            let out = try BackupEngine().run(parts: parts, root: dest, retention: .recommended, dryRun: false, machine: "m")
            let v = BackupEngine.versionsDir(root: dest, machine: "m").appendingPathComponent(out.version!)
                .appendingPathComponent("ai/claude-code/config/.claude")
            let fm = FileManager.default
            for f in ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"] {
                try expect(fm.fileExists(atPath: v.appendingPathComponent("plugins/" + f).path), "\(f) copié : \(files(in: v))")
            }
            try expect(fm.fileExists(atPath: v.appendingPathComponent("settings.json").path))
            try expect(!fm.fileExists(atPath: v.appendingPathComponent("plugins/cache").path), "cache copié : \(files(in: v))")
            try expect(!fm.fileExists(atPath: v.appendingPathComponent("plugins/marketplaces").path), "marketplaces copiées : \(files(in: v))")
        }
    },
    TestCase("credentials_only_when_every_destination_is_encrypted") {
        try withTempDir { dir in
            let home = dir.appendingPathComponent("home")
            try writeFile(home.appendingPathComponent(".codex/config.toml"), size: 10)
            try writeFile(home.appendingPathComponent(".codex/auth.json"), size: 10)
            var c = CairnConfig()
            c.ai = [.init(id: "codex", categories: ["config", "credentials"])]
            try expect(!AIBackup.credentialsAllowed(config: c), "aucune destination")
            c.destinations = [.init(id: "a", provider: .local, path: dir.appendingPathComponent("a").path, encrypted: true),
                              .init(id: "b", provider: .local, path: dir.appendingPathComponent("b").path, encrypted: false)]
            try expect(!AIBackup.credentialsAllowed(config: c))
            var targets = try AIBackup.parts(config: c, staging: dir.appendingPathComponent("s1"), home: home.path).map(\.target)
            try expect(!targets.contains("ai/codex/credentials"), "\(targets)")
            c.destinations[1].encrypted = true
            try expect(AIBackup.credentialsAllowed(config: c))
            targets = try AIBackup.parts(config: c, staging: dir.appendingPathComponent("s2"), home: home.path).map(\.target)
            try expect(targets.contains("ai/codex/credentials"), "\(targets)")
        }
    },
    TestCase("saved_size_and_last_backup_date") {
        try withTempDir { dir in
            var stats = AIBackup.stats(AIProfiles.bundled.first { $0.id == "codex" }!, home: dir.path)
            stats.bytesByCategory = ["config": 10, "conversations": 100, "credentials": 1]
            try expectEqual(stats.bytes(of: ["config", "conversations"]), 110)
            let destPath = dir.appendingPathComponent("dest")
            var c = CairnConfig()
            c.destinations = [.init(id: "d", provider: .local, path: destPath.path, encrypted: false)]
            c.ai = [.init(id: "codex", categories: ["config"])]
            let src = dir.appendingPathComponent("src")
            try writeFile(src.appendingPathComponent("config.toml"), size: 10)
            let when = Date(timeIntervalSince1970: 1_790_000_000)
            let out = try BackupEngine().run(parts: [BackupPart(kind: .ai, target: "ai/codex/config", source: src.path)],
                                             root: destPath, retention: .recommended, dryRun: false, machine: "m", now: when)
            try expectEqual(AIBackup.lastBackup(toolID: "codex", config: c, state: RunState(), machine: "m"),
                            BackupEngine.date(ofVersion: out.version!))
            // Pas de version lisible : dernière réussite enregistrée, si l'outil est configuré.
            var state = RunState()
            var ds = RunState.Destination()
            ds.lastSuccess = when
            state.destinations["d"] = ds
            try expect(AIBackup.lastBackup(toolID: "claude-code", config: c, state: state, machine: "m") == nil, "non configuré")
            c.ai.append(.init(id: "claude-code", categories: ["config"]))
            try expectEqual(AIBackup.lastBackup(toolID: "claude-code", config: c, state: state, machine: "m"), when)
        }
    },
    TestCase("missing_target_checks_the_volume_itself") {
        let onlyVolumes = { (p: String) in p == "/Volumes" || p == "/Users/r" }
        try expect(RestoreService.targetIsMissing("/Volumes/workspaces", exists: onlyVolumes))
        try expect(RestoreService.targetIsMissing("/Volumes/workspaces/projets/a", exists: onlyVolumes))
        let mounted = { (p: String) in p == "/Volumes" || p == "/Volumes/workspaces" }
        try expect(!RestoreService.targetIsMissing("/Volumes/workspaces", exists: mounted))
        try expect(!RestoreService.targetIsMissing("/Volumes/workspaces/projets/a", exists: mounted), "le dossier sera créé")
        try expect(!RestoreService.targetIsMissing("/Users/r/ws", exists: onlyVolumes))
        try expect(RestoreService.targetIsMissing("/Users/x/ws", exists: onlyVolumes))
    },
    TestCase("command_line_tools_before_homebrew_and_final_check") {
        try withTempDir { dir in
            let source = RestoreSource.open(try legacyBackup(dir))!
            var plan = RestoreService.Plan()
            plan.home = false
            plan.ai = []
            let runner = FakeRunner(cltInstalled: false)
            var asked: [String] = []
            let res = RestoreService(source: source, runner: runner, home: dir.path)
                .run(plan, apply: true, waitForAdmin: { asked.append($0); return true })
            try expectEqual(asked.first, RestoreService.commandLineToolsInstall)
            try expectEqual(asked.count, 2, "puis Homebrew : \(asked)")
            let steps = res.map(\.step)
            try expect((steps.firstIndex(of: "command-line-tools") ?? 99) < (steps.firstIndex(of: "brew-install") ?? -1), "\(steps)")
            try expectEqual(steps.last, "check", "vérification finale")
            try expect(res.last?.ok == false && res.last?.detail.contains("gh") == true, "gh manquant : \(res.last!)")
            // Simulation : rien n'est lancé, l'étape est annoncée ; installés : étape « present ».
            asked = []
            let sim = RestoreService(source: source, runner: FakeRunner(cltInstalled: false), home: dir.path)
                .run(plan, apply: false, waitForAdmin: { asked.append($0); return true })
            try expect(asked.isEmpty && sim.contains { $0.step == "command-line-tools" && $0.ok }, "\(sim)")
            try expect(!sim.contains { $0.step == "check" }, "pas de vérification en simulation")
            let ok = RestoreService(source: source, runner: FakeRunner(cltInstalled: true), home: dir.path)
                .run(plan, apply: true, waitForAdmin: { asked.append($0); return true })
            try expectEqual(ok.first { $0.step == "command-line-tools" }?.detail, L10n.tr("restore.detail.present"))
            try expect(!asked.contains(RestoreService.commandLineToolsInstall))
            try expect(RestoreService.waitForCommandLineTools(timeout: 1, runner: FakeRunner(cltInstalled: true)))
        }
    },
    TestCase("claude_project_name_replaces_every_non_alphanumeric") {
        try expectEqual(AIRestore.claudeProjectName("/Users/r/my_proj v2.0@x"), "-Users-r-my-proj-v2-0-x")
        try expectEqual(AIRestore.claudeProjectName("/Volumes/workspaces/exports/.claude/worktrees/a"),
                        "-Volumes-workspaces-exports--claude-worktrees-a")
    },
    TestCase("legacy_sizes_measure_the_tool_folders") {
        try withTempDir { dir in
            let service = RestoreService(source: RestoreSource.open(try legacyBackup(dir))!, home: dir.path)
            var plan = RestoreService.Plan()
            plan.ai = ["claude-code", "codex", "claude-desktop"]
            plan.folders = [:]
            let s = service.sizes(plan)
            try expect((s["ai/claude-code"] ?? 0) >= 200_000, "\(s)")
            try expect((s["ai/codex"] ?? 0) >= 50_000 && (s["ai/codex"] ?? 0) < 200_000, "\(s)")
            try expect((s["ai/claude-desktop"] ?? 0) >= 30_000 && (s["ai/claude-desktop"] ?? 0) < 50_000, "\(s)")
            try expect((s["home"] ?? 0) < 50_000, "home sans les dossiers IA : \(s)")
        }
    },
    TestCase("other_arch_is_flagged") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("ws")
            try writeFile(src.appendingPathComponent("a.txt"), size: 10)
            let dest = dir.appendingPathComponent("dest")
            let out = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/ws", source: src.path)],
                                             root: dest, retention: .recommended, dryRun: false, machine: "m")
            let v = BackupEngine.versionsDir(root: dest, machine: "m").appendingPathComponent(out.version!)
            let mURL = v.appendingPathComponent("manifest.json")
            var m = try JSONSerialization.jsonObject(with: Data(contentsOf: mURL)) as! [String: Any]
            m["arch"] = BackupEngine.arch() == "arm64" ? "x86_64" : "arm64"
            try JSONSerialization.data(withJSONObject: m).write(to: mURL)
            try expect(RestoreSource.open(v)?.archMatches == false)
        }
    },
    TestCase("ai_merge_end_to_end_from_a_cairn_version") {
        try withTempDir { dir in
            let home = dir.appendingPathComponent("old-home")
            try writeFile(home.appendingPathComponent(".codex/sessions/2026/11/08/rollout-a.jsonl"), size: 500)
            try writeFile(home.appendingPathComponent(".codex/config.toml"), size: 100)
            try writeFile(home.appendingPathComponent(".codex/auth.json"), size: 100)
            var c = CairnConfig()
            c.ai = [.init(id: "codex", categories: ["conversations", "config"])]
            let parts = try AIBackup.parts(config: c, staging: dir.appendingPathComponent("staging"), home: home.path)
            let dest = dir.appendingPathComponent("dest")
            let out = try BackupEngine().run(parts: parts, root: dest, retention: .recommended, dryRun: false, machine: "m")
            let source = RestoreSource.open(BackupEngine.versionsDir(root: dest, machine: "m").appendingPathComponent(out.version!))!
            try expectEqual(source.aiTools, ["codex"])
            let newHome = dir.appendingPathComponent("new-home")
            try put("local\n", newHome.appendingPathComponent(".codex/history.jsonl"))
            let service = RestoreService(source: source, home: newHome.path)
            service.isRunning = { _ in false }
            var plan = RestoreService.Plan()
            plan.tools = false
            plan.home = false
            plan.ai = ["codex"]
            let sim = service.run(plan, apply: false)
            try expect(sim.contains { $0.step == "ai" && $0.ok }, "\(sim)")
            try expect(!FileManager.default.fileExists(atPath: newHome.appendingPathComponent(".codex/config.toml").path), "simulation")
            let res = service.run(plan, apply: true)
            try expect(res.allSatisfy(\.ok), "\(res)")
            let fm = FileManager.default
            try expect(fm.fileExists(atPath: newHome.appendingPathComponent(".codex/config.toml").path))
            try expect(fm.fileExists(atPath: newHome.appendingPathComponent(".codex/sessions/2026/11/08/rollout-a.jsonl").path))
            try expectEqual(try String(contentsOf: newHome.appendingPathComponent(".codex/history.jsonl"), encoding: .utf8), "local\n",
                            "fichier local gardé")
            try expect(!fm.fileExists(atPath: newHome.appendingPathComponent(".codex/auth.json").path), "identifiants non sauvegardés")
            try expect(!fm.fileExists(atPath: newHome.appendingPathComponent(".codex/profile.json").path), "meta non fusionné")
        }
    },
    TestCase("missing_databases_are_restored_existing_ones_only_on_request") {
        try withTempDir { dir in
            // Version Cairn de Codex avec deux bases : une absente du Mac, une déjà présente (avec son WAL).
            let tool = dir.appendingPathComponent("ai/codex")
            try put("snap-a", tool.appendingPathComponent("meta/sqlite/conversations/state_5.sqlite"))
            try put("snap-b", tool.appendingPathComponent("meta/sqlite/conversations/thread_history_1.sqlite"))
            let home = dir.appendingPathComponent("home")
            let codex = home.appendingPathComponent(".codex")
            try put("local-b", codex.appendingPathComponent("thread_history_1.sqlite"))
            try put("wal-b", codex.appendingPathComponent("thread_history_1.sqlite-wal"))
            let p = AIProfiles.bundled.first { $0.id == "codex" }!
            let r1 = try AIRestore.restore(toolDir: tool, profile: p, home: home.path, replaceDatabases: false)
            try expectEqual(r1.databases, 1)
            try expectEqual(try String(contentsOf: codex.appendingPathComponent("state_5.sqlite"), encoding: .utf8), "snap-a",
                            "base absente : restaurée sans confirmation")
            try expectEqual(try String(contentsOf: codex.appendingPathComponent("thread_history_1.sqlite"), encoding: .utf8), "local-b",
                            "base présente : gardée sans confirmation")
            let r2 = try AIRestore.restore(toolDir: tool, profile: p, home: home.path, replaceDatabases: true)
            try expectEqual(r2.databases, 2)
            try expectEqual(try String(contentsOf: codex.appendingPathComponent("thread_history_1.sqlite"), encoding: .utf8), "snap-b")
            try expectEqual(try String(contentsOf: codex.appendingPathComponent("thread_history_1.sqlite.pre-restore"), encoding: .utf8), "local-b")
            try expectEqual(try String(contentsOf: codex.appendingPathComponent("thread_history_1.sqlite.pre-restore-wal"), encoding: .utf8), "wal-b",
                            "le WAL de l'ancienne base est gardé avec elle")
        }
    },
    TestCase("project_folder_kept_when_merge_fails") {
        try withTempDir { dir in
            let projects = dir.appendingPathComponent("projects")
            // Ancien dossier : « x » est un dossier ; dans le dossier cible existant, « x » est un fichier → la fusion échoue.
            try put("conv", projects.appendingPathComponent("-Users-old-ws/x/conv.jsonl"))
            try put("file", projects.appendingPathComponent("-Users-new-ws/x"))
            var report = AIRestore.Report()
            AIRestore.rewriteClaudeProjects(projects: projects, prefixes: [("/Users/old", "/Users/new")], report: &report)
            try expect(FileManager.default.fileExists(atPath: projects.appendingPathComponent("-Users-old-ws/x/conv.jsonl").path),
                       "rien n'est supprimé si la fusion échoue")
            try expectEqual(report.notRewritten.count, 1)
            try expect(report.renamedProjects.isEmpty)
        }
    },
    TestCase("longest_prefix_wins_for_project_folders") {
        try withTempDir { dir in
            let projects = dir.appendingPathComponent("projects")
            try put("c", projects.appendingPathComponent("-Users-old-ws-app/c.jsonl"))
            try put("c", projects.appendingPathComponent("-Users-old-notes/c.jsonl"))
            var report = AIRestore.Report()
            AIRestore.rewriteClaudeProjects(projects: projects, prefixes: [("/Users/old", "/Users/new"), ("/Users/old/ws", "/Volumes/ws")],
                                            report: &report)
            try expectEqual(report.renamedProjects.sorted(), ["-Users-new-notes", "-Volumes-ws-app"])
        }
    },
    TestCase("cli_restore_tool_option") {
        try withTempDir { dir in
            let bk = try legacyBackup(dir)
            var out = ""
            let ok = CLI.run(["cairn", "restore", "--from", bk.path, "--parts", "ai", "--tool", "codex", "--json"],
                             out: { out += $0 }, err: { _ in })
            try expectEqual(ok, .ok, out)
            let json = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any]
            let steps = json?["steps"] as? [[String: Any]] ?? []
            try expectEqual(steps.first { $0["step"] as? String == "ai" }?["detail"] as? String, "codex", "\(steps)")
            var err = ""
            try expectEqual(CLI.run(["cairn", "restore", "--from", bk.path, "--tool", "aider"], out: { _ in }, err: { err += $0 }), .usage)
            try expect(err.contains("aider"), err)
        }
    },
]
