import CairnCore
import Foundation
import Testing

private func stateWith(_ ids: [String], paths: CairnPaths) throws {
    var s = RunState()
    for id in ids { var d = RunState.Destination(); d.lastError = "x"; s[id] = d }
    try s.save(paths)
}

extension CairnTests {
    @Suite struct DestinationEditTests {
        // MARK: Modification

        @Test func edit_keeps_identity() {
            let original = CairnConfig.Destination(id: "main", provider: .smb, url: "smb://syno/backups", username: "romain",
                                                   keychain: "ancien", encrypted: true, retention: .count(7))
            let edited = CairnConfig.Destination(id: "smb-2", provider: .smb, url: "smb://syno/backups/mac",
                                                 username: "admin", encrypted: false)
            let d = original.updatingConnection(from: edited)
            #expect(d.id == "main")
            #expect(d.url == "smb://syno/backups/mac")
            #expect(d.username == "admin")
            #expect(d.encrypted == true, "le chiffrement ne change pas à la modification")
            #expect(d.retention == .count(7))
            #expect(d.keychain == "ancien")
        }

        // MARK: Simulation de la suppression

        @Test func plan_keeping_backups_touches_nothing_on_destination() throws {
            try withTempDir { dir in
                try writeFile(dir.appendingPathComponent("cairn/Ce-Mac/versions/2026-01-01_120000/f"), size: 10)
                let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: false)
                let plan = DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac")
                #expect(plan.items == [.configuration(id: "usb"), .state(id: "usb")])
                #expect(plan.canExecute)
            }
        }

