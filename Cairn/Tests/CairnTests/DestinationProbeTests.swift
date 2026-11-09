import CairnCore
import Foundation
import Testing

private func visibleNames(_ dir: URL) -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.sorted() ?? []
}

extension CairnTests {
    @Suite struct DestinationProbeTests {
        // MARK: Vérification d'un dossier local

        @Test func local_check_succeeds_and_leaves_no_trace() throws {
            try withTempDir { dir in
                try writeFile(dir.appendingPathComponent("existant.txt"), size: 3)
                guard case let .ok(free, images) = DestinationProbe.checkFolder(dir, machine: "Ce-Mac") else {
                    Issue.record("vérification en échec")
                    return
                }
                #expect((free ?? 0) > 0, "espace libre inconnu")
                #expect(images == [])
                #expect(visibleNames(dir) == ["existant.txt"], "le fichier témoin doit être supprimé")
            }
        }

        @Test func local_check_missing_folder() throws {
            try withTempDir { dir in
                let missing = dir.appendingPathComponent("absent")
                #expect(DestinationProbe.checkFolder(missing) == .failed(.notFound(missing.path)))
                #expect(!FileManager.default.fileExists(atPath: missing.path), "la vérification ne crée rien")
            }
        }

        @Test func local_check_missing_volume() {
            let path = URL(fileURLWithPath: "/Volumes/cairn-absent-\(UUID().uuidString)/Sauvegardes")
            guard case .failed(.volumeMissing) = DestinationProbe.checkFolder(path) else {
                Issue.record("volume absent non détecté")
                return
            }
        }

