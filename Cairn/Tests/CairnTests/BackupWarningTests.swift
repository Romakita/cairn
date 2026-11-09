import CairnCore
import Foundation
import Testing

private func cli(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args + ["--lang", "en-US"], out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

private func json(_ s: String) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], "JSON invalide : \(s)")
}

/// Configuration de test : un dossier source et une destination locale non chiffrée.
private func setup(_ dir: URL, files: Int = 3) throws -> (CairnPaths, URL, URL, String) {
    let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
    for i in 0..<files { try writeFile(src.appendingPathComponent("f\(i).bin"), size: 10_000 + i) }
    let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
    var c = CairnConfig()
    c.folders = [.init(path: src.path)]
    c.destinations = [.init(id: "local", provider: .local, path: dest.path, encrypted: false)]
    try ConfigStore(paths: paths).save(c)
    return (paths, src, dest, paths.config.path)
}

/// Abîme un fichier d'une version sans changer sa taille ni sa date.
private func corrupt(_ file: URL) throws {
    let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
    let size = (attrs[.size] as? Int) ?? 0
    try Data(repeating: 7, count: size).write(to: file)
    try FileManager.default.setAttributes([.modificationDate: attrs[.modificationDate]!], ofItemAtPath: file.path)
}

private var config: (CairnPaths) throws -> CairnConfig = { try ConfigStore(paths: $0).load().config }

extension CairnTests {
    @Suite struct BackupWarningTests {
        @Test func manifest_records_cairn_version() throws {
            try withTempDir { dir in
                let (paths, _, dest, _) = try setup(dir)
                let r = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                let v = try #require(r.first?.outcome?.version)
                let data = try Data(contentsOf: BackupEngine.versionsDir(root: dest).appendingPathComponent(v).appendingPathComponent("manifest.json"))
                let m = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                #expect(m?["cairn"] as? String == CairnVersion.current)
                #expect(CairnVersion.current != "1" && !CairnVersion.current.isEmpty)
            }
        }

        @Test func result_exposes_log_and_monthly_damage() throws {
            try withTempDir { dir in
                let (paths, _, dest, _) = try setup(dir)
                let versions = BackupEngine.versionsDir(root: dest)
                let r1 = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                let log = try #require(r1.first?.log)
                #expect(FileManager.default.fileExists(atPath: log.path), "le journal existe")
                #expect(r1.first?.damagedFiles.isEmpty == true)
                #expect(r1.first?.imageCheck == nil, "pas d'image sur une destination locale non chiffrée")
                // Fichier abîmé dans v1 : v2 le reprend par lien physique ; la vérification mensuelle le trouve.
                try corrupt(versions.appendingPathComponent(r1[0].outcome!.version!).appendingPathComponent("folders/src/f1.bin"))
                var state = RunState.load(paths)
                state.destinations["local"]?.lastVerification = nil
                try state.save(paths)
                Thread.sleep(forTimeInterval: 1.1)
                let r2 = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                #expect(r2.first?.damagedFiles == ["folders/src/f1.bin"])
                let v2 = r2[0].outcome!.version!
                #expect(RunState.load(paths)["local"].damagedVersions == [v2])
                // Sauvegarde suivante : le fichier est recopié depuis la source, l'état est vidé (point 13).
                Thread.sleep(forTimeInterval: 1.1)
                let r3 = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                #expect(r3.first?.error == nil, "\(String(describing: r3.first?.error))")
                #expect(RunState.load(paths)["local"].damagedVersions == [], "fichiers abîmés recopiés : état vidé")
                let v3 = versions.appendingPathComponent(r3[0].outcome!.version!)
                #expect(Integrity.verify(version: v3, full: true).damaged.isEmpty)
            }
        }

        @Test func still_damaged_keeps_unrepaired_versions_once() throws {
            try withTempDir { dir in
                let fm = FileManager.default
                for v in ["2026-11-01T120000", "2026-11-02T120000"] {
                    try fm.createDirectory(at: dir.appendingPathComponent(v), withIntermediateDirectories: true)
                    try "folders/a/x.bin\n".write(to: dir.appendingPathComponent(v).appendingPathComponent("damaged.tsv"), atomically: true, encoding: .utf8)
                }
                let damaged = ["2026-11-01T120000", "2026-11-02T120000", "2026-11-02T120000", "2026-10-01T120000"]
                #expect(BackupService.stillDamaged(damaged, versionsDir: dir, recopied: [:]) == ["2026-11-01T120000", "2026-11-02T120000"], "doublon et version supprimée retirés")
                #expect(BackupService.stillDamaged(damaged, versionsDir: dir, recopied: ["folders/a": ["x.bin"]]) == [])
            }
        }

