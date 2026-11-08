import CairnCore
import Foundation

private func gitInit(_ dir: URL) throws {
    _ = try shell("/usr/bin/git", ["-C", dir.path, "init", "-q"])
}

private func du(_ path: String) throws -> Int64 {
    let (_, out) = try shell("/usr/bin/du", ["-sk", path])
    return (Int64(out.split(separator: "\t").first ?? "0") ?? 0) * 1024
}

private func date(_ s: String) -> Date { BackupEngine.date(ofVersion: s)! }

let backupTests: [TestCase] = [
    TestCase("exclusions_follow_gitignore_and_markers") {
        try withTempDir { dir in
            let repo = dir.appendingPathComponent("repo")
            try writeFile(repo.appendingPathComponent("lib/versioned.js"), size: 10)
            try writeFile(repo.appendingPathComponent("build/out.js"), size: 10)
            try "build/\n".write(to: repo.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
            try gitInit(repo)
            try writeFile(dir.appendingPathComponent("plain/lib/x.js"), size: 10) // pas de package.json : gardé
            try writeFile(dir.appendingPathComponent("node/package.json"), size: 10)
            try writeFile(dir.appendingPathComponent("node/out/y.js"), size: 10)
            let list = BackupExclusions.forFolder(dir.path, userPatterns: ["*.iso"], destinations: [dir.path + "/backups"])
            try expect(list.contains("/repo/build/"), "\(list)")
            try expect(!list.contains("/repo/lib/"), "lib versionné doit être copié")
            try expect(!list.contains("/plain/lib/"))
            try expect(list.contains("/node/out/"))
            try expect(list.contains("node_modules/") && list.contains("*.iso") && list.contains("/backups/"))
            try expect(!list.contains(".git/"), "l'historique git est sauvegardé")
        }
    },
    TestCase("home_selection_excludes_ai_dirs_and_caches") {
        try withTempDir { home in
            for f in [".zshrc", ".claude/settings.json", ".codex/config.toml", ".config/gcloud/creds.json",
                      ".config/gcloud/logs/a.log", ".config/gcloud/cache/x"] {
                try writeFile(home.appendingPathComponent(f), size: 100)
            }
            let items = BackupExclusions.homeItems([".zshrc", ".claude", ".codex", ".config/gcloud", ".absent"], home: home.path)
            try expectEqual(items, [".zshrc", ".config/gcloud"])
            let dest = home.appendingPathComponent("../dest-\(UUID().uuidString)").standardizedFileURL
            defer { try? FileManager.default.removeItem(at: dest) }
            let engine = BackupEngine()
            _ = try engine.run(parts: [BackupPart(kind: .home, target: "home", source: home.path,
                                                 excludes: BackupExclusions.homeExcludes, filesFrom: items)],
                               root: dest, retention: .recommended, dryRun: false, machine: "test")
            let v = BackupEngine.versionsDir(root: dest, machine: "test").appendingPathComponent("latest/home")
            let fm = FileManager.default
            try expect(fm.fileExists(atPath: v.appendingPathComponent(".zshrc").path))
            try expect(fm.fileExists(atPath: v.appendingPathComponent(".config/gcloud/creds.json").path))
            try expect(!fm.fileExists(atPath: v.appendingPathComponent(".config/gcloud/logs").path), "journaux exclus")
            try expect(!fm.fileExists(atPath: v.appendingPathComponent(".config/gcloud/cache").path), "cache exclu")
            try expect(!fm.fileExists(atPath: v.appendingPathComponent(".claude").path), "dossiers IA hors du home")
        }
    },
    TestCase("second_version_is_hard_linked") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            for i in 0..<20 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 100_000) }
            let part = BackupPart(kind: .folder, target: "folders/src", source: src.path)
            let e = BackupEngine()
            let v1 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                               now: date("2026-11-01T120000"))
            let v2 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                               now: date("2026-11-02T120000"))
            try expectEqual(v1.filesTransferred, 20)
            try expectEqual(v2.filesTransferred, 0)
            let versions = BackupEngine.versionsDir(root: dest, machine: "m")
            try expectEqual(BackupEngine.versions(in: versions).count, 2)
            let used = try du(versions.path)
            try expect(used < 2_600_000, "la 2e version doit être liée : \(used) octets")
            let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: versions.appendingPathComponent("latest/manifest.json"))) as? [String: Any]
            try expectEqual(manifest?["machine"] as? String, "m")
        }
    },
    TestCase("dry_run_writes_nothing") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            try writeFile(src.appendingPathComponent("a.bin"), size: 300_000)
            let r = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                                           root: dest, retention: .recommended, dryRun: true, machine: "m")
            try expectEqual(r.bytesTransferred, 300_000)
            let versions = BackupEngine.versionsDir(root: dest, machine: "m")
            try expectEqual(BackupEngine.versions(in: versions).count, 0)
            let left = (try? FileManager.default.contentsOfDirectory(atPath: versions.path)) ?? []
            try expect(left.isEmpty, "\(left)")
        }
    },
    TestCase("cancelled_run_leaves_no_visible_version") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src")
            try writeFile(src.appendingPathComponent("a.bin"), size: 1000)
            let e = BackupEngine()
            e.cancel()
            var cancelled = false
            do {
                _ = try e.run(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                              root: dir.appendingPathComponent("dest"), retention: .recommended, dryRun: false, machine: "m")
            } catch BackupError.cancelled { cancelled = true }
            try expect(cancelled)
            try expectEqual(BackupEngine.versions(in: BackupEngine.versionsDir(root: dir.appendingPathComponent("dest"), machine: "m")).count, 0)
        }
    },
    TestCase("interrupted_backup_resumes_without_recopy") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            for i in 0..<10 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 50_000) }
            // Version interrompue récente : la moitié des fichiers déjà copiés.
            let versions = BackupEngine.versionsDir(root: dest, machine: "m")
            let now = date("2026-11-08T120000")
            let incomplete = versions.appendingPathComponent(BackupEngine.incompletePrefix + "2026-11-08T110000/folders/src")
            try FileManager.default.createDirectory(at: incomplete, withIntermediateDirectories: true)
            for i in 0..<5 {
                _ = try shell("/bin/cp", ["-p", src.appendingPathComponent("f\(i).bin").path, incomplete.path])
            }
            let r = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                                           root: dest, retention: .recommended, dryRun: false, machine: "m", now: now)
            try expectEqual(r.filesTransferred, 5, "seuls les fichiers restants sont transférés")
            try expectEqual(r.version, "2026-11-08T110000")
        }
    },
    TestCase("tiered_retention") {
        let now = date("2026-11-08T120000")
        let daily = (0..<60).map { now.addingTimeInterval(-Double($0) * 86_400) }
        let keep = RetentionPolicy.keep(daily, retention: .tiered(days: 30, weeks: 48), now: now)
        let recent = daily.filter { now.timeIntervalSince($0) <= 30 * 86_400 }
        try expect(recent.allSatisfy(keep.contains), "toutes les quotidiennes des 30 derniers jours")
        let older = keep.filter { now.timeIntervalSince($0) > 30 * 86_400 }
        try expect(older.count >= 4 && older.count <= 6, "une par semaine avant : \(older.count)")
        let ancient = now.addingTimeInterval(-400 * 86_400)
        try expect(!RetentionPolicy.keep(daily + [ancient], retention: .recommended, now: now).contains(ancient), "plus d'un an : supprimée")
        let count = RetentionPolicy.keep(daily, retention: .count(12), now: now)
        try expectEqual(count.count, 12)
        try expect(count.contains(daily[0]) && count.contains(daily[11]) && !count.contains(daily[12]))
        let cov = RetentionPolicy.coverage(.recommended, frequency: .daily)
        try expectEqual(cov.maxVersions, 78)
    },
    TestCase("reduced_retention_lists_excess_without_deleting") {
        try withTempDir { dir in
            let versions = dir.appendingPathComponent("v")
            for i in 1...20 { try FileManager.default.createDirectory(at: versions.appendingPathComponent(String(format: "2026-10-%02dT120000", i)), withIntermediateDirectories: true) }
            let excess = BackupEngine.excessVersions(versionsDir: versions, retention: .count(12), now: date("2026-11-08T120000"))
            try expectEqual(excess.count, 8)
            try expectEqual(BackupEngine.versions(in: versions).count, 20, "rien n'est supprimé avant confirmation")
        }
    },
    TestCase("integrity_detects_damage_and_next_backup_recopies") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            for i in 0..<5 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 20_000) }
            let part = BackupPart(kind: .folder, target: "folders/src", source: src.path)
            let e = BackupEngine()
            let v1 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m", now: date("2026-11-01T120000"))
            let versions = BackupEngine.versionsDir(root: dest, machine: "m")
            let vdir = versions.appendingPathComponent(v1.version!)
            // Corruption : contenu modifié sans changer taille ni date.
            let damagedFile = vdir.appendingPathComponent("folders/src/f2.bin")
            let attrs = try FileManager.default.attributesOfItem(atPath: damagedFile.path)
            try Data(repeating: 7, count: 20_000).write(to: damagedFile)
            try FileManager.default.setAttributes([.modificationDate: attrs[.modificationDate]!], ofItemAtPath: damagedFile.path)
            let report = Integrity.verify(version: vdir, full: true)
            try expectEqual(report.damaged, ["folders/src/f2.bin"])
            let plan = Integrity.recopyPlan(previous: vdir, parts: [part])
            try expectEqual(plan["folders/src"], ["f2.bin"])
            let v2 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                               now: date("2026-11-02T120000"), forceRecopy: plan)
            let fresh = versions.appendingPathComponent(v2.version!).appendingPathComponent("folders/src/f2.bin")
            try expectEqual(try Data(contentsOf: fresh), Data(count: 20_000), "le fichier est recopié depuis la source")
            try expect(Integrity.verify(version: versions.appendingPathComponent(v2.version!), full: true).damaged.isEmpty)
        }
    },
    TestCase("encrypted_sparse_image_roundtrip") {
        try withTempDir { dir in
            let img = SparseImage(root: dir, destinationID: "selftest-\(UUID().uuidString)", encrypted: true, machine: "m")
            defer { Keychain.deletePassword(service: img.keychainService, account: "m") }
            let pw = try img.create(size: "100m")
            try expect(pw != nil && img.password == pw, "mot de passe dans le Trousseau")
            let mp = try img.attach()
            try "secret".write(to: mp.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
            img.detach()
            let raw = try shell("/usr/bin/grep", ["-r", "-l", "secret", img.path])
            try expect(raw.1.isEmpty, "le contenu ne doit pas apparaître en clair dans l'image")
            let again = try img.attach()
            try expectEqual(try String(contentsOf: again.appendingPathComponent("a.txt"), encoding: .utf8), "secret")
            img.detach()
        }
    },
    TestCase("new_image_reuses_keychain_password_after_relocation") {
        // Destination déplacée vers un dossier vide : la nouvelle image reprend le mot de passe du Trousseau, qui ouvre
        // toujours l'image laissée à l'ancien emplacement.
        try withTempDir { dir in
            let id = "selftest-\(UUID().uuidString)"
            let old = SparseImage(root: dir.appendingPathComponent("ancien"), destinationID: id, encrypted: true, machine: "m")
            defer { Keychain.deletePassword(service: old.keychainService, account: "m") }
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("ancien"), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("nouveau"), withIntermediateDirectories: true)
            let pw = try old.create(size: "50m")
            let moved = SparseImage(root: dir.appendingPathComponent("nouveau"), destinationID: id, encrypted: true, machine: "m")
            try expectEqual(try moved.create(size: "50m"), pw, "le mot de passe existant est repris")
            try expectEqual(moved.password, pw)
            _ = try old.attach()
            old.detach()
        }
    },
    TestCase("schedule_decisions") {
        var s = CairnConfig.Schedule()
        s.frequency = .daily
        s.time = "12:00"
        let cal = Calendar(identifier: .gregorian)
        let at = { (str: String) in BackupEngine.date(ofVersion: str)! }
        try expectEqual(BackupSchedule.decide(s, lastSuccess: at("2026-11-07T120500"), now: at("2026-11-08T110000"), running: false, power: .ac, reachable: true, calendar: cal), .notDue)
        try expectEqual(BackupSchedule.decide(s, lastSuccess: at("2026-11-07T120500"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal), .run, "échéance de midi manquée → rattrapage")
        try expectEqual(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: true, power: .ac, reachable: true, calendar: cal), .alreadyRunning)
        try expectEqual(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: false,
                                              power: .init(onBattery: true, percent: 15, lowPowerMode: false), reachable: true, calendar: cal), .waitingPower)
        try expectEqual(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: false, power: .ac, reachable: false, calendar: cal), .waitingDestination)
        var w = s
        w.frequency = .weekly
        w.weekday = "monday" // 2026-11-09 est un lundi
        try expectEqual(BackupSchedule.decide(w, lastSuccess: at("2026-11-02T130000"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal), .notDue)
        try expectEqual(BackupSchedule.decide(w, lastSuccess: at("2026-11-02T130000"), now: at("2026-11-09T150000"), running: false, power: .ac, reachable: true, calendar: cal), .run)
        s.frequency = .manual
        try expectEqual(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal), .manual)
    },
    TestCase("overdue_notification_after_one_day_once_per_day") {
        var s = CairnConfig.Schedule()
        s.time = "12:00"
        let cal = Calendar(identifier: .gregorian)
        let at = { (str: String) in BackupEngine.date(ofVersion: str)! }
        let last = at("2026-11-06T120500")
        try expect(!BackupSchedule.shouldNotifyOverdue(s, lastSuccess: last, lastNotice: nil, now: at("2026-11-07T150000"), calendar: cal), "3 h de retard : pas de notification")
        try expect(BackupSchedule.shouldNotifyOverdue(s, lastSuccess: last, lastNotice: nil, now: at("2026-11-08T180000"), calendar: cal), "30 h de retard")
        try expect(!BackupSchedule.shouldNotifyOverdue(s, lastSuccess: last, lastNotice: at("2026-11-08T100000"), now: at("2026-11-08T180000"), calendar: cal), "une par jour au plus")
    },
    TestCase("cli_backup_refused_while_locked_and_dry_run_is_safe") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            try writeFile(src.appendingPathComponent("a.bin"), size: 100_000)
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            var c = CairnConfig()
            c.folders = [.init(path: src.path)]
            c.destinations = [.init(id: "local", provider: .local, path: dest.path, encrypted: false)]
            try ConfigStore(paths: paths).save(c)
            let cfg = paths.config.path
            var out = ""
            let dry = CLI.run(["cairn", "backup", "--dry-run", "--only", "folders", "--config", cfg, "--json"], out: { out += $0 }, err: { _ in })
            try expectEqual(dry, .ok, out)
            try expect(!FileManager.default.fileExists(atPath: BackupEngine.versionsDir(root: dest).appendingPathComponent("latest").path))
            let lock = OperationLock(url: paths.operationLock)
            try lock.acquire(operation: "app backup")
            var err = ""
            let busy = CLI.run(["cairn", "backup", "--only", "folders", "--config", cfg, "--lang", "en-US"], out: { _ in }, err: { err += $0 })
            try expectEqual(busy, .failure)
            try expect(err.contains("already running"), err)
            lock.release()
            let ok = CLI.run(["cairn", "backup", "--only", "folders", "--config", cfg], out: { _ in }, err: { _ in })
            try expectEqual(ok, .ok)
            try expectEqual(CLI.run(["cairn", "verify", "--full", "--config", cfg], out: { _ in }, err: { _ in }), .ok)
        }
    },
    TestCase("dry_run_creates_nothing_on_destination") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src")
            try writeFile(src.appendingPathComponent("a.bin"), size: 50_000)
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            let fm = FileManager.default
            for (name, encrypted) in [("plain", false), ("image", true)] {
                let dest = dir.appendingPathComponent("dest-" + name)
                var c = CairnConfig()
                c.folders = [.init(path: src.path)]
                c.destinations = [.init(id: "d-" + name, provider: .local, path: dest.path, encrypted: encrypted)]
                var req = BackupService.Request()
                req.dryRun = true
                req.only = [.folder]
                // Destination absente : rien n'est créé, la simulation annonce tout ce qui serait copié.
                let r1 = try BackupService(paths: paths, config: c).run(req)
                try expect(r1.first?.error == nil, "\(name): \(String(describing: r1.first?.error))")
                try expectEqual(r1.first?.outcome?.totalBytes, 50_000, name)
                try expect(!fm.fileExists(atPath: dest.path), "\(name) : la simulation ne crée pas le dossier")
                // Dossier vide : ni image, ni dossier des versions.
                try fm.createDirectory(at: dest, withIntermediateDirectories: true)
                let r2 = try BackupService(paths: paths, config: c).run(req)
                try expect(r2.first?.error == nil, "\(name): \(String(describing: r2.first?.error))")
                try expectEqual(try fm.contentsOfDirectory(atPath: dest.path), [], "\(name) : rien d'écrit")
            }
        }
    },
    TestCase("partial_version_does_not_break_links_retention_or_restore") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), ai = dir.appendingPathComponent("ai"), dest = dir.appendingPathComponent("dest")
            for i in 0..<10 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 100_000) }
            try writeFile(ai.appendingPathComponent("s.jsonl"), size: 1000)
            let folder = BackupPart(kind: .folder, target: "folders/src", source: src.path)
            let aiPart = BackupPart(kind: .ai, target: "ai/codex/conversations", source: ai.path)
            let e = BackupEngine()
            let versions = BackupEngine.versionsDir(root: dest, machine: "m")
            let v1 = try e.run(parts: [folder, aiPart], root: dest, retention: .count(1), dryRun: false, machine: "m", now: date("2026-11-01T120000"))
            let v2 = try e.run(parts: [aiPart], root: dest, retention: .count(1), dryRun: false, machine: "m", now: date("2026-11-02T120000"), partial: true)
            try expect(BackupEngine.isPartial(versions.appendingPathComponent(v2.version!)))
            try expectEqual(try FileManager.default.destinationOfSymbolicLink(atPath: versions.appendingPathComponent("latest").path), v1.version!,
                            "une version partielle ne devient pas « latest »")
            try expectEqual(BackupEngine.versions(in: versions), [v1.version!, v2.version!], "la partielle ne compte pas dans la rétention")
            let all = RestoreSource.versions(onDestinationRoot: dest)
            try expectEqual(RestoreSource.defaultVersion(all, machine: "m")?.lastPathComponent, v1.version!, "restauration : dernière version complète")
            let v3 = try e.run(parts: [folder, aiPart], root: dest, retention: .count(1), dryRun: false, machine: "m", now: date("2026-11-03T120000"))
            try expectEqual(v3.filesTransferred, 0, "les dossiers sont liés à v1, pas recopiés")
            try expectEqual(BackupEngine.versions(in: versions), [v3.version!], "v1 hors rétention, v2 remplacée par une version complète")
            let sums = Integrity.read(versions.appendingPathComponent(v3.version!))
            try expectEqual(sums.keys.filter { $0.hasPrefix("folders/src/") }.count, 10)
        }
    },
    TestCase("logs_of_kept_versions_are_spared") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            try writeFile(src.appendingPathComponent("a.bin"), size: 10_000)
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            var c = CairnConfig()
            c.folders = [.init(path: src.path)]
            c.destinations = [.init(id: "local", provider: .local, path: dest.path, encrypted: false, retention: .count(1))]
            let service = BackupService(paths: paths, config: c)
            _ = try service.run(BackupService.Request())
            Thread.sleep(forTimeInterval: 1.1)   // un autre nom de journal (horodatage à la seconde)
            _ = try service.run(BackupService.Request())
            let kept = RunState.load(paths).keptLogs
            let versions = BackupEngine.versionsDir(root: dest)
            try expectEqual(BackupEngine.versions(in: versions).count, 1)
            try expectEqual(kept, Set(BackupEngine.logs(in: versions)))
            try expectEqual(kept.count, 1)
            // Les deux journaux ont 200 jours : seul celui de la version gardée reste.
            let fm = FileManager.default
            let old = Date().addingTimeInterval(-200 * 86_400)
            let logs = try fm.contentsOfDirectory(atPath: paths.logs.path).filter { $0.hasPrefix("backup-") }
            try expectEqual(logs.count, 2)
            for l in logs { try fm.setAttributes([.modificationDate: old], ofItemAtPath: paths.logs.appendingPathComponent(l).path) }
            let removed = LogJanitor.prune(paths: paths, retentionDays: 90, keep: kept)
            try expectEqual(removed.count, 1)
            try expect(fm.fileExists(atPath: paths.logs.appendingPathComponent(kept.first!).path))
        }
    },
    TestCase("restore_opens_image_of_another_mac_with_typed_password") {
        try withTempDir { dir in
            let dest = dir.appendingPathComponent("dest")
            try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
            let id = "selftest-\(UUID().uuidString)"
            let old = SparseImage(root: dest, destinationID: id, encrypted: true, machine: "OldMac")
            let pw = try old.create(size: "100m")!
            let mp = try old.attach()
            try writeFile(mp.appendingPathComponent("cairn/OldMac/versions/2026-11-01T100000/home/.zshrc"), size: 10)
            old.detach()
            Keychain.deletePassword(service: old.keychainService, account: "OldMac")   // Mac neuf : Trousseau vide
            let d = CairnConfig.Destination(id: id, provider: .local, path: dest.path, encrypted: true)
            let s1 = DestinationSession(d)
            do {
                _ = try s1.open(createIfMissing: false)
                s1.close()
                try expect(false, "le mot de passe aurait dû être demandé")
            } catch ProviderError.missingImagePassword {
                s1.close()
            }
            try expect(SparseImage.images(at: dest).count == 1, "aucune image créée pour ce Mac")
            let s2 = DestinationSession(d)
            s2.imagePassword = pw
            let root = try s2.open(createIfMissing: false)
            defer { s2.close() }
            try expectEqual(RestoreSource.versions(onDestinationRoot: root).map(\.machine), ["OldMac"])
        }
    },
    TestCase("dry_run_after_a_backup_lists_only_changes") {
        try withTempDir { dir in
            let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
            for i in 0..<5 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 10_000) }
            let part = BackupPart(kind: .folder, target: "folders/src", source: src.path)
            let e = BackupEngine()
            _ = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m", now: date("2026-11-01T120000"))
            try writeFile(src.appendingPathComponent("new.bin"), size: 1234)
            let before = try FileManager.default.subpathsOfDirectory(atPath: dest.path).sorted()
            let sim = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: true, machine: "m", now: date("2026-11-02T120000"))
            try expectEqual(sim.filesTransferred, 1)
            try expectEqual(sim.bytesTransferred, 1234)
            try expectEqual(try FileManager.default.subpathsOfDirectory(atPath: dest.path).sorted(), before, "rien d'écrit")
        }
    },
]
