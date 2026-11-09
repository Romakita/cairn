import CairnCore
import Foundation
import Testing

private func gitInit(_ dir: URL) throws {
    _ = try shell("/usr/bin/git", ["-C", dir.path, "init", "-q"])
}

private func du(_ path: String) throws -> Int64 {
    let (_, out) = try shell("/usr/bin/du", ["-sk", path])
    return (Int64(out.split(separator: "\t").first ?? "0") ?? 0) * 1024
}

private func date(_ s: String) -> Date { BackupEngine.date(ofVersion: s)! }

extension CairnTests {
    @Suite struct BackupTests {
        @Test func sha256_streams_large_files_in_constant_memory() throws {
            // Mesure dans CairnTestHelper : les autres tests, en parallèle, fausseraient la mémoire de ce processus.
            let helper = try #require(builtExecutable("CairnTestHelper"))
            try withTempDir { dir in
                let file = dir.appendingPathComponent("big.bin")
                FileManager.default.createFile(atPath: file.path, contents: nil)
                let h = try FileHandle(forWritingTo: file)
                try h.truncate(atOffset: 512 << 20) // fichier creux de 512 Mo
                try h.close()
                let (code, out) = try shell(helper.path, ["--hash-footprint", file.path])
                let fields = out.split(separator: " ").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                try #require(code == 0 && fields.count == 2, "sortie inattendue : \(out)")
                let hash = fields[0], growth = Int64(fields[1]) ?? .max
                #expect(hash == "9acca8e8c22201155389f65abbf6bc9723edc7384ead80503839f49dcc56d767")
                #expect(growth < 64 << 20, "mémoire +\(growth >> 20) Mo pour hacher 512 Mo")
            }
        }

        @Test func image_locked_by_stuck_helper_is_explained() {
            let path = "/Volumes/home/cairn/cairn-mac.sparsebundle"
            let busy = SparseImage.attachFailure(output: "hdiutil: attach failed - Resource temporarily unavailable", path: path)
            if case .imageBusy(path) = busy {} else { Issue.record("EAGAIN attendu : \(busy)") }
            #expect(busy.description.contains("cairn-mac.sparsebundle"), "nom de l'image dans le message")
            let busyFR = SparseImage.attachFailure(output: "hdiutil: attach failed - Ressources temporairement indisponibles",
                                                   path: path)
            if case .imageBusy = busyFR {} else { Issue.record("message français : \(busyFR)") }
            let other = SparseImage.attachFailure(output: "hdiutil: attach failed - Authentication error\n", path: path)
            if case .image("hdiutil: attach failed - Authentication error") = other {} else { Issue.record("\(other)") }
        }

        @Test func exclusions_follow_gitignore_and_markers() throws {
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
                #expect(list.contains("/repo/build/"), "\(list)")
                #expect(!list.contains("/repo/lib/"), "lib versionné doit être copié")
                #expect(!list.contains("/plain/lib/"))
                #expect(list.contains("/node/out/"))
                #expect(list.contains("node_modules/") && list.contains("*.iso") && list.contains("/backups/"))
                #expect(!list.contains(".git/"), "l'historique git est sauvegardé")
            }
        }

        @Test func home_selection_excludes_ai_dirs_and_caches() throws {
            try withTempDir { home in
                for f in [".zshrc", ".claude/settings.json", ".codex/config.toml", ".config/gcloud/creds.json",
                          ".config/gcloud/logs/a.log", ".config/gcloud/cache/x"] {
                    try writeFile(home.appendingPathComponent(f), size: 100)
                }
                let items = BackupExclusions.homeItems([".zshrc", ".claude", ".codex", ".config/gcloud", ".absent"], home: home.path)
                #expect(items == [".zshrc", ".config/gcloud"])
                let dest = home.appendingPathComponent("../dest-\(UUID().uuidString)").standardizedFileURL
                defer { try? FileManager.default.removeItem(at: dest) }
                let engine = BackupEngine()
                _ = try engine.run(parts: [BackupPart(kind: .home, target: "home", source: home.path,
                                                     excludes: BackupExclusions.homeExcludes, filesFrom: items)],
                                   root: dest, retention: .recommended, dryRun: false, machine: "test")
                let v = BackupEngine.versionsDir(root: dest, machine: "test").appendingPathComponent("latest/home")
                let fm = FileManager.default
                #expect(fm.fileExists(atPath: v.appendingPathComponent(".zshrc").path))
                #expect(fm.fileExists(atPath: v.appendingPathComponent(".config/gcloud/creds.json").path))
                #expect(!fm.fileExists(atPath: v.appendingPathComponent(".config/gcloud/logs").path), "journaux exclus")
                #expect(!fm.fileExists(atPath: v.appendingPathComponent(".config/gcloud/cache").path), "cache exclu")
                #expect(!fm.fileExists(atPath: v.appendingPathComponent(".claude").path), "dossiers IA hors du home")
            }
        }

