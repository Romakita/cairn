import CairnCore
import Foundation

private func visibleNames(_ dir: URL) -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.sorted() ?? []
}

let destinationProbeTests: [TestCase] = [
    // MARK: Vérification d'un dossier local

    TestCase("local_check_succeeds_and_leaves_no_trace") {
        try withTempDir { dir in
            try writeFile(dir.appendingPathComponent("existant.txt"), size: 3)
            guard case let .ok(free, images) = DestinationProbe.checkFolder(dir, machine: "Ce-Mac") else {
                throw TestFailure(message: "vérification en échec", file: #filePath, line: #line)
            }
            try expect((free ?? 0) > 0, "espace libre inconnu")
            try expectEqual(images, [])
            try expectEqual(visibleNames(dir), ["existant.txt"], "le fichier témoin doit être supprimé")
        }
    },
    TestCase("local_check_missing_folder") {
        try withTempDir { dir in
            let missing = dir.appendingPathComponent("absent")
            try expectEqual(DestinationProbe.checkFolder(missing), .failed(.notFound(missing.path)))
            try expect(!FileManager.default.fileExists(atPath: missing.path), "la vérification ne crée rien")
        }
    },
    TestCase("local_check_missing_volume") {
        let path = URL(fileURLWithPath: "/Volumes/cairn-absent-\(UUID().uuidString)/Sauvegardes")
        guard case .failed(.volumeMissing) = DestinationProbe.checkFolder(path) else {
            throw TestFailure(message: "volume absent non détecté", file: #filePath, line: #line)
        }
    },
    TestCase("local_check_read_only_folder") {
        try withTempDir { dir in
            let ro = dir.appendingPathComponent("lecture-seule")
            try FileManager.default.createDirectory(at: ro, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: ro.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ro.path) }
            try expectEqual(DestinationProbe.checkFolder(ro), .failed(.readOnly(ro.path)))
        }
    },
    TestCase("stale_write_test_files_are_removed") {
        try withTempDir { dir in
            let stale = dir.appendingPathComponent(DestinationProbe.writeTestPrefix + UUID().uuidString)
            try Data("cairn".utf8).write(to: stale)
            try writeFile(dir.appendingPathComponent(".autre-fichier-cache"), size: 1)
            _ = DestinationProbe.checkFolder(dir)
            try expectEqual(visibleNames(dir), [".autre-fichier-cache"])
        }
    },
    TestCase("stale_cleanup_never_touches_user_entries") {
        try withTempDir { dir in
            let p = DestinationProbe.writeTestPrefix
            // Dossier au nom de témoin, avec du contenu : ne doit jamais être supprimé.
            let folder = dir.appendingPathComponent(p + UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try writeFile(folder.appendingPathComponent("photo.jpg"), size: 5)
            // Nom sans UUID, ou contenu différent du témoin : fichiers de l'utilisateur.
            try Data("cairn".utf8).write(to: dir.appendingPathComponent(p + "archives"))
            try Data("autre".utf8).write(to: dir.appendingPathComponent(p + UUID().uuidString))
            let before = visibleNames(dir)
            _ = DestinationProbe.checkFolder(dir)
            try expectEqual(visibleNames(dir), before)
            try expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("photo.jpg").path))
        }
    },

    // MARK: Sauvegardes existantes

    TestCase("existing_backups_are_detected") {
        try withTempDir { dir in
            for n in ["cairn-MacBook-Pro.sparsebundle", "cairn-Ce-Mac.sparsebundle", "autre.sparsebundle"] {
                try FileManager.default.createDirectory(at: dir.appendingPathComponent(n), withIntermediateDirectories: true)
            }
            guard case let .ok(_, images) = DestinationProbe.checkFolder(dir, machine: "Ce-Mac") else {
                throw TestFailure(message: "vérification en échec", file: #filePath, line: #line)
            }
            try expectEqual(images.map(\.machine), ["Ce-Mac", "MacBook-Pro"])
            try expectEqual(images.map(\.isThisMac), [true, false])
        }
    },

    // MARK: Parcours

    TestCase("list_folders_filters_and_sorts") {
        try withTempDir { dir in
            for n in ["dossier10", "Dossier2", "dossier1", ".cache", "cairn-Mac.sparsebundle"] {
                try FileManager.default.createDirectory(at: dir.appendingPathComponent(n), withIntermediateDirectories: true)
            }
            try writeFile(dir.appendingPathComponent("fichier.txt"), size: 1)
            let names = try DestinationProbe.listFolders(at: dir).get().map(\.name)
            try expectEqual(names, ["dossier1", "Dossier2", "dossier10"])
        }
    },
    TestCase("list_folders_access_denied") {
        try withTempDir { dir in
            let closed = dir.appendingPathComponent("ferme")
            try FileManager.default.createDirectory(at: closed, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: closed.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: closed.path) }
            try expectEqual(DestinationProbe.listFolders(at: closed).map(\.count), .failure(.accessDenied(closed.path)))
            let missing = dir.appendingPathComponent("absent")
            try expectEqual(DestinationProbe.listFolders(at: missing).map(\.count), .failure(.notFound(missing.path)))
        }
    },
    TestCase("create_folder_valid_and_refused_names") {
        try withTempDir { dir in
            let created = try DestinationProbe.createFolder(named: "  Cairn ", in: dir).get()
            try expectEqual(created.lastPathComponent, "Cairn")
            try expect(FileManager.default.fileExists(atPath: created.path))
            try expectEqual(DestinationProbe.createFolder(named: "Cairn", in: dir).map(\.path), .failure(.invalidName(.exists)))
            try expectEqual(DestinationProbe.createFolder(named: "a/b", in: dir).map(\.path), .failure(.invalidName(.forbiddenCharacter)))
            try expectEqual(DestinationProbe.createFolder(named: "a:b", in: dir).map(\.path), .failure(.invalidName(.forbiddenCharacter)))
            try expectEqual(DestinationProbe.createFolder(named: "   ", in: dir).map(\.path), .failure(.invalidName(.empty)))
            try expectEqual(visibleNames(dir), ["Cairn"], "aucune écriture en cas de refus")
        }
    },
    TestCase("local_roots_skip_system_disk_and_end_with_home") {
        try withTempDir { dir in
            let volumes = dir.appendingPathComponent("Volumes")
            try FileManager.default.createDirectory(at: volumes.appendingPathComponent("Externe"), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: volumes.appendingPathComponent("Archives"), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(atPath: volumes.appendingPathComponent("Macintosh HD").path, withDestinationPath: "/")
            let home = dir.appendingPathComponent("romain")
            let roots = DestinationProbe.localRoots(volumes: volumes, home: home)
            try expectEqual(roots.map(\.name), ["Archives", "Externe", "romain"])
        }
    },

    // MARK: SMB (sans réseau)

    TestCase("smb_mount_codes_are_translated") {
        let share = "smb://nas.local/backups"
        try expectEqual(DestinationProbe.failure(forMountStatus: 80, share: share), .authenticationFailed)
        try expectEqual(DestinationProbe.failure(forMountStatus: 13, share: share), .authenticationFailed)
        try expectEqual(DestinationProbe.failure(forMountStatus: 2, share: share), .notFound(share))
        try expectEqual(DestinationProbe.failure(forMountStatus: -6003, share: share), .notFound(share))
        try expectEqual(DestinationProbe.failure(forMountStatus: 64, share: share), .mountFailed(64))
    },
    TestCase("smb_address_parts_and_final_address") {
        let p = DestinationProbe.smbParts("smb://nas.local/backups/mac/2026")
        try expectEqual(p?.host, "nas.local")
        try expectEqual(p?.share, "backups")
        try expectEqual(p?.subpath, ["mac", "2026"])
        try expect(DestinationProbe.smbParts("smb://nas.local") == nil, "partage requis")
        try expect(DestinationProbe.smbParts("afp://nas.local/backups") == nil, "SMB seulement")
        try expectEqual(DestinationProbe.smbAddress(host: "nas.local", share: "backups", subpath: ["mac"]), "smb://nas.local/backups/mac")
        let spaced = DestinationProbe.smbAddress(host: "nas.local", share: "backups", subpath: ["Mon Mac"])
        try expectEqual(spaced, "smb://nas.local/backups/Mon%20Mac")
        // L'adresse finale est relue telle quelle par SMBProvider (URL.path décodé).
        try expectEqual(DestinationProbe.smbParts(spaced)?.subpath, ["Mon Mac"])
    },
    TestCase("smb_host_only_address_lists_disk_shares") {
        try expectEqual(DestinationProbe.smbHost("smb://syno"), "syno")
        try expectEqual(DestinationProbe.smbHost("smb://syno/home/cairn"), "syno")
        try expect(DestinationProbe.smbHost("smb://") == nil, "hôte requis")
        try expect(DestinationProbe.smbHost("afp://syno") == nil, "SMB seulement")
        let output = """
        Share                                           Type    Comments
        -------------------------------
        homes                                           Disk    user home
        Time Machine Folder                             Disk
        IPC$                                            Pipe    IPC Service ()
        home                                            Disk    Home directory of romain
        ADMIN$                                          Disk
        Plex                                            Disk    Plex Media Library

        4 shares listed
        """
        try expectEqual(DestinationProbe.parseShares(output), ["home", "homes", "Plex", "Time Machine Folder"])
        try expectEqual(DestinationProbe.parseShares("smbutil: server rejected the authentication"), [])
    },
    TestCase("new_destination_ids_are_unique") {
        try expectEqual(CairnConfig.newDestinationID(provider: .smb, existing: []), "main")
        try expectEqual(CairnConfig.newDestinationID(provider: .smb, existing: ["main"]), "nas")
        try expectEqual(CairnConfig.newDestinationID(provider: .local, existing: ["main", "disk", "disk-2"]), "disk-3")
    },
    TestCase("smb_invalid_address_fails_without_network") {
        let s = ProbeSession()
        try expectEqual(s.check(address: "smb://", username: "u", password: "p"), .failed(.invalidAddress("smb://")))
        try expect(!s.isConnected)
    },
]
