import CairnCore
import Foundation

private func stateWith(_ ids: [String], paths: CairnPaths) throws {
    var s = RunState()
    for id in ids { var d = RunState.Destination(); d.lastError = "x"; s[id] = d }
    try s.save(paths)
}

let destinationEditTests: [TestCase] = [
    // MARK: Modification

    TestCase("edit_keeps_identity") {
        let original = CairnConfig.Destination(id: "main", provider: .smb, url: "smb://syno/backups", username: "romain",
                                               keychain: "ancien", encrypted: true, retention: .count(7))
        let edited = CairnConfig.Destination(id: "smb-2", provider: .smb, url: "smb://syno/backups/mac", username: "admin",
                                             encrypted: false)
        let d = original.updatingConnection(from: edited)
        try expectEqual(d.id, "main")
        try expectEqual(d.url, "smb://syno/backups/mac")
        try expectEqual(d.username, "admin")
        try expectEqual(d.encrypted, true, "le chiffrement ne change pas à la modification")
        try expectEqual(d.retention, .count(7))
        try expectEqual(d.keychain, "ancien")
    },

    // MARK: Simulation de la suppression

    TestCase("plan_keeping_backups_touches_nothing_on_destination") {
        try withTempDir { dir in
            try writeFile(dir.appendingPathComponent("cairn/Ce-Mac/versions/2026-01-01_120000/f"), size: 10)
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: false)
            let plan = DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac")
            try expectEqual(plan.items, [.configuration(id: "usb"), .state(id: "usb")])
            try expect(plan.canExecute)
        }
    },
    TestCase("plan_lists_only_this_mac_backups") {
        try withTempDir { dir in
            try writeFile(dir.appendingPathComponent("cairn/Ce-Mac/versions/2026-01-01_120000/f"), size: 8192)
            try writeFile(dir.appendingPathComponent("cairn/Autre-Mac/versions/2026-01-01_120000/f"), size: 8192)
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: false)
            let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
            let mine = dir.appendingPathComponent("cairn/Ce-Mac").path
            try expectEqual(plan.items, [.configuration(id: "usb"), .state(id: "usb"), .backups(path: mine, bytes: plan.backupBytes)])
            try expect(plan.backupBytes >= 8192, "taille des sauvegardes : \(plan.backupBytes)")
        }
    },
    TestCase("plan_encrypted_lists_image_and_its_password") {
        try withTempDir { dir in
            let image = dir.appendingPathComponent("cairn-Ce-Mac.sparsebundle")
            try writeFile(image.appendingPathComponent("bands/0"), size: 4096)
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("cairn-Autre-Mac.sparsebundle"), withIntermediateDirectories: true)
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: true)
            let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
            try expect(plan.items.contains(.backups(path: image.path, bytes: plan.backupBytes)), "image de ce Mac absente du plan")
            try expect(plan.items.contains(.imagePassword(service: Keychain.servicePrefix + "image.usb", account: "Ce-Mac")))
            try expect(!plan.items.contains { if case let .backups(p, _) = $0 { p.contains("Autre-Mac") } else { false } },
                       "l'image d'un autre Mac ne doit jamais être listée")
        }
    },
    TestCase("plan_unreachable_destination_blocks_backup_removal") {
        let d = CairnConfig.Destination(id: "usb", provider: .local, path: "/Volumes/cairn-absent-\(UUID().uuidString)/Backups", encrypted: false)
        let keep = DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac")
        try expect(keep.canExecute, "garder les sauvegardes reste possible sans la destination")
        let remove = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
        try expect(remove.backupsUnavailable != nil)
        try expect(!remove.canExecute)
    },

    // MARK: Exécution

    TestCase("execute_removes_backups_password_and_state") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent("home"))
            try stateWith(["usb", "nas"], paths: paths)
            let dest = dir.appendingPathComponent("dest")
            try writeFile(dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle/bands/0"), size: 10)
            try writeFile(dest.appendingPathComponent("cairn-Autre-Mac.sparsebundle/bands/0"), size: 10)
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: dest.path, encrypted: true)
            let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
            var deleted: [String] = []
            try DestinationRemoval.execute(plan, paths: paths) { s, a in deleted.append(s + "/" + a) }
            try expect(!FileManager.default.fileExists(atPath: dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle").path))
            try expect(FileManager.default.fileExists(atPath: dest.appendingPathComponent("cairn-Autre-Mac.sparsebundle").path),
                       "l'image d'un autre Mac doit rester")
            try expectEqual(deleted, [Keychain.servicePrefix + "image.usb/Ce-Mac"])
            try expectEqual(Array(RunState.load(paths).destinations.keys), ["nas"])
        }
    },
    TestCase("execute_keeping_backups_leaves_destination_and_password") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent("home"))
            try stateWith(["usb"], paths: paths)
            let dest = dir.appendingPathComponent("dest")
            try writeFile(dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle/bands/0"), size: 10)
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: dest.path, encrypted: true)
            var deleted = 0
            try DestinationRemoval.execute(DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac"), paths: paths) { _, _ in deleted += 1 }
            try expect(FileManager.default.fileExists(atPath: dest.appendingPathComponent("cairn-Ce-Mac.sparsebundle").path))
            try expectEqual(deleted, 0, "le mot de passe de l'image sert à restaurer les sauvegardes gardées")
            try expect(RunState.load(paths).destinations.isEmpty)
        }
    },
    TestCase("execute_refused_while_operation_running") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent("home"))
            try stateWith(["usb"], paths: paths)
            let lock = OperationLock(url: paths.operationLock)
            try lock.acquire(operation: "backup")
            defer { lock.release() }
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: dir.path, encrypted: false)
            try expectThrows(OperationLock.Failure.alreadyHeld) {
                try DestinationRemoval.execute(DestinationRemoval.plan(d, includeBackups: false, machine: "Ce-Mac"), paths: paths) { _, _ in }
            }
            try expectEqual(Array(RunState.load(paths).destinations.keys), ["usb"], "rien n'est retiré")
        }
    },
    TestCase("execute_unavailable_plan_changes_nothing") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent("home"))
            try stateWith(["usb"], paths: paths)
            let d = CairnConfig.Destination(id: "usb", provider: .local, path: "/Volumes/cairn-absent-\(UUID().uuidString)/B", encrypted: false)
            let plan = DestinationRemoval.plan(d, includeBackups: true, machine: "Ce-Mac")
            do {
                try DestinationRemoval.execute(plan, paths: paths) { _, _ in }
                throw TestFailure(message: "exécution acceptée", file: #filePath, line: #line)
            } catch is DestinationRemoval.Failure {}
            try expectEqual(Array(RunState.load(paths).destinations.keys), ["usb"])
        }
    },

    // MARK: Actions de la page

    TestCase("actions_nothing_to_verify") {
        let c = BackupActions.Context(reachable: true, backingUp: false, verifying: false, hasBackups: false)
        try expectEqual(BackupActions.unavailableReason(.verify, c), "backup.unavailable.nothing_to_verify")
        try expectEqual(BackupActions.unavailableReason(.verifyFull, c), "backup.unavailable.nothing_to_verify")
        try expectEqual(BackupActions.unavailableReason(.backup, c), nil)
        try expectEqual(BackupActions.unavailableReason(.simulate, c), nil)
    },
    TestCase("actions_unreachable") {
        let c = BackupActions.Context(reachable: false, backingUp: false, verifying: false, hasBackups: true)
        for a in BackupAction.allCases { try expectEqual(BackupActions.unavailableReason(a, c), "backup.unavailable.unreachable") }
        let unknown = BackupActions.Context(reachable: nil, backingUp: false, verifying: false, hasBackups: true)
        for a in BackupAction.allCases { try expectEqual(BackupActions.unavailableReason(a, unknown), nil, "pas encore sondée") }
    },
    TestCase("actions_running") {
        let c = BackupActions.Context(reachable: true, backingUp: true, verifying: false, hasBackups: true)
        try expectEqual(BackupActions.unavailableReason(.simulate, c), "backup.unavailable.running")
        try expectEqual(BackupActions.unavailableReason(.verifyFull, c), "backup.unavailable.running")
        let v = BackupActions.Context(reachable: true, backingUp: false, verifying: true, hasBackups: true)
        for a in BackupAction.allCases { try expectEqual(BackupActions.unavailableReason(a, v), "backup.unavailable.verifying") }
    },
]
