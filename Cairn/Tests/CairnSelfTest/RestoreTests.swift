import CairnCore
import Foundation

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
    try put("date=2026-11-01 10:00:00\nhost=Old Mac\nuser=r\nhome=/Users/old\nworkspace=/Volumes/workspaces\narch=arm64\n", bk.appendingPathComponent("manifest/system.txt"))
    try put("tap \"hashicorp/tap\"\nbrew \"gh\"\nbrew \"just\"\n", bk.appendingPathComponent("manifest/Brewfile"))
    try put("@openai/codex\n", bk.appendingPathComponent("manifest/npm-globals.txt"))
    try put("ruff[lsp]|3.12\n", bk.appendingPathComponent("manifest/uv-tools.txt"))
    return bk
}

let restoreTests: [TestCase] = [
    TestCase("reads_legacy_backup") {
        try withTempDir { dir in
            let src = RestoreSource.open(try legacyBackup(dir))
            try expectEqual(src?.kind, .legacy)
            try expectEqual(src?.machine, "Old Mac")
            try expectEqual(src?.arch, "arm64")
            try expectEqual(src?.folders.map(\.name), ["workspaces"])
            try expectEqual(src?.aiTools, ["codex"])
            let (tools, taps, brewfile) = ToolPlan.read(src!.toolsDir!)
            try expectEqual(taps, ["hashicorp/tap"])
            try expect(brewfile != nil)
            try expectEqual(tools.map(\.name), ["gh", "just", "@openai/codex", "ruff"])
            try expectEqual(tools.last?.details["python"], "3.12")
            try expectEqual(ToolPlan.installCommand(tools.last!), ["uv", "tool", "install", "--force", "--python", "3.12", "ruff[lsp]"])
        }
    },
    TestCase("reads_cairn_version") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("ws")
            try writeFile(src.appendingPathComponent("p/a.txt"), size: 10)
            let out = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/ws", source: src.path)],
                                             root: dir.appendingPathComponent("dest"), retention: .recommended, dryRun: false, machine: "m")
            let all = RestoreSource.versions(onDestinationRoot: dir.appendingPathComponent("dest"))
            try expectEqual(all.map(\.version), [out.version!])
            let s = RestoreSource.open(all[0].url)
            try expectEqual(s?.kind, .cairn)
            try expectEqual(s?.folders.first?.originalPath, src.path)
            try expect(s?.archMatches == true)
        }
    },
    TestCase("copy_keeps_pre_restore_and_fixes_secret_permissions") {
        try withTempDir { dir in
            let bk = try legacyBackup(dir)
            let home = dir.appendingPathComponent("home")
            try put("local\n", home.appendingPathComponent(".zshrc"))
            let service = RestoreService(source: RestoreSource.open(bk)!, home: home.path)
            var plan = RestoreService.Plan()
            plan.tools = false
            plan.folders = ["workspaces": dir.appendingPathComponent("ws-target").path]
            let sim = service.run(plan, apply: false)
            try expect(sim.allSatisfy(\.ok))
            try expectEqual(try String(contentsOf: home.appendingPathComponent(".zshrc"), encoding: .utf8), "local\n", "simulation : rien d'écrit")
            let res = service.run(plan, apply: true)
            try expect(res.allSatisfy(\.ok), "\(res)")
            let fm = FileManager.default
            try expectEqual(try String(contentsOf: home.appendingPathComponent(".zshrc.pre-restore"), encoding: .utf8), "local\n")
            try expectEqual(try fm.attributesOfItem(atPath: home.appendingPathComponent(".ssh").path)[.posixPermissions] as? Int, 0o700)
            try expectEqual(try fm.attributesOfItem(atPath: home.appendingPathComponent(".ssh/id_ed25519").path)[.posixPermissions] as? Int, 0o600)
            try expect(fm.fileExists(atPath: dir.appendingPathComponent("ws-target/proj/a.txt").path))
        }
    },
    TestCase("tools_reinstalled_in_order_and_failure_does_not_stop") {
        try withTempDir { dir in
            let runner = RecordingRunner()
            let service = RestoreService(source: RestoreSource.open(try legacyBackup(dir))!, runner: runner, home: dir.path)
            var plan = RestoreService.Plan()
            plan.home = false
            plan.folders = [:]
            plan.ai = []
            let res = service.run(plan, apply: true, waitForAdmin: { _ in true })
            let installs = runner.commands.filter { $0.first != "/bin/sh" && !($0.first ?? "").hasPrefix("/usr/bin") }
            let order = installs.map { $0.first! }
            try expectEqual(order, ["brew", "brew", "brew", "mise", "uv"], "\(installs)")
            try expect(res.contains { $0.step == "tool:@openai/codex" && !$0.ok }, "échec npm noté")
            try expect(res.contains { $0.step == "tool:ruff" && $0.ok }, "les suivants sont installés")
        }
    },
    TestCase("check_changes_nothing") {
        try withTempDir { dir in
            let runner = RecordingRunner()
            let service = RestoreService(source: RestoreSource.open(try legacyBackup(dir))!, runner: runner, home: dir.path)
            let (present, missing) = service.check()
            try expectEqual(present.count, 0)
            try expectEqual(missing.count, 4)
            try expect(runner.commands.allSatisfy { $0.first == "/bin/sh" }, "seulement des « command -v »")
        }
    },
]