        @Test func local_check_read_only_folder() throws {
            try withTempDir { dir in
                let ro = dir.appendingPathComponent("lecture-seule")
                try FileManager.default.createDirectory(at: ro, withIntermediateDirectories: true)
                try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: ro.path)
                defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ro.path) }
                #expect(DestinationProbe.checkFolder(ro) == .failed(.readOnly(ro.path)))
            }
        }

        @Test func stale_write_test_files_are_removed() throws {
            try withTempDir { dir in
                let stale = dir.appendingPathComponent(DestinationProbe.writeTestPrefix + UUID().uuidString)
                try Data("cairn".utf8).write(to: stale)
                try writeFile(dir.appendingPathComponent(".autre-fichier-cache"), size: 1)
                _ = DestinationProbe.checkFolder(dir)
                #expect(visibleNames(dir) == [".autre-fichier-cache"])
            }
        }

        @Test func stale_cleanup_never_touches_user_entries() throws {
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
                #expect(visibleNames(dir) == before)
                #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("photo.jpg").path))
            }
        }

        // MARK: Sauvegardes existantes

        @Test func existing_backups_are_detected() throws {
            try withTempDir { dir in
                for n in ["cairn-MacBook-Pro.sparsebundle", "cairn-Ce-Mac.sparsebundle", "autre.sparsebundle"] {
                    try FileManager.default.createDirectory(at: dir.appendingPathComponent(n), withIntermediateDirectories: true)
                }
                guard case let .ok(_, images) = DestinationProbe.checkFolder(dir, machine: "Ce-Mac") else {
                    Issue.record("vérification en échec")
                    return
                }
                #expect(images.map(\.machine) == ["Ce-Mac", "MacBook-Pro"])
                #expect(images.map(\.isThisMac) == [true, false])
            }
        }

        // MARK: Parcours

        @Test func list_folders_filters_and_sorts() throws {
            try withTempDir { dir in
                for n in ["dossier10", "Dossier2", "dossier1", ".cache", "cairn-Mac.sparsebundle"] {
                    try FileManager.default.createDirectory(at: dir.appendingPathComponent(n), withIntermediateDirectories: true)
                }
                try writeFile(dir.appendingPathComponent("fichier.txt"), size: 1)
                let names = try DestinationProbe.listFolders(at: dir).get().map(\.name)
                #expect(names == ["dossier1", "Dossier2", "dossier10"])
            }
        }

        @Test func list_folders_access_denied() throws {
            try withTempDir { dir in
                let closed = dir.appendingPathComponent("ferme")
                try FileManager.default.createDirectory(at: closed, withIntermediateDirectories: true)
                try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: closed.path)
                defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: closed.path) }
                #expect(DestinationProbe.listFolders(at: closed).map(\.count) == .failure(.accessDenied(closed.path)))
                let missing = dir.appendingPathComponent("absent")
                #expect(DestinationProbe.listFolders(at: missing).map(\.count) == .failure(.notFound(missing.path)))
            }
        }

        @Test func create_folder_valid_and_refused_names() throws {
            typealias Probe = DestinationProbe
            try withTempDir { dir in
                let created = try Probe.createFolder(named: "  Cairn ", in: dir).get()
                #expect(created.lastPathComponent == "Cairn")
                #expect(FileManager.default.fileExists(atPath: created.path))
                #expect(Probe.createFolder(named: "Cairn", in: dir).map(\.path) == .failure(.invalidName(.exists)))
                #expect(Probe.createFolder(named: "a/b", in: dir).map(\.path) == .failure(.invalidName(.forbiddenCharacter)))
                #expect(Probe.createFolder(named: "a:b", in: dir).map(\.path) == .failure(.invalidName(.forbiddenCharacter)))
                #expect(Probe.createFolder(named: "   ", in: dir).map(\.path) == .failure(.invalidName(.empty)))
                #expect(visibleNames(dir) == ["Cairn"], "aucune écriture en cas de refus")
            }
        }

        @Test func local_roots_skip_system_disk_and_end_with_home() throws {
            try withTempDir { dir in
                let volumes = dir.appendingPathComponent("Volumes")
                try FileManager.default.createDirectory(at: volumes.appendingPathComponent("Externe"),
                                                        withIntermediateDirectories: true)
                try FileManager.default.createDirectory(at: volumes.appendingPathComponent("Archives"),
                                                        withIntermediateDirectories: true)
                try FileManager.default.createSymbolicLink(atPath: volumes.appendingPathComponent("Macintosh HD").path,
                                                           withDestinationPath: "/")
                let home = dir.appendingPathComponent("romain")
                let roots = DestinationProbe.localRoots(volumes: volumes, home: home)
                #expect(roots.map(\.name) == ["Archives", "Externe", "romain"])
            }
        }

        // MARK: SMB (sans réseau)

        @Test func smb_mount_codes_are_translated() {
            typealias Probe = DestinationProbe
            let share = "smb://nas.local/backups"
            #expect(Probe.failure(forMountStatus: 80, share: share) == .authenticationFailed)
            #expect(Probe.failure(forMountStatus: 13, share: share) == .authenticationFailed)
            #expect(Probe.failure(forMountStatus: 2, share: share) == .notFound(share))
            #expect(Probe.failure(forMountStatus: -6003, share: share) == .notFound(share))
            #expect(Probe.failure(forMountStatus: 64, share: share) == .mountFailed(64))
        }

        @Test func smb_address_parts_and_final_address() {
            typealias Probe = DestinationProbe
            let p = Probe.smbParts("smb://nas.local/backups/mac/2026")
            #expect(p?.host == "nas.local")
            #expect(p?.share == "backups")
            #expect(p?.subpath == ["mac", "2026"])
            #expect(Probe.smbParts("smb://nas.local") == nil, "partage requis")
            #expect(Probe.smbParts("afp://nas.local/backups") == nil, "SMB seulement")
            #expect(Probe.smbAddress(host: "nas.local", share: "backups", subpath: ["mac"]) == "smb://nas.local/backups/mac")
            let spaced = Probe.smbAddress(host: "nas.local", share: "backups", subpath: ["Mon Mac"])
            #expect(spaced == "smb://nas.local/backups/Mon%20Mac")
            // L'adresse finale est relue telle quelle par SMBProvider (URL.path décodé).
            #expect(Probe.smbParts(spaced)?.subpath == ["Mon Mac"])
        }

        @Test func smb_host_only_address_lists_disk_shares() {
            #expect(DestinationProbe.smbHost("smb://syno") == "syno")
            #expect(DestinationProbe.smbHost("smb://syno/home/cairn") == "syno")
            #expect(DestinationProbe.smbHost("smb://") == nil, "hôte requis")
            #expect(DestinationProbe.smbHost("afp://syno") == nil, "SMB seulement")
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
            #expect(DestinationProbe.parseShares(output) == ["home", "homes", "Plex", "Time Machine Folder"])
            #expect(DestinationProbe.parseShares("smbutil: server rejected the authentication") == [])
        }

        @Test func new_destination_ids_are_unique() {
            #expect(CairnConfig.newDestinationID(provider: .smb, existing: []) == "main")
            #expect(CairnConfig.newDestinationID(provider: .smb, existing: ["main"]) == "nas")
            #expect(CairnConfig.newDestinationID(provider: .local, existing: ["main", "disk", "disk-2"]) == "disk-3")
        }

        @Test func smb_invalid_address_fails_without_network() {
            let s = ProbeSession()
            #expect(s.check(address: "smb://", username: "u", password: "p") == .failed(.invalidAddress("smb://")))
            #expect(!s.isConnected)
        }
    }
}
