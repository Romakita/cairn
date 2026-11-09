import CairnCore
import Foundation
import Testing

/// Exécuteur factice qui note les commandes ; `command -v` échoue (rien d'installé), npm échoue.
private final class RecordingRunner: CommandRunner, @unchecked Sendable {
    var commands: [[String]] = []
    let lock = NSLock()
    func run(_ command: [String]) -> (status: Int32, output: Data) {
        lock.withLock { commands.append(command) }
        if command.first == "/bin/sh" { return (1, Data()) }
        if command.contains("npm") { return (1, Data()) }
        return (0, Data())
    }
}

private func put(_ text: String, _ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
}

private func legacyBackup(_ dir: URL) throws -> URL {
    let bk = dir.appendingPathComponent("legacy")
    try writeFile(bk.appendingPathComponent("home/.zshrc"), size: 120)
    try writeFile(bk.appendingPathComponent("home/.ssh/id_ed25519"), size: 400)
    try writeFile(bk.appendingPathComponent("home/.ssh/id_ed25519.pub"), size: 100)
    try writeFile(bk.appendingPathComponent("workspaces/proj/a.txt"), size: 10)
    try writeFile(bk.appendingPathComponent("home/.codex/config.toml"), size: 10)
    try put("date=2026-11-01 10:00:00\nhost=Old Mac\nuser=r\nhome=/Users/old\nworkspace=/Volumes/workspaces\narch=arm64\n",
            bk.appendingPathComponent("manifest/system.txt"))
    try put("tap \"hashicorp/tap\"\nbrew \"gh\"\nbrew \"just\"\n", bk.appendingPathComponent("manifest/Brewfile"))
    try put("@openai/codex\n", bk.appendingPathComponent("manifest/npm-globals.txt"))
    try put("ruff[lsp]|3.12\n", bk.appendingPathComponent("manifest/uv-tools.txt"))
    return bk
}