        @Test(.globalState) func cli_verify_writes_state_and_json() throws {
            try withTempDir { dir in
                let (paths, _, dest, cfg) = try setup(dir)
                _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                let v = BackupEngine.versions(in: BackupEngine.versionsDir(root: dest)).last!
                try corrupt(BackupEngine.versionsDir(root: dest).appendingPathComponent(v).appendingPathComponent("folders/src/f0.bin"))
                var state = RunState.load(paths)
                state.destinations["local"]?.lastVerification = nil
                try state.save(paths)
                let (code, out, _) = cli(["verify", "--full", "--json", "--yes", "--config", cfg])
                #expect(code == .failure, "fichier abîmé → code 1")
                let results = try json(out)["results"] as? [[String: Any]]
                #expect(results?.first?["version"] as? String == v)
                #expect(results?.first?["damaged"] as? [String] == ["folders/src/f0.bin"])
                #expect((results?.first?["checked"] as? Int ?? 0) >= 3)
                let ds = RunState.load(paths)["local"]
                #expect(ds.lastVerification != nil, "cairn verify note la vérification")
                #expect(ds.damagedVersions == [v])
                // Deuxième passage : pas de doublon.
                _ = cli(["verify", "--full", "--config", cfg])
                #expect(RunState.load(paths)["local"].damagedVersions == [v])
            }
        }

        @Test(.globalState) func cli_verify_unknown_version_is_usage_error() throws {
            try withTempDir { dir in
                let (paths, _, _, cfg) = try setup(dir)
                _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                let (code, _, err) = cli(["verify", "--version", "1999-01-01T000000", "--config", cfg])
                #expect(code == .usage)
                #expect(err.contains("Unknown version"), "\(err)")
            }
        }

        @Test(.globalState) func cli_verify_refused_while_locked() throws {
            try withTempDir { dir in
                let (paths, _, _, cfg) = try setup(dir)
                _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                let lock = OperationLock(url: paths.operationLock)
                try lock.acquire(operation: "backup")
                defer { lock.release() }
                let (code, _, err) = cli(["verify", "--config", cfg])
                #expect(code == .failure)
                #expect(err.contains("already running"), "\(err)")
            }
        }

        @Test(.globalState) func cli_backup_unknown_tool_is_usage_error() throws {
            try withTempDir { dir in
                let (_, _, dest, cfg) = try setup(dir)
                let (code, _, err) = cli(["backup", "--tool", "no-such-tool", "--config", cfg])
                #expect(code == .usage)
                #expect(err.contains("no-such-tool"), "\(err)")
                #expect(!FileManager.default.fileExists(atPath: dest.path), "rien n'est lancé")
            }
        }

        @Test(.globalState) func yes_is_accepted_everywhere() throws {
            try withTempDir { dir in
                let (_, src, _, cfg) = try setup(dir)
                #expect(cli(["backup", "--dry-run", "--only", "folders", "--yes", "--json", "--config", cfg]).0 == .ok)
                #expect(cli(["analyze", src.path, "--yes", "--json"]).0 == .ok)
                #expect(cli(["ai", "--yes", "--json", "--config", cfg]).0 == .ok)
                #expect(cli(["config", "path", "--yes", "--config", cfg]).0 == .ok)
                #expect(cli(["ai", "--bogus", "--config", cfg]).0 == .usage, "option inconnue toujours refusée")
            }
        }

        @Test(.globalState) func cli_config_json() throws {
            try withTempDir { dir in
                let (_, src, _, cfg) = try setup(dir)
                let (c1, o1, _) = cli(["config", "path", "--json", "--config", cfg])
                #expect(c1 == .ok)
                #expect(try json(o1)["path"] as? String == cfg)
                let (c2, o2, _) = cli(["config", "show", "--json", "--config", cfg])
                #expect(c2 == .ok)
                let conf = try json(o2)["config"] as? [String: Any]
                #expect((conf?["folders"] as? [[String: Any]])?.first?["path"] as? String == src.path)
                let dest = (conf?["destinations"] as? [[String: Any]])?.first
                #expect(dest?["id"] as? String == "local")
                #expect((dest?["retention"] as? [String: Any])?["kind"] as? String == "tiered")
                let (c3, o3, _) = cli(["config", "validate", "--json", "--config", cfg])
                #expect(c3 == .ok)
                #expect(try json(o3)["valid"] as? Bool == true)
                let (c4, o4, _) = cli(["config", "validate", "--json", "--config", dir.appendingPathComponent("none.toml").path])
                #expect(c4 == .usage)
                #expect(try json(o4)["exists"] as? Bool == false)
            }
        }

