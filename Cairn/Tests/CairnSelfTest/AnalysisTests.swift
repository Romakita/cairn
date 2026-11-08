import CairnCore
import Foundation

private func run(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args, out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

/// Taille allouée selon du (Ko → octets).
private func du(_ path: String) throws -> Int64 {
    let (_, out) = try shell("/usr/bin/du", ["-sk", path])
    return (Int64(out.split(separator: "\t").first ?? "0") ?? 0) * 1024
}

let analysisTests: [TestCase] = {
    var t = [
        TestCase("scans_several_folders_and_flags_unavailable") {
            try withTempDir { dir in
                let a = dir.appendingPathComponent("a"), b = dir.appendingPathComponent("b")
                try writeFile(a.appendingPathComponent("x.bin"), size: 400_000)
                try writeFile(b.appendingPathComponent("y.bin"), size: 300_000)
                // Même fichier lié dans les deux dossiers : compté une fois au total.
                try FileManager.default.linkItem(at: a.appendingPathComponent("x.bin"), to: b.appendingPathComponent("x.bin"))
                let scans = Scanner.scanFolders([a.path, b.path, "/nonexistent-cairn"], ctx: ScanContext())
                try expectEqual(scans.map(\.isAvailable), [true, true, false])
                let total = scans.compactMap(\.result).reduce(Int64(0)) { $0 + $1.root.size }
                try expect(total < 900_000, "lien physique compté deux fois : \(total)")
                try expect(total >= 700_000)
                for s in scans.compactMap(\.result) {
                    let ref = try du(s.root.path)
                    try expect(s.root.size <= ref + 8192, "\(s.root.path) : \(s.root.size) > du \(ref)")
                }
            }
        },
        TestCase("big_objects_three_spec_cases") {
            try withTempDir { dir in
                // Gros fichier (seuil 100 ko).
                try writeFile(dir.appendingPathComponent("media/big.iso"), size: 400_000)
                // Beaucoup de petits fichiers : fixtures/ dépasse 1 Mo, aucun de ses sous-dossiers seul.
                for i in 0..<4 { for j in 0..<30 {
                    try writeFile(dir.appendingPathComponent("proj/fixtures/set\(i)/f\(j).json"), size: 9_000)
                } }
                // Dossier qui doit sa taille à un seul gros fichier : seul le fichier est listé.
                try writeFile(dir.appendingPathComponent("dump/data.bin"), size: 1_400_000)
                try writeFile(dir.appendingPathComponent("dump/note.txt"), size: 50_000)
                let r = Scanner.scan(root: dir.path, ctx: ScanContext(bigFileThreshold: 100_000))
                let objects = BigObjects.find(in: r.root, bigFiles: r.bigFiles, folderThreshold: 1_000_000)
                let names = objects.map { "\($0.kind.rawValue):\($0.name)" }
                try expect(names.contains("file:big.iso"), "\(names)")
                try expect(names.contains("file:data.bin"), "\(names)")
                try expect(names.contains("folder:fixtures"), "\(names)")
                try expect(!names.contains("folder:proj") && !names.contains("folder:set0"), "\(names)")
                try expect(!names.contains("folder:dump"), "\(names)")
            }
        },
        TestCase("big_file_threshold_is_configurable") {
            try withTempDir { dir in
                try writeFile(dir.appendingPathComponent("a.bin"), size: 3_000_000)
                let low = Scanner.scan(root: dir.path, ctx: ScanContext(bigFileThreshold: 1_000_000))
                let high = Scanner.scan(root: dir.path, ctx: ScanContext(bigFileThreshold: 50_000_000))
                try expectEqual(low.bigFiles.count, 1)
                try expectEqual(high.bigFiles.count, 0)
            }
        },
        TestCase("projects_with_node_modules_and_worktrees") {
            try withTempDir { dir in
                let repo = dir.appendingPathComponent("client/app")
                try writeFile(repo.appendingPathComponent(".git/HEAD"), size: 100)
                try writeFile(repo.appendingPathComponent("src/main.ts"), size: 200_000)
                try writeFile(repo.appendingPathComponent("node_modules/x/index.js"), size: 600_000)
                // Worktree à l'intérieur du dépôt (agent) et worktree à côté.
                let inner = repo.appendingPathComponent(".claude/worktrees/fix")
                try writeFile(inner.appendingPathComponent("src/main.ts"), size: 150_000)
                try "gitdir: \(repo.path)/.git/worktrees/fix\n".write(to: inner.appendingPathComponent(".git"), atomically: true, encoding: .utf8)
                let outer = dir.appendingPathComponent("client/app-v2")
                try writeFile(outer.appendingPathComponent("src/main.ts"), size: 120_000)
                try "gitdir: \(repo.path)/.git/worktrees/app-v2\n".write(to: outer.appendingPathComponent(".git"), atomically: true, encoding: .utf8)
                try writeFile(dir.appendingPathComponent("lib/package.json"), size: 100)

                let r = Scanner.scan(root: dir.path, ctx: ScanContext())
                let projects = Projects.find(in: r.root)
                try expectEqual(Set(projects.map(\.name)), ["app", "lib"], "les worktrees ne sont pas des projets distincts")
                let app = projects.first { $0.name == "app" }!
                try expect(app.isGitRepo)
                try expect(app.regenerable >= 600_000)
                try expectEqual(app.worktrees.count, 2)
                let outerSize = app.worktrees.first { $0.path.hasSuffix("app-v2") }!.size
                try expectEqual(app.totalSize, app.size + outerSize)
                try expectEqual(Projects.worktreeRepo(inner.path), repo.path)
            }
        },
        TestCase("cancel_stops_within_two_seconds") {
            let target = FileManager.default.fileExists(atPath: "/Volumes/workspaces") ? "/Volumes/workspaces" : NSHomeDirectory()
            let ctx = ScanContext()
            let done = DispatchSemaphore(value: 0)
            Thread.detachNewThread {
                _ = Scanner.scanFolders([target], ctx: ctx)
                done.signal()
            }
            Thread.sleep(forTimeInterval: 1)
            let start = Date()
            ctx.cancel()
            try expect(done.wait(timeout: .now() + 2) == .success, "l'analyse ne s'est pas arrêtée en 2 s")
            try expect(Date().timeIntervalSince(start) < 2)
        },
        TestCase("cli_analyze_uses_config_folders") {
            try withTempDir { dir in
                let data = dir.appendingPathComponent("data")
                try writeFile(data.appendingPathComponent("big.bin"), size: 2_000_000)
                let cfg = dir.appendingPathComponent("c.toml")
                try """
                version = 1
                [analysis]
                big_file_threshold_mb = 1
                [[folders]]
                path = "\(data.path)"
                [[folders]]
                path = "/nonexistent-cairn"
                """.write(to: cfg, atomically: true, encoding: .utf8)
                let (code, out, _) = run(["analyze", "--json", "--config", cfg.path])
                try expectEqual(code, .ok)
                let obj = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any]
                let folders = obj?["folders"] as? [[String: Any]] ?? []
                try expectEqual(folders.map { $0["available"] as? Bool }, [true, false])
                let big = folders.first?["big_objects"] as? [[String: Any]]
                try expectEqual(big?.first?["kind"] as? String, "file")
            }
        },
    ]
    // Comparaison avec du sur le vrai workspace (≈ 45 s) : CAIRN_SELFTEST_SLOW=1 just test Analysis
    if ProcessInfo.processInfo.environment["CAIRN_SELFTEST_SLOW"] == "1" {
        t.append(TestCase("matches_du_on_workspaces_within_1_percent") {
            let path = "/Volumes/workspaces"
            let r = Scanner.scan(root: path, ctx: ScanContext())
            let ref = try du(path)
            let gap = abs(Double(r.root.size - ref)) / Double(ref)
            print("    Cairn \(r.root.size) o, du \(ref) o, écart \(String(format: "%.3f", gap * 100)) %")
            try expect(gap < 0.01, "écart \(gap * 100) %")
        })
    }
    return t
}()
