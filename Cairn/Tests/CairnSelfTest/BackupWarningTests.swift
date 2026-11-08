import CairnCore
import Foundation

private func cli(_ args: [String]) -> (CLI.Exit, String, String) {
    var out = "", err = ""
    let code = CLI.run(["cairn"] + args + ["--lang", "en-US"], out: { out += $0 + "\n" }, err: { err += $0 + "\n" })
    return (code, out, err)
}

private func json(_ s: String) throws -> [String: Any] {
    guard let obj = try JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else {
        throw TestFailure(message: "JSON invalide : \(s)", file: #filePath, line: #line)
    }
    return obj
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

let backupWarningTests: [TestCase] = [
    TestCase("manifest_records_cairn_version") {
        try withTempDir { dir in
            let (paths, _, dest, _) = try setup(dir)
            let r = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            let v = try expectValue(r.first?.outcome?.version)
            let data = try Data(contentsOf: BackupEngine.versionsDir(root: dest).appendingPathComponent(v).appendingPathComponent("manifest.json"))
            let m = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            try expectEqual(m?["cairn"] as? String, CairnVersion.current)
            try expect(CairnVersion.current != "1" && !CairnVersion.current.isEmpty)
        }
    },
    TestCase("result_exposes_log_and_monthly_damage") {
        try withTempDir { dir in
            let (paths, _, dest, _) = try setup(dir)
            let versions = BackupEngine.versionsDir(root: dest)
            let r1 = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            let log = try expectValue(r1.first?.log)
            try expect(FileManager.default.fileExists(atPath: log.path), "le journal existe")
            try expect(r1.first?.damagedFiles.isEmpty == true)
            try expect(r1.first?.imageCheck == nil, "pas d'image sur une destination locale non chiffrée")
            // Fichier abîmé dans v1 : v2 le reprend par lien physique ; la vérification mensuelle le trouve.
            try corrupt(versions.appendingPathComponent(r1[0].outcome!.version!).appendingPathComponent("folders/src/f1.bin"))
            var state = RunState.load(paths)
            state.destinations["local"]?.lastVerification = nil
            try state.save(paths)
            Thread.sleep(forTimeInterval: 1.1)
            let r2 = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            try expectEqual(r2.first?.damagedFiles, ["folders/src/f1.bin"])
            let v2 = r2[0].outcome!.version!
            try expectEqual(RunState.load(paths)["local"].damagedVersions, [v2])
            // Sauvegarde suivante : le fichier est recopié depuis la source, l'état est vidé (point 13).
            Thread.sleep(forTimeInterval: 1.1)
            let r3 = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            try expect(r3.first?.error == nil, String(describing: r3.first?.error))
            try expectEqual(RunState.load(paths)["local"].damagedVersions, [], "fichiers abîmés recopiés : état vidé")
            let v3 = versions.appendingPathComponent(r3[0].outcome!.version!)
            try expect(Integrity.verify(version: v3, full: true).damaged.isEmpty)
        }
    },
    TestCase("still_damaged_keeps_unrepaired_versions_once") {
        try withTempDir { dir in
            let fm = FileManager.default
            for v in ["2026-11-01T120000", "2026-11-02T120000"] {
                try fm.createDirectory(at: dir.appendingPathComponent(v), withIntermediateDirectories: true)
                try "folders/a/x.bin\n".write(to: dir.appendingPathComponent(v).appendingPathComponent("damaged.tsv"), atomically: true, encoding: .utf8)
            }
            let damaged = ["2026-11-01T120000", "2026-11-02T120000", "2026-11-02T120000", "2026-10-01T120000"]
            try expectEqual(BackupService.stillDamaged(damaged, versionsDir: dir, recopied: [:]),
                            ["2026-11-01T120000", "2026-11-02T120000"], "doublon et version supprimée retirés")
            try expectEqual(BackupService.stillDamaged(damaged, versionsDir: dir, recopied: ["folders/a": ["x.bin"]]), [])
        }
    },
    TestCase("cli_verify_writes_state_and_json") {
        try withTempDir { dir in
            let (paths, _, dest, cfg) = try setup(dir)
            _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            let v = BackupEngine.versions(in: BackupEngine.versionsDir(root: dest)).last!
            try corrupt(BackupEngine.versionsDir(root: dest).appendingPathComponent(v).appendingPathComponent("folders/src/f0.bin"))
            var state = RunState.load(paths)
            state.destinations["local"]?.lastVerification = nil
            try state.save(paths)
            let (code, out, _) = cli(["verify", "--full", "--json", "--yes", "--config", cfg])
            try expectEqual(code, .failure, "fichier abîmé → code 1")
            let results = try json(out)["results"] as? [[String: Any]]
            try expectEqual(results?.first?["version"] as? String, v)
            try expectEqual(results?.first?["damaged"] as? [String], ["folders/src/f0.bin"])
            try expect((results?.first?["checked"] as? Int ?? 0) >= 3)
            let ds = RunState.load(paths)["local"]
            try expect(ds.lastVerification != nil, "cairn verify note la vérification")
            try expectEqual(ds.damagedVersions, [v])
            // Deuxième passage : pas de doublon.
            _ = cli(["verify", "--full", "--config", cfg])
            try expectEqual(RunState.load(paths)["local"].damagedVersions, [v])
        }
    },
    TestCase("cli_verify_unknown_version_is_usage_error") {
        try withTempDir { dir in
            let (paths, _, _, cfg) = try setup(dir)
            _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            let (code, _, err) = cli(["verify", "--version", "1999-01-01T000000", "--config", cfg])
            try expectEqual(code, .usage)
            try expect(err.contains("Unknown version"), err)
        }
    },
    TestCase("cli_verify_refused_while_locked") {
        try withTempDir { dir in
            let (paths, _, _, cfg) = try setup(dir)
            _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            let lock = OperationLock(url: paths.operationLock)
            try lock.acquire(operation: "backup")
            defer { lock.release() }
            let (code, _, err) = cli(["verify", "--config", cfg])
            try expectEqual(code, .failure)
            try expect(err.contains("already running"), err)
        }
    },
    TestCase("cli_backup_unknown_tool_is_usage_error") {
        try withTempDir { dir in
            let (_, _, dest, cfg) = try setup(dir)
            let (code, _, err) = cli(["backup", "--tool", "no-such-tool", "--config", cfg])
            try expectEqual(code, .usage)
            try expect(err.contains("no-such-tool"), err)
            try expect(!FileManager.default.fileExists(atPath: dest.path), "rien n'est lancé")
        }
    },
    TestCase("yes_is_accepted_everywhere") {
        try withTempDir { dir in
            let (_, src, _, cfg) = try setup(dir)
            try expectEqual(cli(["backup", "--dry-run", "--only", "folders", "--yes", "--json", "--config", cfg]).0, .ok)
            try expectEqual(cli(["analyze", src.path, "--yes", "--json"]).0, .ok)
            try expectEqual(cli(["ai", "--yes", "--json", "--config", cfg]).0, .ok)
            try expectEqual(cli(["config", "path", "--yes", "--config", cfg]).0, .ok)
            try expectEqual(cli(["ai", "--bogus", "--config", cfg]).0, .usage, "option inconnue toujours refusée")
        }
    },
    TestCase("cli_config_json") {
        try withTempDir { dir in
            let (_, src, _, cfg) = try setup(dir)
            let (c1, o1, _) = cli(["config", "path", "--json", "--config", cfg])
            try expectEqual(c1, .ok)
            try expectEqual(try json(o1)["path"] as? String, cfg)
            let (c2, o2, _) = cli(["config", "show", "--json", "--config", cfg])
            try expectEqual(c2, .ok)
            let conf = try json(o2)["config"] as? [String: Any]
            try expectEqual((conf?["folders"] as? [[String: Any]])?.first?["path"] as? String, src.path)
            let dest = (conf?["destinations"] as? [[String: Any]])?.first
            try expectEqual(dest?["id"] as? String, "local")
            try expectEqual((dest?["retention"] as? [String: Any])?["kind"] as? String, "tiered")
            let (c3, o3, _) = cli(["config", "validate", "--json", "--config", cfg])
            try expectEqual(c3, .ok)
            try expectEqual(try json(o3)["valid"] as? Bool, true)
            let (c4, o4, _) = cli(["config", "validate", "--json", "--config", dir.appendingPathComponent("none.toml").path])
            try expectEqual(c4, .usage)
            try expectEqual(try json(o4)["exists"] as? Bool, false)
        }
    },
    TestCase("cli_restore_json") {
        try withTempDir { dir in
            let (paths, _, dest, _) = try setup(dir)
            _ = try BackupService(paths: paths, config: try config(paths)).run(BackupService.Request())
            let v = BackupEngine.versionsDir(root: dest).appendingPathComponent(BackupEngine.versions(in: BackupEngine.versionsDir(root: dest)).last!)
            let target = dir.appendingPathComponent("restored")
            let (code, out, _) = cli(["restore", "--from", v.path, "--parts", "folders", "--target", "src=\(target.path)", "--json"])
            try expectEqual(code, .ok, out)
            let obj = try json(out)
            try expectEqual(obj["apply"] as? Bool, false)
            try expectEqual((obj["source"] as? [String: Any])?["kind"] as? String, "cairn")
            try expect((obj["source"] as? [String: Any])?["date"] is String, "date ISO 8601")
            try expect(((obj["bytes_by_part"] as? [String: Any])?["folders/src"] as? Int ?? 0) > 0)
            try expect(obj["steps"] is [[String: Any]])
            try expect(((try? FileManager.default.contentsOfDirectory(atPath: target.path)) ?? []).isEmpty, "simulation : aucun fichier restauré")
            let (c2, o2, _) = cli(["restore", "--from", v.path, "--check", "--json"])
            try expectEqual(c2, .ok)
            let checked = try json(o2)
            try expect(checked["check"] is [String: Any])
        }
    },
    TestCase("retention_shortening_detection") {
        try expect(RetentionPolicy.mayDeleteMore(.count(5), than: .count(12)))
        try expect(!RetentionPolicy.mayDeleteMore(.count(20), than: .count(12)))
        try expect(RetentionPolicy.mayDeleteMore(.tiered(days: 14, weeks: 48), than: .recommended), "moins de jours")
        try expect(RetentionPolicy.mayDeleteMore(.tiered(days: 30, weeks: 10), than: .recommended), "moins de semaines")
        try expect(!RetentionPolicy.mayDeleteMore(.tiered(days: 60, weeks: 48), than: .recommended))
        try expect(RetentionPolicy.mayDeleteMore(.count(1000), than: .recommended), "changement de type : prudence")
    },
    TestCase("sparse_image_verify") {
        try withTempDir { dir in
            let img = SparseImage(root: dir, destinationID: "selftest-\(UUID().uuidString)", encrypted: false, machine: "m")
            try img.create(size: "50m")
            try expect(img.verify().ok, img.verify().output)
            let enc = SparseImage(root: dir.appendingPathComponent("e"), destinationID: "selftest-\(UUID().uuidString)", encrypted: true, machine: "m")
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("e"), withIntermediateDirectories: true)
            defer { Keychain.deletePassword(service: enc.keychainService, account: "m") }
            let pw = try enc.create(size: "50m")
            try expect(enc.verify().ok, "mot de passe du Trousseau : \(enc.verify().output)")
            try expect(enc.verify(password: pw).ok)
            try expect(!enc.verify(password: "wrong-password").ok, "mauvais mot de passe : échec")
            // Image abîmée : sa description a disparu.
            try FileManager.default.removeItem(atPath: img.path + "/Info.plist")
            try FileManager.default.removeItem(atPath: img.path + "/Info.bckup")
            try expect(!img.verify().ok, "image abîmée : échec")
        }
    },
    TestCase("encrypted_destination_monthly_check_verifies_image") {
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
            try expect(r.first?.error == nil, String(describing: r.first?.error))
            try expectEqual(r.first?.imageCheck?.ok, true, r.first?.imageCheck?.output ?? "pas de contrôle")
            let ds = RunState.load(paths)[id]
            try expect(ds.lastImageCheck != nil && ds.lastImageCheckOK == true)
            let log = try String(contentsOf: r[0].log!, encoding: .utf8)
            try expect(log.contains("image verify ok"), log)
        }
    },
    TestCase("wait_until_finished_after_cancel") {
        try withTempDir { dir in
            let (paths, _, _, _) = try setup(dir, files: 50)
            let service = BackupService(paths: paths, config: try config(paths))
            try expect(service.waitUntilFinished(timeout: 0.1), "rien en cours")
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                _ = try? service.run(BackupService.Request())
                done.signal()
            }
            Thread.sleep(forTimeInterval: 0.2)
            service.cancel()
            try expect(service.waitUntilFinished(timeout: 20), "la sauvegarde s'arrête")
            try expect(!service.isRunning)
            // Le verrou est rendu : une autre opération peut le prendre.
            let lock = OperationLock(url: paths.operationLock)
            try lock.acquire(operation: "test")
            lock.release()
            _ = done.wait(timeout: .now() + 5)
        }
    },
]

private func expectValue<T>(_ v: T?, file: String = #filePath, line: UInt = #line) throws -> T {
    guard let v else { throw TestFailure(message: "valeur absente", file: file, line: line) }
    return v
}