        @Test(.globalState) func cli_restore_json() throws {
            try withTempDir { dir in
                let (paths, _, dest, _) = try setup(dir)
                _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
                let v = BackupEngine.versionsDir(root: dest).appendingPathComponent(BackupEngine.versions(in: BackupEngine.versionsDir(root: dest)).last!)
                let target = dir.appendingPathComponent("restored")
                let (code, out, _) = cli(["restore", "--from", v.path, "--parts", "folders", "--target", "src=\(target.path)", "--json"])
                #expect(code == .ok, "\(out)")
                let obj = try json(out)
                #expect(obj["apply"] as? Bool == false)
                #expect((obj["source"] as? [String: Any])?["kind"] as? String == "cairn")
                #expect((obj["source"] as? [String: Any])?["date"] is String, "date ISO 8601")
                #expect(((obj["bytes_by_part"] as? [String: Any])?["folders/src"] as? Int ?? 0) > 0)
                #expect(obj["steps"] is [[String: Any]])
                #expect(((try? FileManager.default.contentsOfDirectory(atPath: target.path)) ?? []).isEmpty, "simulation : aucun fichier restauré")
                let (c2, o2, _) = cli(["restore", "--from", v.path, "--check", "--json"])
                #expect(c2 == .ok)
                let checked = try json(o2)
                #expect(checked["check"] is [String: Any])
            }
        }

        @Test func retention_shortening_detection() {
            #expect(RetentionPolicy.mayDeleteMore(.count(5), than: .count(12)))
            #expect(!RetentionPolicy.mayDeleteMore(.count(20), than: .count(12)))
            #expect(RetentionPolicy.mayDeleteMore(.tiered(days: 14, weeks: 48), than: .recommended), "moins de jours")
            #expect(RetentionPolicy.mayDeleteMore(.tiered(days: 30, weeks: 10), than: .recommended), "moins de semaines")
            #expect(!RetentionPolicy.mayDeleteMore(.tiered(days: 60, weeks: 48), than: .recommended))
            #expect(RetentionPolicy.mayDeleteMore(.count(1000), than: .recommended), "changement de type : prudence")
        }

        @Test func sparse_image_verify() throws {
            try withTempDir { dir in
                let img = SparseImage(root: dir, destinationID: "selftest-\(UUID().uuidString)", encrypted: false, machine: "m")
                try img.create(size: "50m")
                #expect(img.verify().ok, "\(img.verify().output)")
                let enc = SparseImage(root: dir.appendingPathComponent("e"), destinationID: "selftest-\(UUID().uuidString)", encrypted: true, machine: "m")
                try FileManager.default.createDirectory(at: dir.appendingPathComponent("e"), withIntermediateDirectories: true)
                defer { Keychain.deletePassword(service: enc.keychainService, account: "m") }
                let pw = try enc.create(size: "50m")
                #expect(enc.verify().ok, "mot de passe du Trousseau : \(enc.verify().output)")
                #expect(enc.verify(password: pw).ok)
                #expect(!enc.verify(password: "wrong-password").ok, "mauvais mot de passe : échec")
                // Image abîmée : sa description a disparu.
                try FileManager.default.removeItem(atPath: img.path + "/Info.plist")
                try FileManager.default.removeItem(atPath: img.path + "/Info.bckup")
                #expect(!img.verify().ok, "image abîmée : échec")
            }
        }

        @Test func encrypted_destination_monthly_check_verifies_image() throws {
            try withTempDir { dir in
                let src = dir.appendingPathComponent("src"), dest = dir.appendingPathComponent("dest")
                try writeFile(src.appendingPathComponent("a.bin"), size: 1000)
                try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                let id = "selftest-\(UUID().uuidString)"
                var c = CairnConfig()
                c.folders = [.init(path: src.path)]
                c.destinations = [.init(id: id, provider: .local, path: dest.path, encrypted: true)]
                defer { Keychain.deletePassword(service: Keychain.servicePrefix + "image." + id, account: BackupEngine.machineName()) }
                var req = BackupService.Request()
                req.only = [.folder]
                let r = try BackupService(paths: paths, config: c).run(req)
                #expect(r.first?.error == nil, "\(String(describing: r.first?.error))")
                #expect(r.first?.imageCheck?.ok == true, "\(r.first?.imageCheck?.output ?? "pas de contrôle")")
                let ds = RunState.load(paths)[id]
                #expect(ds.lastImageCheck != nil && ds.lastImageCheckOK == true)
                let log = try String(contentsOf: r[0].log!, encoding: .utf8)
                #expect(log.contains("image verify ok"), "\(log)")
            }
        }

        @Test func wait_until_finished_after_cancel() throws {
            try withTempDir { dir in
                let (paths, _, _, _) = try setup(dir, files: 50)
                let service = BackupService(paths: paths, config: try config(paths))
                #expect(service.waitUntilFinished(timeout: 0.1), "rien en cours")
                let done = DispatchSemaphore(value: 0)
                DispatchQueue.global().async {
                    _ = try? service.run(BackupService.Request())
                    done.signal()
                }
                Thread.sleep(forTimeInterval: 0.2)
                service.cancel()
                #expect(service.waitUntilFinished(timeout: 20), "la sauvegarde s'arrête")
                #expect(!service.isRunning)
                // Le verrou est rendu : une autre opération peut le prendre.
                let lock = OperationLock(url: paths.operationLock)
                try lock.acquire(operation: "test")
                lock.release()
                _ = done.wait(timeout: .now() + 5)
            }
        }
    }
}
