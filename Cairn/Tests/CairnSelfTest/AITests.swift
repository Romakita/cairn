import CairnCore
import Foundation
import SQLite3

private func makeDB(_ path: String, rows: Int) {
    var db: OpaquePointer?
    sqlite3_open(path, &db)
    sqlite3_exec(db, "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(x TEXT);", nil, nil, nil)
    for i in 0..<rows { sqlite3_exec(db, "INSERT INTO t VALUES('row \(i) \(String(repeating: "x", count: 200))');", nil, nil, nil) }
    sqlite3_close(db)
}

private func integrityOK(_ path: String) -> Bool {
    var db: OpaquePointer?
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return false }
    defer { sqlite3_close(db) }
    var stmt: OpaquePointer?
    sqlite3_prepare_v2(db, "PRAGMA integrity_check;", -1, &stmt, nil)
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_step(stmt) == SQLITE_ROW, let c = sqlite3_column_text(stmt, 0) else { return false }
    return String(cString: c) == "ok"
}

/// Faux home avec un Codex et un Claude Code minimaux.
private func fakeHome(_ home: URL) throws {
    try writeFile(home.appendingPathComponent(".codex/sessions/2026/11/08/rollout-a.jsonl.zst"), size: 5_000)
    try writeFile(home.appendingPathComponent(".codex/config.toml"), size: 100)
    try writeFile(home.appendingPathComponent(".codex/auth.json"), size: 100)
    try writeFile(home.appendingPathComponent(".codex/packages/standalone/bin/codex"), size: 50_000)
    try writeFile(home.appendingPathComponent(".codex/plugins/foo/x.js"), size: 10_000)
    try writeFile(home.appendingPathComponent(".codex/cache/c.bin"), size: 10_000)
    makeDB(home.appendingPathComponent(".codex/state_5.sqlite").path, rows: 50)
    makeDB(home.appendingPathComponent(".codex/logs_2.sqlite").path, rows: 10)
    try writeFile(home.appendingPathComponent(".claude/projects/-Volumes-workspaces-exports/s1.jsonl"), size: 3_000)
    try writeFile(home.appendingPathComponent(".claude/settings.json"), size: 100)
    try writeFile(home.appendingPathComponent(".claude/cache/x"), size: 100)
}