        @Test func second_version_is_hard_linked() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                for i in 0..<20 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 100_000) }
                let part = BackupPart(kind: .folder, target: "folders/src", source: src.path)
                let e = BackupEngine()
                let v1 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                                   now: date("2026-11-01T120000"))
                let v2 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                                   now: date("2026-11-02T120000"))
                #expect(v1.filesTransferred == 20)
                #expect(v2.filesTransferred == 0)
                let versions = BackupEngine.versionsDir(root: dest, machine: "m")
                #expect(BackupEngine.versions(in: versions).count == 2)
                let used = try du(versions.path)
                #expect(used < 2_600_000, "la 2e version doit être liée : \(used) octets")
                let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: versions.appendingPathComponent("latest/manifest.json"))) as? [String: Any]
                #expect(manifest?["machine"] as? String == "m")
            }
        }

        @Test func progress_reaches_the_expected_total() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                for i in 0..<30 { try writeFile(src.appendingPathComponent("d\(i % 3)/f\(i).bin"), size: 1_000) }
                let part = BackupPart(kind: .folder, target: "folders/src", source: src.path)
                final class Seen: @unchecked Sendable { var all: [BackupProgress] = [] }
                let first = Seen()
                let v1 = try BackupEngine().run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                                                now: date("2026-11-01T120000")) { first.all.append($0) }
                // Première sauvegarde : comptage pendant la copie ; 30 fichiers examinés, retenus pour la suivante.
                #expect(first.all.last { $0.finishing == nil }?.processed == 30)
                #expect(v1.filesByPart["folders/src"] == 30)
                #expect(first.all.compactMap(\.fraction).allSatisfy { $0 <= 0.99 }, "plafonné à 99 %")
                // Suivante : le décompte précédent sert d'estimation, sans comptage ; les fichiers liés comptent aussi.
                let next = Seen()
                let v2 = try BackupEngine().run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                                                now: date("2026-11-02T120000"), expectedFiles: v1.filesByPart) { next.all.append($0) }
                #expect(!next.all.contains { $0.counting }, "pas de comptage")
                #expect(next.all.filter { $0.finishing == nil }.allSatisfy { $0.expected == 30 }, "total connu d'emblée")
                // Après la copie : empreintes des nouveaux fichiers annoncées, avec leur avancement.
                #expect(first.all.contains { $0.finishing != nil && $0.stepTotal == 30 }, "empreintes de 30 fichiers")
                #expect(next.all.last { $0.finishing == nil }?.processed == 30)
                #expect(v2.filesTransferred == 0)
            }
        }

        @Test func parallel_count_matches_a_single_rsync() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src")
                for i in 0..<40 { try writeFile(src.appendingPathComponent("p\(i % 7)/sub/f\(i).txt"), size: 10) }
                for i in 0..<5 { try writeFile(src.appendingPathComponent("p\(i)/node_modules/x\(i).js"), size: 10) }
                try writeFile(src.appendingPathComponent("top.txt"), size: 10)
                try writeFile(src.appendingPathComponent(".hidden"), size: 10)
                let part = BackupPart(kind: .folder, target: "folders/src", source: src.path, excludes: ["node_modules/"])
                let e = BackupEngine()
                // Pile : p0…p6 puis les fichiers du premier niveau, partagés entre 4 workers.
                #expect(BackupEngine.copyChunks(part).count == 8)
                final class Workers: @unchecked Sendable { var seen = Set<String>(); var finished = Set<Int>(); let lock = NSLock() }
                let workers = Workers()
                final class Sum: @unchecked Sendable { var n = 0; let lock = NSLock() }
                let streamed = Sum()
                let parallel = try e.countFiles(part, workers: 4, worker: { i, w in
                    workers.lock.withLock {
                        if !w.folder.isEmpty { workers.seen.insert(w.folder) }
                        if w.done { workers.finished.insert(i) }
                    }
                }) { d in streamed.lock.withLock { streamed.n += d } }
                // Chaque dossier pris une fois dans la pile, les 4 workers terminent.
                #expect(workers.seen == Set((0..<7).map { "p\($0)" }))
                #expect(workers.finished == [0, 1, 2, 3])
                let single = try e.countFiles(part, workers: 1)
                // 40 fichiers + top.txt + .hidden ; node_modules exclu dans chaque compteur.
                #expect(single == 42)
                #expect(parallel == 42)
                #expect(streamed.n == 42)
            }
        }

        @Test func operation_lock_is_seen_from_outside() throws {
            try withTempDir { dir in
                let url = dir.appendingPathComponent("op.lock")
                #expect(!OperationLock.isHeld(at: url), "pas de fichier, pas de verrou")
                let lock = OperationLock(url: url)
                try lock.acquire(operation: "backup")
                #expect(OperationLock.isHeld(at: url), "sauvegarde en cours")
                lock.release()
                #expect(!OperationLock.isHeld(at: url), "verrou rendu")
            }
        }

        @Test func rsync_errors_are_kept_in_the_warning() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                try writeFile(src.appendingPathComponent("ok.bin"), size: 10)
                let locked = src.appendingPathComponent("locked.bin")
                try writeFile(locked, size: 10)
                try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
                defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: locked.path) }
                let r = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                                               root: dest, retention: .recommended, dryRun: false, machine: "m")
                // Fichier illisible : code 23 (avertissement), avec la ligne d'erreur de rsync qui nomme le fichier.
                #expect(r.warnings.contains { $0.contains("locked.bin") && $0.contains("Permission denied") }, "\(r.warnings)")
            }
        }

        @Test func folder_is_copied_one_top_level_entry_at_a_time() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                for name in ["alpha", "beta", "gamma"] {
                    try writeFile(src.appendingPathComponent("\(name)/a.txt"), size: 10)
                    try writeFile(src.appendingPathComponent("\(name)/node_modules/x.js"), size: 10)
                }
                try writeFile(src.appendingPathComponent("top.txt"), size: 10)
                let part = BackupPart(kind: .folder, target: "folders/src", source: src.path, excludes: ["node_modules/"])
                // Trois dossiers puis les fichiers du premier niveau.
                #expect(BackupEngine.copyChunks(part).map(\.label) == ["alpha", "beta", "gamma", nil])
                final class Seen: @unchecked Sendable { var listing: [String] = [] }
                let seen = Seen()
                let v1 = try BackupEngine().run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                                                now: date("2026-11-01T120000")) { if let l = $0.listing { seen.listing.append(l) } }
                #expect(v1.filesTransferred == 4)
                #expect(Set(seen.listing).isSuperset(of: ["alpha", "beta", "gamma"]), "dossier en cours annoncé")
                let latest = BackupEngine.versionsDir(root: dest, machine: "m").appendingPathComponent("latest/folders/src")
                let fm = FileManager.default
                // Chaque morceau garde les autres (pas de --delete-excluded) et les exclusions s'appliquent partout.
                for name in ["alpha", "beta", "gamma"] {
                    #expect(fm.fileExists(atPath: latest.appendingPathComponent("\(name)/a.txt").path), "\(name)")
                    #expect(!fm.fileExists(atPath: latest.appendingPathComponent("\(name)/node_modules").path), "exclu : \(name)")
                }
                #expect(fm.fileExists(atPath: latest.appendingPathComponent("top.txt").path), "fichier du premier niveau")
            }
        }

        @Test func resumed_chunked_copy_removes_excluded_and_vanished_entries() throws {
            try withTempDir { dir in
                let (src, dest) = (dir.appendingPathComponent("src"), dir.appendingPathComponent("dest"))
                try writeFile(src.appendingPathComponent("a/f.txt"), size: 10)
                try writeFile(src.appendingPathComponent("a/node_modules/m.js"), size: 10)
                try writeFile(src.appendingPathComponent("b/g.txt"), size: 10)
                // Version interrompue : un dossier depuis exclu, un dossier disparu de la source, un fichier déjà copié.
                let work = try incompleteVersion(dest)
                for f in ["a/f.txt", "a/node_modules/old.js", "gone/z.txt"] {
                    try writeFile(work.appendingPathComponent("folders/src/" + f), size: 10)
                }
                let part = BackupPart(kind: .folder, target: "folders/src", source: src.path, excludes: ["node_modules/"])
                let r = try BackupEngine().run(parts: [BackupPart(kind: part.kind, target: part.target, source: part.source,
                                                                  excludes: part.excludes)],
                                               root: dest, retention: .recommended, dryRun: false, machine: "m")
                let version = try #require(r.version)
                let v = BackupEngine.versionsDir(root: dest, machine: "m").appendingPathComponent(version)
                    .appendingPathComponent("folders/src")
                let fm = FileManager.default
                #expect(fm.fileExists(atPath: v.appendingPathComponent("a/f.txt").path), "fichier gardé")
                #expect(fm.fileExists(atPath: v.appendingPathComponent("b/g.txt").path), "fichier copié")
                #expect(!fm.fileExists(atPath: v.appendingPathComponent("a/node_modules").path), "exclu retiré à la reprise")
                #expect(!fm.fileExists(atPath: v.appendingPathComponent("gone").path), "dossier disparu retiré")
                // Total jamais sous-estimé : le comptage complet, sinon rien (l'ancien total est gardé).
                #expect(r.filesByPart["folders/src"] == nil || r.filesByPart["folders/src"] == 2, "\(r.filesByPart)")
            }
        }

        @Test func failed_chunk_never_triggers_the_cleanup() throws {
            try withTempDir { dir in
                let (src, dest) = (dir.appendingPathComponent("src"), dir.appendingPathComponent("dest"))
                try writeFile(src.appendingPathComponent("a/f.txt"), size: 10)
                let locked = src.appendingPathComponent("b")
                try writeFile(locked.appendingPathComponent("g.txt"), size: 10)
                let work = try incompleteVersion(dest)
                try writeFile(work.appendingPathComponent("folders/src/gone/z.txt"), size: 10)
                // Dossier illisible : rsync finit en 23, la passe de nettoyage ne doit pas tourner.
                try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
                defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
                let c = try BackupEngine().copy(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                                                root: dest, retention: .recommended, dryRun: false, machine: "m")
                #expect(!c.warnings.isEmpty, "transfert partiel signalé")
                #expect(FileManager.default.fileExists(atPath: work.appendingPathComponent("folders/src/gone/z.txt").path),
                        "rien d'effacé après un échec")
            }
        }

        @Test func dry_run_writes_nothing() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                try writeFile(src.appendingPathComponent("a.bin"), size: 300_000)
                let r = try BackupEngine().run(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                                               root: dest, retention: .recommended, dryRun: true, machine: "m")
                #expect(r.bytesTransferred == 300_000)
                let versions = BackupEngine.versionsDir(root: dest, machine: "m")
                #expect(BackupEngine.versions(in: versions).count == 0)
                let left = (try? FileManager.default.contentsOfDirectory(atPath: versions.path)) ?? []
                #expect(left.isEmpty, "\(left)")
            }
        }

        @Test func cancelled_run_leaves_no_visible_version() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src")
                try writeFile(src.appendingPathComponent("a.bin"), size: 1000)
                let e = BackupEngine()
                e.cancel()
                let error = #expect(throws: BackupError.self) {
                    _ = try e.run(parts: [BackupPart(kind: .folder, target: "folders/src", source: src.path)],
                                  root: dir.appendingPathComponent("dest"), retention: .recommended, dryRun: false, machine: "m")
                }
                guard case .cancelled? = error else {
                    Issue.record("BackupError.cancelled attendu : \(String(describing: error))")
                    return
                }
                #expect(BackupEngine.versions(in: BackupEngine.versionsDir(root: dir.appendingPathComponent("dest"), machine: "m")).count == 0)
            }
        }

        @Test func interrupted_backup_resumes_without_recopy() throws {
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
                #expect(r.filesTransferred == 5, "seuls les fichiers restants sont transférés")
                #expect(r.version == "2026-11-08T110000")
            }
        }

        @Test func tiered_retention() {
            let now = date("2026-11-08T120000")
            let daily = (0..<60).map { now.addingTimeInterval(-Double($0) * 86_400) }
            let keep = RetentionPolicy.keep(daily, retention: .tiered(days: 30, weeks: 48), now: now)
            let recent = daily.filter { now.timeIntervalSince($0) <= 30 * 86_400 }
            #expect(recent.allSatisfy(keep.contains), "toutes les quotidiennes des 30 derniers jours")
            let older = keep.filter { now.timeIntervalSince($0) > 30 * 86_400 }
            #expect(older.count >= 4 && older.count <= 6, "une par semaine avant : \(older.count)")
            let ancient = now.addingTimeInterval(-400 * 86_400)
            #expect(!RetentionPolicy.keep(daily + [ancient], retention: .recommended, now: now).contains(ancient), "plus d'un an : supprimée")
            let count = RetentionPolicy.keep(daily, retention: .count(12), now: now)
            #expect(count.count == 12)
            #expect(count.contains(daily[0]) && count.contains(daily[11]) && !count.contains(daily[12]))
            let cov = RetentionPolicy.coverage(.recommended, frequency: .daily)
            #expect(cov.maxVersions == 78)
        }

        @Test func reduced_retention_lists_excess_without_deleting() throws {
            try withTempDir { dir in
                let versions = dir.appendingPathComponent("v")
                for i in 1...20 { try FileManager.default.createDirectory(at: versions.appendingPathComponent(String(format: "2026-10-%02dT120000", i)), withIntermediateDirectories: true) }
                let excess = BackupEngine.excessVersions(versionsDir: versions, retention: .count(12), now: date("2026-11-08T120000"))
                #expect(excess.count == 8)
                #expect(BackupEngine.versions(in: versions).count == 20, "rien n'est supprimé avant confirmation")
            }
        }

        @Test func integrity_detects_damage_and_next_backup_recopies() throws {
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
                #expect(report.damaged == ["folders/src/f2.bin"])
                let plan = Integrity.recopyPlan(previous: vdir, parts: [part])
                #expect(plan["folders/src"] == ["f2.bin"])
                let v2 = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m",
                                   now: date("2026-11-02T120000"), forceRecopy: plan)
                let fresh = versions.appendingPathComponent(v2.version!).appendingPathComponent("folders/src/f2.bin")
                #expect(try Data(contentsOf: fresh) == Data(count: 20_000), "le fichier est recopié depuis la source")
                #expect(Integrity.verify(version: versions.appendingPathComponent(v2.version!), full: true).damaged.isEmpty)
            }
        }

        @Test func encrypted_sparse_image_roundtrip() throws {
            try withTempDir { dir in
                let img = SparseImage(root: dir, destinationID: "selftest-\(UUID().uuidString)", encrypted: true, machine: "m")
                defer { Keychain.deletePassword(service: img.keychainService, account: "m") }
                let pw = try img.create(size: "100m")
                #expect(pw != nil && img.password == pw, "mot de passe dans le Trousseau")
                let mp = try img.attach()
                try "secret".write(to: mp.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
                img.detach()
                let raw = try shell("/usr/bin/grep", ["-r", "-l", "secret", img.path])
                #expect(raw.1.isEmpty, "le contenu ne doit pas apparaître en clair dans l'image")
                let again = try img.attach()
                #expect(try String(contentsOf: again.appendingPathComponent("a.txt"), encoding: .utf8) == "secret")
                img.detach()
            }
        }

        @Test func new_image_reuses_keychain_password_after_relocation() throws {
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
                #expect(try moved.create(size: "50m") == pw, "le mot de passe existant est repris")
                #expect(moved.password == pw)
                _ = try old.attach()
                old.detach()
            }
        }

        @Test func schedule_decisions() throws {
            var s = CairnConfig.Schedule()
            s.frequency = .daily
            s.time = "12:00"
            let cal = Calendar(identifier: .gregorian)
            let at = { (str: String) in BackupEngine.date(ofVersion: str)! }
            #expect(BackupSchedule.decide(s, lastSuccess: at("2026-11-07T120500"), now: at("2026-11-08T110000"), running: false, power: .ac, reachable: true, calendar: cal) == .notDue)
            #expect(BackupSchedule.decide(s, lastSuccess: at("2026-11-07T120500"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .run, "échéance de midi manquée → rattrapage")
            #expect(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: true, power: .ac, reachable: true, calendar: cal) == .alreadyRunning)
            #expect(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: false,
                                          power: .init(onBattery: true, percent: 15, lowPowerMode: false), reachable: true, calendar: cal) == .waitingPower)
            #expect(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: false, power: .ac, reachable: false, calendar: cal) == .waitingDestination)
            #expect(BackupSchedule.decide(s, lastSuccess: nil, lastFailure: at("2026-11-08T144000"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .retryLater, "échec il y a 20 min → pas de relance")
            #expect(BackupSchedule.decide(s, lastSuccess: nil, lastFailure: at("2026-11-08T135000"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .run, "échec il y a plus d'une heure → relance")
            #expect(BackupSchedule.decide(s, lastSuccess: at("2026-11-07T120500"), lastFailure: at("2026-11-06T120500"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .run, "échec antérieur à la dernière réussite → pas de délai")
            var w = s
            w.frequency = .weekly
            w.weekday = "monday" // 2026-11-09 est un lundi
            #expect(BackupSchedule.decide(w, lastSuccess: at("2026-11-02T130000"), now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .notDue)
            #expect(BackupSchedule.decide(w, lastSuccess: at("2026-11-02T130000"), now: at("2026-11-09T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .run)
            s.frequency = .manual
            #expect(BackupSchedule.decide(s, lastSuccess: nil, now: at("2026-11-08T150000"), running: false, power: .ac, reachable: true, calendar: cal) == .manual)
        }

        @Test func overdue_notification_after_one_day_once_per_day() {
            var s = CairnConfig.Schedule()
            s.time = "12:00"
            let cal = Calendar(identifier: .gregorian)
            let at = { (str: String) in BackupEngine.date(ofVersion: str)! }
            let last = at("2026-11-06T120500")
            #expect(!BackupSchedule.shouldNotifyOverdue(s, lastSuccess: last, lastNotice: nil, now: at("2026-11-07T150000"), calendar: cal), "3 h de retard : pas de notification")
            #expect(BackupSchedule.shouldNotifyOverdue(s, lastSuccess: last, lastNotice: nil, now: at("2026-11-08T180000"), calendar: cal), "30 h de retard")
            #expect(!BackupSchedule.shouldNotifyOverdue(s, lastSuccess: last, lastNotice: at("2026-11-08T100000"), now: at("2026-11-08T180000"), calendar: cal), "une par jour au plus")
        }

        @Test(.globalState) func cli_backup_refused_while_locked_and_dry_run_is_safe() throws {
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
                #expect(dry == .ok, "\(out)")
                #expect(!FileManager.default.fileExists(atPath: BackupEngine.versionsDir(root: dest).appendingPathComponent("latest").path))
                let lock = OperationLock(url: paths.operationLock)
                try lock.acquire(operation: "app backup")
                var err = ""
                let busy = CLI.run(["cairn", "backup", "--only", "folders", "--config", cfg, "--lang", "en-US"], out: { _ in }, err: { err += $0 })
                #expect(busy == .failure)
                #expect(err.contains("already running"), "\(err)")
                lock.release()
                let ok = CLI.run(["cairn", "backup", "--only", "folders", "--config", cfg], out: { _ in }, err: { _ in })
                #expect(ok == .ok)
                #expect(CLI.run(["cairn", "verify", "--full", "--config", cfg], out: { _ in }, err: { _ in }) == .ok)
            }
        }

        @Test func dry_run_creates_nothing_on_destination() throws {
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
                    #expect(r1.first?.error == nil, "\(name): \(String(describing: r1.first?.error))")
                    #expect(r1.first?.outcome?.totalBytes == 50_000, "\(name)")
                    #expect(!fm.fileExists(atPath: dest.path), "\(name) : la simulation ne crée pas le dossier")
                    // Dossier vide : ni image, ni dossier des versions.
                    try fm.createDirectory(at: dest, withIntermediateDirectories: true)
                    let r2 = try BackupService(paths: paths, config: c).run(req)
                    #expect(r2.first?.error == nil, "\(name): \(String(describing: r2.first?.error))")
                    #expect(try fm.contentsOfDirectory(atPath: dest.path) == [], "\(name) : rien d'écrit")
                }
            }
        }

        @Test func next_destination_copies_while_the_previous_one_finishes() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src")
                // Un gros fichier : ses empreintes (finalisation de « a ») prennent le temps de voir la copie vers « b » partir.
                try writeFile(src.appendingPathComponent("big.bin"), size: 150_000_000)
                try writeFile(src.appendingPathComponent("small.txt"), size: 10)
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                var c = CairnConfig()
                c.folders = [.init(path: src.path)]
                c.destinations = ["a", "b"].map {
                    .init(id: $0, provider: .local, path: dir.appendingPathComponent("dest-\($0)").path, encrypted: false)
                }
                var req = BackupService.Request()
                req.only = [.folder]
                final class Events: @unchecked Sendable { var all: [(String, BackupProgress)] = []; let lock = NSLock() }
                let events = Events()
                let r = try BackupService(paths: paths, config: c).run(req) { d, p in events.lock.withLock { events.all.append((d, p)) } }
                #expect(r.map(\.destination) == ["a", "b"])
                #expect(r.allSatisfy { $0.error == nil }, "\(r.map(\.error))")
                let all = events.all
                // Chaque destination annonce sa fin ; la copie vers « b » commence avant la fin de « a ».
                let aDone = try #require(all.firstIndex { $0.0 == "a" && $0.1.finished }, "fin de a")
                let bCopy = all.firstIndex { $0.0 == "b" && !$0.1.part.isEmpty && $0.1.finishing == nil }
                #expect(all.contains { $0.0 == "b" && $0.1.finished }, "fin de chaque destination")
                #expect(bCopy.map { $0 < aDone } ?? false, "copie vers b pendant la finalisation de a")
                let state = RunState.load(paths)
                #expect(state["a"].lastSuccess != nil && state["b"].lastSuccess != nil, "état des deux destinations")
            }
        }

        @Test func unreachable_destination_is_not_a_failure() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src")
                try writeFile(src.appendingPathComponent("a.bin"), size: 1000)
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                var c = CairnConfig()
                c.folders = [.init(path: src.path)]
                c.destinations = [.init(id: "usb", provider: .local, path: "/Volumes/cairn-absent-\(UUID().uuidString)/dest", encrypted: false)]
                var req = BackupService.Request()
                req.only = [.folder]
                let r = try BackupService(paths: paths, config: c).run(req)
                #expect(r.first?.waiting == true)
                let ds = RunState.load(paths)["usb"]
                #expect(ds.lastAttempt != nil)
                #expect(ds.lastFailure == nil, "une destination injoignable n'est pas un échec")
                // Le disque revient : la sauvegarde due repart tout de suite, sans le délai d'après échec.
                let decision = BackupSchedule.decide(c.schedule, lastSuccess: ds.lastSuccess, lastFailure: ds.lastFailure,
                                                     now: Date(), running: false, power: .ac, reachable: true)
                #expect(decision == (c.schedule.frequency == .manual ? .manual : .run))
            }
        }

        @Test func partial_version_does_not_break_links_retention_or_restore() throws {
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
                #expect(BackupEngine.isPartial(versions.appendingPathComponent(v2.version!)))
                #expect(try FileManager.default.destinationOfSymbolicLink(atPath: versions.appendingPathComponent("latest").path) == v1.version!, "une version partielle ne devient pas « latest »")
                #expect(BackupEngine.versions(in: versions) == [v1.version!, v2.version!], "la partielle ne compte pas dans la rétention")
                let all = RestoreSource.versions(onDestinationRoot: dest)
                #expect(RestoreSource.defaultVersion(all, machine: "m")?.lastPathComponent == v1.version!, "restauration : dernière version complète")
                let v3 = try e.run(parts: [folder, aiPart], root: dest, retention: .count(1), dryRun: false, machine: "m", now: date("2026-11-03T120000"))
                #expect(v3.filesTransferred == 0, "les dossiers sont liés à v1, pas recopiés")
                #expect(BackupEngine.versions(in: versions) == [v3.version!], "v1 hors rétention, v2 remplacée par une version complète")
                let sums = Integrity.read(versions.appendingPathComponent(v3.version!))
                #expect(sums.keys.filter { $0.hasPrefix("folders/src/") }.count == 10)
            }
        }

        @Test func logs_of_kept_versions_are_spared() throws {
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
                #expect(BackupEngine.versions(in: versions).count == 1)
                #expect(kept == Set(BackupEngine.logs(in: versions)))
                #expect(kept.count == 1)
                // Les deux journaux ont 200 jours : seul celui de la version gardée reste.
                let fm = FileManager.default
                let old = Date().addingTimeInterval(-200 * 86_400)
                let logs = try fm.contentsOfDirectory(atPath: paths.logs.path).filter { $0.hasPrefix("backup-") }
                #expect(logs.count == 2)
                for l in logs { try fm.setAttributes([.modificationDate: old], ofItemAtPath: paths.logs.appendingPathComponent(l).path) }
                let removed = LogJanitor.prune(paths: paths, retentionDays: 90, keep: kept)
                #expect(removed.count == 1)
                #expect(fm.fileExists(atPath: paths.logs.appendingPathComponent(try #require(kept.first)).path))
            }
        }

        @Test func restore_opens_image_of_another_mac_with_typed_password() throws {
            try withTempDir { dir in
                let dest = dir.appendingPathComponent("dest")
                try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
                let id = "selftest-\(UUID().uuidString)"
                let old = SparseImage(root: dest, destinationID: id, encrypted: true, machine: "OldMac")
                let pw = try #require(try old.create(size: "100m"))
                let mp = try old.attach()
                try writeFile(mp.appendingPathComponent("cairn/OldMac/versions/2026-11-01T100000/home/.zshrc"), size: 10)
                old.detach()
                Keychain.deletePassword(service: old.keychainService, account: "OldMac")   // Mac neuf : Trousseau vide
                let d = CairnConfig.Destination(id: id, provider: .local, path: dest.path, encrypted: true)
                let s1 = DestinationSession(d)
                let error = #expect(throws: ProviderError.self, "le mot de passe aurait dû être demandé") {
                    _ = try s1.open(createIfMissing: false)
                }
                s1.close()
                guard case .missingImagePassword? = error else {
                    Issue.record("ProviderError.missingImagePassword attendu : \(String(describing: error))")
                    return
                }
                #expect(SparseImage.images(at: dest).count == 1, "aucune image créée pour ce Mac")
                let s2 = DestinationSession(d)
                s2.imagePassword = pw
                let root = try s2.open(createIfMissing: false)
                defer { s2.close() }
                #expect(RestoreSource.versions(onDestinationRoot: root).map(\.machine) == ["OldMac"])
            }
        }

        @Test func dry_run_after_a_backup_lists_only_changes() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                for i in 0..<5 { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 10_000) }
                let part = BackupPart(kind: .folder, target: "folders/src", source: src.path)
                let e = BackupEngine()
                _ = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: false, machine: "m", now: date("2026-11-01T120000"))
                try writeFile(src.appendingPathComponent("new.bin"), size: 1234)
                let before = try FileManager.default.subpathsOfDirectory(atPath: dest.path).sorted()
                let sim = try e.run(parts: [part], root: dest, retention: .recommended, dryRun: true, machine: "m", now: date("2026-11-02T120000"))
                #expect(sim.filesTransferred == 1)
                #expect(sim.bytesTransferred == 1234)
                #expect(try FileManager.default.subpathsOfDirectory(atPath: dest.path).sorted() == before, "rien d'écrit")
            }
        }
    }
}

/// Version interrompue récente (reprise par la prochaine sauvegarde), pour la machine « m ».
private func incompleteVersion(_ dest: URL) throws -> URL {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = BackupEngine.versionFormat
    let work = BackupEngine.versionsDir(root: dest, machine: "m")
        .appendingPathComponent(BackupEngine.incompletePrefix + f.string(from: Date().addingTimeInterval(-60)))
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    return work
}