        @Test func plan_lists_only_this_mac_backups() throws {
            try withTempDir { dir in
                try writeFile(dir.appendingPathComponent("cairn/Ce-Mac/versions/2026-01-01_120000/f"), size: 8192)
                try writeFile(dir.appendingPathComponent("cairn/Autre-Mac/versions/2026-01-01_120000/f"), size: 8192)
                let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: false)
                let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
                let mine = dir.appendingPathComponent("cairn/Ce-Mac").path
                #expect(plan.items == [.configuration(id: "usb"), .state(id: "usb"),
                                       .backups(path: mine, bytes: plan.backupBytes)])
                #expect(plan.backupBytes >= 8192, "taille des sauvegardes : \(plan.backupBytes)")
            }
        }

        @Test func plan_encrypted_lists_image_but_never_its_password() throws {
            try withTempDir { dir in
                let image = dir.appendingPathComponent("cairn-Ce-Mac.sparsebundle")
                try writeFile(image.appendingPathComponent("bands/0"), size: 4096)
                try FileManager.default.createDirectory(at: dir.appendingPathComponent("cairn-Autre-Mac.sparsebundle"),
                                                        withIntermediateDirectories: true)
                let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: true)
                let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
                #expect(plan.items.contains(.backups(path: image.path, bytes: plan.backupBytes)),
                        "image de ce Mac absente du plan")
                #expect(plan.items.count == 3, "config, état, image : le mot de passe de l'image reste au Trousseau")
                #expect(!plan.items.contains { if case let .backups(p, _) = $0 { p.contains("Autre-Mac") } else { false } },
                        "l'image d'un autre Mac ne doit jamais être listée")
            }
        }

        @Test func plan_unreachable_destination_blocks_backup_removal() {
            let d = CairnConfig.Destination(id: "usb", provider: .local,
                                            path: "/Volumes/cairn-absent-\(UUID().uuidString)/Backups", encrypted: false)
            let keep = DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac")
            #expect(keep.canExecute, "garder les sauvegardes reste possible sans la destination")
            let remove = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
            #expect(remove.backupsUnavailable != nil)
            #expect(!remove.canExecute)
        }

        // MARK: Exécution

        @Test func execute_removes_backups_and_state() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent("home"))
                try stateWith(["usb", "nas"], paths: paths)
                let dest = dir.appendingPathComponent("dest")
                try writeFile(dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle/bands/0"), size: 10)
                try writeFile(dest.appendingPathComponent("cairn-Autre-Mac.sparsebundle/bands/0"), size: 10)
                let d = CairnConfig.Destination(id: "usb", provider: .local, path: dest.path, encrypted: true)
                let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
                try DestinationRemoval.execute(plan, paths: paths)
                #expect(!FileManager.default.fileExists(atPath: dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle").path))
                #expect(FileManager.default.fileExists(atPath: dest.appendingPathComponent("cairn-Autre-Mac.sparsebundle").path),
                        "l'image d'un autre Mac doit rester")
                #expect(Array(RunState.load(paths).destinations.keys) == ["nas"])
            }
        }

        @Test func execute_keeping_backups_leaves_destination() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent("home"))
                try stateWith(["usb"], paths: paths)
                let dest = dir.appendingPathComponent("dest")
                try writeFile(dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle/bands/0"), size: 10)
                let d = CairnConfig.Destination(id: "usb", provider: .local, path: dest.path, encrypted: true)
                try DestinationRemoval.execute(DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac"),
                                               paths: paths)
                #expect(FileManager.default.fileExists(atPath: dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle").path))
                #expect(RunState.load(paths).destinations.isEmpty)
            }
        }

        @Test func execute_refused_while_operation_running() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent("home"))
                try stateWith(["usb"], paths: paths)
                let lock = OperationLock(url: paths.operationLock)
                try lock.acquire(operation: "backup")
                defer { lock.release() }
                let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: false)
                #expect(throws: OperationLock.Failure.alreadyHeld) {
                    try DestinationRemoval.execute(DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac"),
                                                   paths: paths)
                }
                #expect(Array(RunState.load(paths).destinations.keys) == ["usb"], "rien n'est retiré")
            }
        }

        @Test func execute_unavailable_plan_changes_nothing() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent("home"))
                try stateWith(["usb"], paths: paths)
                let d = CairnConfig.Destination(id: "usb", provider: .local,
                                                path: "/Volumes/cairn-absent-\(UUID().uuidString)/B", encrypted: false)
                let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
                #expect(throws: DestinationRemoval.Failure.self, "exécution acceptée") {
                    try DestinationRemoval.execute(plan, paths: paths)
                }
                #expect(Array(RunState.load(paths).destinations.keys) == ["usb"])
            }
        }

        // MARK: Actions de la page

        @Test func actions_nothing_to_verify() {
            let c = BackupActions.Context(reachable: true, backingUp: false, verifying: false, hasBackups: false)
            #expect(BackupActions.unavailableReason(.verify, c) == "backup.unavailable.nothing_to_verify")
            #expect(BackupActions.unavailableReason(.verifyFull, c) == "backup.unavailable.nothing_to_verify")
            #expect(BackupActions.unavailableReason(.backup, c) == nil)
            #expect(BackupActions.unavailableReason(.simulate, c) == nil)
        }

        @Test func actions_unreachable() {
            let c = BackupActions.Context(reachable: false, backingUp: false, verifying: false, hasBackups: true)
            for a in BackupAction.allCases { #expect(BackupActions.unavailableReason(a, c) == "backup.unavailable.unreachable") }
            let unknown = BackupActions.Context(reachable: nil, backingUp: false, verifying: false, hasBackups: true)
            for a in BackupAction.allCases { #expect(BackupActions.unavailableReason(a, unknown) == nil, "pas encore sondée") }
        }

        @Test func actions_running() {
            let c = BackupActions.Context(reachable: true, backingUp: true, verifying: false, hasBackups: true)
            // « Sauvegarder maintenant » aussi : la destination en cours affiche « Arrêter », les autres attendent.
            for a in BackupAction.allCases { #expect(BackupActions.unavailableReason(a, c) == "backup.unavailable.running") }
            let v = BackupActions.Context(reachable: true, backingUp: false, verifying: true, hasBackups: true)
            for a in BackupAction.allCases { #expect(BackupActions.unavailableReason(a, v) == "backup.unavailable.verifying") }
        }
    }
}