extension CairnTests {
    @Suite struct RestoreTests {
        @Test func reads_legacy_backup() throws {
            try withTempDir { dir in
                let src = try #require(RestoreSource.open(try legacyBackup(dir)))
                #expect(src.kind == .legacy)
                #expect(src.machine == "Old Mac")
                #expect(src.arch == "arm64")
                #expect(src.folders.map(\.name) == ["workspaces"])
                #expect(src.aiTools == ["codex"])
                let (tools, taps, brewfile) = ToolPlan.read(try #require(src.toolsDir))
                #expect(taps == ["hashicorp/tap"])
                #expect(brewfile != nil)
                #expect(tools.map(\.name) == ["gh", "just", "@openai/codex", "ruff"])
                #expect(tools.last?.details["python"] == "3.12")
                let last = try #require(tools.last)
                #expect(ToolPlan.installCommand(last) == ["uv", "tool", "install", "--force", "--python", "3.12", "ruff[lsp]"])
            }
        }

        @Test func reads_cairn_version() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("ws")
                try writeFile(src.appendingPathComponent("p/a.txt"), size: 10)
                let out = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/ws", source: src.path)],
                                                 root: dir.appendingPathComponent("dest"), retention: .recommended,
                                                 dryRun: false, machine: "m")
                let all = RestoreSource.versions(onDestinationRoot: dir.appendingPathComponent("dest"))
                let version = try #require(out.version)
                try #require(all.map(\.version) == [version])
                let s = RestoreSource.open(all[0].url)
                #expect(s?.kind == .cairn)
                #expect(s?.folders.first?.originalPath == src.path)
                #expect(s?.archMatches == true)
            }
        }

        @Test func copy_keeps_pre_restore_and_fixes_secret_permissions() throws {
            try withTempDir { dir in
                let bk = try legacyBackup(dir)
                let home = dir.appendingPathComponent("home")
                try put("local\n", home.appendingPathComponent(".zshrc"))
                let service = RestoreService(source: try #require(RestoreSource.open(bk)), home: home.path)
                var plan = RestoreService.Plan()
                plan.tools = false
                plan.folders = ["workspaces": dir.appendingPathComponent("ws-target").path]
                let sim = service.run(plan, apply: false)
                #expect(sim.allSatisfy { $0.ok })
                #expect(try String(contentsOf: home.appendingPathComponent(".zshrc"), encoding: .utf8) == "local\n",
                        "simulation : rien d'écrit")
                let res = service.run(plan, apply: true)
                #expect(res.allSatisfy { $0.ok }, "\(res)")
                let fm = FileManager.default
                #expect(try String(contentsOf: home.appendingPathComponent(".zshrc.pre-restore"), encoding: .utf8)
                    == "local\n")
                #expect(try fm.attributesOfItem(atPath: home.appendingPathComponent(".ssh").path)[.posixPermissions]
                    as? Int == 0o700)
                #expect(try fm.attributesOfItem(atPath: home.appendingPathComponent(".ssh/id_ed25519").path)[.posixPermissions]
                    as? Int == 0o600)
                #expect(fm.fileExists(atPath: dir.appendingPathComponent("ws-target/proj/a.txt").path))
            }
        }

        @Test func tools_reinstalled_in_order_and_failure_does_not_stop() throws {
            try withTempDir { dir in
                let runner = RecordingRunner()
                let service = RestoreService(source: try #require(RestoreSource.open(try legacyBackup(dir))), runner: runner,
                                             home: dir.path)
                var plan = RestoreService.Plan()
                plan.home = false
                plan.folders = [:]
                plan.ai = []
                let res = service.run(plan, apply: true, waitForAdmin: { _ in true })
                let installs = runner.commands.filter { $0.first != "/bin/sh" && !($0.first ?? "").hasPrefix("/usr/bin") }
                let order = installs.map { $0.first ?? "" }
                #expect(order == ["brew", "brew", "brew", "mise", "uv"], "\(installs)")
                #expect(res.contains { $0.step == "tool:@openai/codex" && !$0.ok }, "échec npm noté")
                #expect(res.contains { $0.step == "tool:ruff" && $0.ok }, "les suivants sont installés")
            }
        }

        @Test func check_changes_nothing() throws {
            try withTempDir { dir in
                let runner = RecordingRunner()
                let service = RestoreService(source: try #require(RestoreSource.open(try legacyBackup(dir))), runner: runner,
                                             home: dir.path)
                let (present, missing) = service.check()
                #expect(present.count == 0)
                #expect(missing.count == 4)
                #expect(runner.commands.allSatisfy { $0.first == "/bin/sh" }, "seulement des « command -v »")
            }
        }

        @Test func legacy_mise_config_is_read() throws {
            try withTempDir { dir in
                let bk = try legacyBackup(dir)
                try put("[tools]\nnode = \"22\"\npython = [\"3.12\", \"3.11\"]\n\"aqua:cli/cli\" = \"latest\"\n",
                        bk.appendingPathComponent("manifest/mise-config.toml"))
                let (tools, _, _) = ToolPlan.read(bk.appendingPathComponent("manifest"))
                let mise = tools.filter { $0.source == .mise }
                try #require(mise.map(\.name) == ["node", "python", "aqua:cli/cli"])
                #expect(ToolPlan.installCommand(mise[0]) == ["mise", "use", "-g", "node@22"])
                #expect(mise[1].details["requested"] == "3.12")
            }
        }

        @Test func open_ai_tool_is_waited_for_or_skipped() throws {
            try withTempDir { dir in
                let home = dir.appendingPathComponent("home")
                let service = RestoreService(source: try #require(RestoreSource.open(try legacyBackup(dir))), home: home.path)
                service.isRunning = { _ in true }
                var plan = RestoreService.Plan()
                plan.tools = false
                plan.home = false
                plan.ai = ["codex"]
                var asked: [String] = []
                let skipped = service.run(plan, apply: true, waitForQuit: { asked.append($0.id); return false })
                #expect(asked == ["codex"])
                #expect(skipped.contains { $0.step == "ai/codex" && !$0.ok }, "\(skipped)")
                #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent(".codex").path),
                        "rien d'écrit tant que l'outil est ouvert")
                let done = service.run(plan, apply: true, waitForQuit: { _ in true })
                #expect(done.contains { $0.step == "ai" && $0.ok }, "\(done)")
                #expect(FileManager.default.fileExists(atPath: home.appendingPathComponent(".codex/config.toml").path))
            }
        }

        @Test func legacy_home_copy_leaves_ai_data_to_the_merge() throws {
            try withTempDir { dir in
                let home = dir.appendingPathComponent("home")
                let service = RestoreService(source: try #require(RestoreSource.open(try legacyBackup(dir))), home: home.path)
                var plan = RestoreService.Plan()
                plan.tools = false
                plan.ai = []
                let res = service.run(plan, apply: true)
                #expect(res.allSatisfy { $0.ok }, "\(res)")
                #expect(FileManager.default.fileExists(atPath: home.appendingPathComponent(".zshrc").path))
                #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent(".codex").path),
                        "home seulement : pas de données IA")
            }
        }

        @Test func paths_that_cannot_be_rewritten_are_reported() throws {
            try withTempDir { dir in
                let home = dir.appendingPathComponent("home")
                let service = RestoreService(source: try #require(RestoreSource.open(try legacyBackup(dir))), home: home.path)
                service.isRunning = { _ in false }
                var plan = RestoreService.Plan()
                plan.tools = false
                plan.home = false
                plan.ai = ["codex"]
                // Le home d'origine (/Users/old) diffère : les chemins internes de Codex ne sont pas réécrits.
                for apply in [false, true] {
                    let res = service.run(plan, apply: apply)
                    #expect(res.contains { $0.step == "ai:paths" && !$0.detail.isEmpty }, "apply=\(apply) \(res)")
                }
                #expect(AIRestore.notRewritten(tool: "codex", home: "/Users/old", prefixes: [("/Users/old", "/Users/old")])
                    .isEmpty, "rien à signaler si le chemin ne change pas")
            }
        }

        @Test func default_version_is_most_recent_and_prefers_this_mac() {
            typealias V = (machine: String, version: String, url: URL, partial: Bool)
            func v(_ m: String, _ name: String, partial: Bool = false) -> V {
                (m, name, URL(fileURLWithPath: "/d/\(m)/\(name)"), partial)
            }
            // Trié par machine (comme `versions(onDestinationRoot:)`) : la dernière n'est pas la plus récente.
            let all = [v("Alpha", "2026-11-01T120000"), v("Zulu", "2025-01-01T120000")]
            #expect(RestoreSource.defaultVersion(all, machine: "New")?.path == "/d/Alpha/2026-11-01T120000")
            #expect(RestoreSource.defaultVersion(all, machine: "Zulu")?.path == "/d/Zulu/2025-01-01T120000")
            let twice = [v("Alpha", "2026-11-01T120000"), v("Zulu", "2026-11-01T120000")]
            #expect(RestoreSource.version(named: "2026-11-01T120000", in: twice, machine: "Zulu")?.path
                == "/d/Zulu/2026-11-01T120000")
            #expect(RestoreSource.version(named: "absente", in: twice) == nil)
        }

        @Test func tool_names_from_backup_are_not_run_by_the_shell() throws {
            try withTempDir { dir in
                let v = dir.appendingPathComponent("v")
                let marker = dir.appendingPathComponent("pwned")
                try put("{\"parts\": []}", v.appendingPathComponent("manifest.json"))
                try put("[[npm]]\nname = \"evil\"\ncommands = [\"x; touch \(marker.path)\"]\n",
                        v.appendingPathComponent("tools/tools.toml"))
                let service = RestoreService(source: try #require(RestoreSource.open(v)), runner: SystemRunner(), home: dir.path)
                let (_, missing) = service.check()
                #expect(missing == ["evil"])
                #expect(!FileManager.default.fileExists(atPath: marker.path), "le nom n'est pas interprété par le shell")
            }
        }
    }
}