let aiTests: [TestCase] = [
    TestCase("bundled_profiles_and_detection") {
        let ids = AIProfiles.bundled.map(\.id)
        try expectEqual(ids, ["claude-code", "claude-desktop", "codex"])
        try withTempDir { home in
            try expect(!AIProfiles.bundled.contains { $0.isDetected(home: home.path) }, "outil absent : non détecté, sans erreur")
            try fakeHome(home)
            try expectEqual(AIProfiles.bundled.filter { $0.isDetected(home: home.path) }.map(\.id), ["claude-code", "codex"])
        }
    },
    TestCase("new_profile_without_code_change") {
        try withTempDir { dir in
            try """
            {"id":"aider","version":1,"root":"~/.aider","detect":[".aider"],"credentials_in_keychain":false,
             "categories":{"conversations":["history/"],"config":["conf.yml"],"memories":[],"credentials":[]},
             "sqlite":[],"exclude":[],"reinstall":[]}
            """.write(to: dir.appendingPathComponent("aider.json"), atomically: true, encoding: .utf8)
            let p = AIProfiles.load(from: dir)
            try expectEqual(p.map(\.id), ["aider"])
            try expectEqual(p.first?.categories["config"], ["conf.yml"])
        }
    },
    TestCase("reinstalled_and_cache_never_in_copied_categories") {
        for p in AIProfiles.bundled {
            let copied = p.categories.values.flatMap { $0 }
            for forbidden in ["plugins/", "packages/", "cache/", "logs_"] {
                try expect(!copied.contains { $0.hasPrefix(forbidden) || $0.contains("/" + forbidden) && !$0.hasSuffix(".json") },
                           "\(p.id) copie \(forbidden)")
            }
        }
    },
    TestCase("sqlite_snapshot_is_consistent_while_writing") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("live.sqlite").path
            makeDB(src, rows: 200)
            // Écritures concurrentes pendant le snapshot.
            let writer = Thread { makeDB(src, rows: 500) }
            writer.start()
            let dst = dir.appendingPathComponent("snap/live.sqlite").path
            try AIBackup.snapshot(src, to: dst)
            try expect(integrityOK(dst), "integrity_check")
            try expect(!FileManager.default.fileExists(atPath: dst + "-wal"), "pas de -wal dans la copie")
        }
    },
    TestCase("sqlite_snapshot_of_closed_wal_database_without_shm") {
        // Outil fermé proprement (SQLite embarqué de Codex) : base en WAL sans -wal ni -shm à côté.
        // Une ouverture en lecture seule échoue alors (SQLITE_CANTOPEN) : « Impossible de copier la base ».
        try withTempDir { dir in
            let src = dir.appendingPathComponent("state_5.sqlite").path
            makeDB(src, rows: 100)
            for s in ["-wal", "-shm"] { try? FileManager.default.removeItem(atPath: src + s) }
            let before = try FileManager.default.attributesOfItem(atPath: src)
            let dst = dir.appendingPathComponent("snap/state_5.sqlite").path
            try AIBackup.snapshot(src, to: dst)
            try expect(integrityOK(dst), "integrity_check")
            var db: OpaquePointer?
            sqlite3_open_v2(dst, &db, SQLITE_OPEN_READONLY, nil)
            var stmt: OpaquePointer?
            sqlite3_prepare_v2(db, "SELECT count(*) FROM t;", -1, &stmt, nil)
            let count = sqlite3_step(stmt) == SQLITE_ROW ? sqlite3_column_int(stmt, 0) : -1
            sqlite3_finalize(stmt); sqlite3_close(db)
            try expectEqual(count, 100)
            // Rien n'est créé ni modifié à côté de la base de l'outil.
            for s in ["-wal", "-shm"] { try expect(!FileManager.default.fileExists(atPath: src + s), "\(s) créé chez l'outil") }
            let after = try FileManager.default.attributesOfItem(atPath: src)
            try expectEqual(after[.modificationDate] as? Date, before[.modificationDate] as? Date)
        }
    },
    TestCase("immutable_read_only_for_clean_wal_databases") {
        try withTempDir { dir in
            let fm = FileManager.default
            let wal = dir.appendingPathComponent("wal.sqlite").path
            makeDB(wal, rows: 5)
            for s in ["-wal", "-shm"] { try? fm.removeItem(atPath: wal + s) }
            try expect(AIBackup.isCleanWAL(wal), "WAL fermée proprement")
            try Data().write(to: URL(fileURLWithPath: wal + "-wal"))
            try expect(!AIBackup.isCleanWAL(wal), "-wal présent")
            // Journal classique avec un -journal (outil planté) : récupération nécessaire, jamais d'immutable.
            let rollback = dir.appendingPathComponent("rollback.sqlite").path
            var db: OpaquePointer?
            sqlite3_open(rollback, &db)
            sqlite3_exec(db, "PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES(1);", nil, nil, nil)
            sqlite3_close(db)
            try expect(!AIBackup.isCleanWAL(rollback), "journal classique")
            try Data(repeating: 1, count: 512).write(to: URL(fileURLWithPath: rollback + "-journal"))
            try expect(!AIBackup.isCleanWAL(rollback), "-journal chaud")
            try Data(repeating: 0x42, count: 100).write(to: dir.appendingPathComponent("junk.sqlite"))
            try expect(!AIBackup.isCleanWAL(dir.appendingPathComponent("junk.sqlite").path), "pas du SQLite")
        }
    },
    TestCase("unreadable_database_warns_without_failing_backup") {
        try withTempDir { dir in
            let home = dir.appendingPathComponent("home")
            try fakeHome(home)
            // Base illisible (pas du SQLite) : la sauvegarde continue, avec un avertissement.
            try Data(repeating: 0x42, count: 8192).write(to: home.appendingPathComponent(".codex/state_5.sqlite"))
            var c = CairnConfig()
            c.ai = [.init(id: "codex", categories: ["conversations"])]
            var warnings: [String] = []
            let parts = try AIBackup.parts(config: c, staging: dir.appendingPathComponent("staging"), home: home.path,
                                           warn: { warnings.append($0) })
            try expect(parts.contains { $0.target == "ai/codex/meta" }, "partie meta présente")
            try expectEqual(warnings.count, 1)
            try expect(warnings.first?.contains("state_5.sqlite") ?? false, "avertissement nomme la base")
            // Aucune copie vide ou partielle : la restauration l'installerait à la place de la vraie base.
            let snap = dir.appendingPathComponent("staging/ai-codex/sqlite/conversations/state_5.sqlite").path
            for s in ["", "-journal", "-wal", "-shm"] {
                try expect(!FileManager.default.fileExists(atPath: snap + s), "copie ratée laissée : state_5.sqlite\(s)")
            }
        }
    },
    TestCase("backup_parts_by_category_without_packages") {
        try withTempDir { dir in
            let home = dir.appendingPathComponent("home")
            try fakeHome(home)
            var c = CairnConfig()
            c.ai = [.init(id: "codex", categories: ["conversations", "config"])]
            let staging = dir.appendingPathComponent("staging")
            let parts = try AIBackup.parts(config: c, staging: staging, home: home.path)
            try expectEqual(Set(parts.map(\.target)), ["ai/codex/conversations", "ai/codex/config", "ai/codex/meta"])
            let dest = dir.appendingPathComponent("dest")
            let out = try BackupEngine().run(parts: parts, root: dest, retention: .recommended, dryRun: false, machine: "m")
            let v = BackupEngine.versionsDir(root: dest, machine: "m").appendingPathComponent(out.version!).appendingPathComponent("ai/codex")
            let fm = FileManager.default
            try expect(fm.fileExists(atPath: v.appendingPathComponent("conversations/sessions/2026/11/08/rollout-a.jsonl.zst").path))
            try expect(fm.fileExists(atPath: v.appendingPathComponent("config/config.toml").path))
            try expect(!fm.fileExists(atPath: v.appendingPathComponent("credentials").path), "identifiants non cochés")
            try expect(integrityOK(v.appendingPathComponent("meta/sqlite/conversations/state_5.sqlite").path))
            for bad in ["packages", "plugins", "cache", "logs_2.sqlite"] {
                let found = fm.enumerator(atPath: v.path)?.allObjects.compactMap { $0 as? String }.contains { $0.contains(bad) } ?? false
                try expect(!found, "\(bad) ne doit pas être copié")
            }
            let meta = try JSONSerialization.jsonObject(with: Data(contentsOf: v.appendingPathComponent("meta/profile.json"))) as? [String: Any]
            try expectEqual((meta?["reinstall"] as? [String: [String]])?["plugins/"], ["foo"])
        }
    },
    TestCase("restore_merges_and_rewrites_claude_projects") {
        try withTempDir { dir in
            let saved = dir.appendingPathComponent("version/ai/claude-code")
            let old = saved.appendingPathComponent("conversations/.claude/projects/-Volumes-workspaces-exports")
            try writeFile(old.appendingPathComponent("older.jsonl"), size: 100)
            try writeFile(old.appendingPathComponent("newer.jsonl"), size: 100)
            try writeFile(old.appendingPathComponent("only-saved.jsonl"), size: 100)
            let home = dir.appendingPathComponent("home")
            let local = home.appendingPathComponent(".claude/projects/-Volumes-workspaces-exports")
            try writeFile(local.appendingPathComponent("older.jsonl"), size: 50)
            try writeFile(local.appendingPathComponent("newer.jsonl"), size: 50)
            let fm = FileManager.default
            let past = Date().addingTimeInterval(-86_400), future = Date().addingTimeInterval(3600)
            try fm.setAttributes([.modificationDate: past], ofItemAtPath: local.appendingPathComponent("older.jsonl").path)
            try fm.setAttributes([.modificationDate: future], ofItemAtPath: local.appendingPathComponent("newer.jsonl").path)
            let profile = AIProfiles.bundled.first { $0.id == "claude-code" }!
            let report = try AIRestore.restore(toolDir: saved, profile: profile, home: home.path, replaceDatabases: false,
                                               prefixes: [("/Volumes/workspaces", home.path + "/workspaces")])
            try expectEqual(report.added, 1)
            try expectEqual(report.replacedOlder, 1)
            try expectEqual(report.keptNewer, 1)
            let renamed = home.appendingPathComponent(".claude/projects/" + AIRestore.claudeProjectName(home.path + "/workspaces/exports"))
            try expect(fm.fileExists(atPath: renamed.appendingPathComponent("only-saved.jsonl").path), "dossier de projet réécrit")
            try expectEqual(try fm.attributesOfItem(atPath: renamed.appendingPathComponent("newer.jsonl").path)[.size] as? Int, 50, "locale plus récente gardée")
            try expect(fm.fileExists(atPath: renamed.appendingPathComponent("newer.jsonl.pre-restore").path), "sauvegardée écrite à côté")
            try expect(fm.fileExists(atPath: renamed.appendingPathComponent("older.jsonl.pre-restore").path), "ancienne locale gardée")
            try expectEqual(AIRestore.claudeProjectName("/Volumes/workspaces/exports"), "-Volumes-workspaces-exports")
        }
    },
    TestCase("legacy_backup_ai_data") {
        try withTempDir { dir in
            let bk = dir.appendingPathComponent("bk")
            try writeFile(bk.appendingPathComponent("home/.codex/config.toml"), size: 100)
            makeDB(dir.appendingPathComponent("legacy.sqlite").path, rows: 5)
            try FileManager.default.createDirectory(at: bk.appendingPathComponent("ai/sqlite/.codex"), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: dir.appendingPathComponent("legacy.sqlite"), to: bk.appendingPathComponent("ai/sqlite/.codex/state_5.sqlite"))
            try writeFile(bk.appendingPathComponent("ai/claude-desktop/Claude/config.json"), size: 50)
            let home = dir.appendingPathComponent("home")
            try writeFile(home.appendingPathComponent(".codex/state_5.sqlite-wal"), size: 10)
            let r = try AIRestore.restoreLegacy(backup: bk, tools: ["codex", "claude-desktop"], home: home.path, replaceDatabases: true)
            try expectEqual(r.databases, 1)
            let fm = FileManager.default
            try expect(fm.fileExists(atPath: home.appendingPathComponent(".codex/config.toml").path))
            try expect(!fm.fileExists(atPath: home.appendingPathComponent(".codex/state_5.sqlite-wal").path), "-wal retiré avant de poser la base")
            try expect(fm.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Claude/config.json").path))
        }
    },
]
