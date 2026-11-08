import CairnCore
import Foundation

private let now = ISO8601DateFormatter().date(from: "2026-11-08T10:00:00Z")!

private func alert(_ volume: String, _ level: StorageAlerts.Level) -> StorageAlerts.Alert {
    StorageAlerts.Alert(volume: volume, level: level, available: 5_000_000_000, percentFree: 3, daysToFull: nil)
}

private func dest(_ id: String, success: Date? = nil, error: String? = nil, waitingSince: Date? = nil,
                  waiting: Bool = false, damaged: [String] = []) -> HubState.Inputs.Destination {
    var s = RunState.Destination()
    s.lastSuccess = success
    s.lastError = error
    s.waitingSince = waitingSince
    s.damagedVersions = damaged
    return .init(id: id, label: id, state: s, waiting: waiting)
}

private func inputs(_ change: (inout HubState.Inputs) -> Void = { _ in }) -> HubState.Inputs {
    var i = HubState.Inputs()
    i.now = now
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    i.calendar = cal
    i.schedule.frequency = .manual
    change(&i)
    return i
}

/// Règle de l'icône de la barre des menus telle qu'elle était écrite dans `AppModel.globalStatus` avant le hub.
private func referenceStatus(_ i: HubState.Inputs) -> Health.Level {
    if !i.configErrors.isEmpty { return .error }
    let backup = i.destinations.map {
        Health.destination($0.state, waiting: $0.waiting, schedule: i.schedule, now: i.now, calendar: i.calendar)
    }.max() ?? .ok
    if backup == .error { return .error }
    if backup == .attention || !i.volumeAlerts.isEmpty || !i.unavailableFolders.isEmpty { return .attention }
    return .ok
}

let hubTests: [TestCase] = [
    TestCase("priority_order_follows_spec") {
        let i = inputs {
            $0.volumeAlerts = [alert("Data", .low), alert("Macintosh HD", .critical)]
            $0.unavailableFolders = ["/Volumes/Missing/work"]
            $0.destinations = [dest("nas", waitingSince: now.addingTimeInterval(-30 * 3600), waiting: true),
                               dest("usb", error: "rsync failed")]
            $0.configErrors = ["error line 4: syntax"]
        }
        let kinds = HubState.issues(i).map(\.kind)
        try expectEqual(kinds, [.configInvalid, .backupFailed, .diskCritical, .destinationOverdue, .diskLow, .folderUnavailable])
        try expectEqual(HubState.make(i).topIssue?.kind, .configInvalid)
    },
    TestCase("top_issue_backup_failed_over_disk_low") {
        let h = HubState.make(inputs {
            $0.volumeAlerts = [alert("Macintosh HD", .low)]
            $0.destinations = [dest("syno", error: "unreachable share")]
        })
        try expectEqual(h.topIssue?.kind, .backupFailed)
        try expectEqual(h.topIssue?.ref, "syno")
        // L'alerte de disque reste visible sur la carte Stockage.
        try expectEqual(h.module(.storage).tone, .attention)
        try expectEqual(h.overall, .error)
    },
    TestCase("two_attention_points") {
        let h = HubState.make(inputs {
            $0.volumeAlerts = [alert("Macintosh HD", .low)]
            $0.destinations = [dest("nas", success: now.addingTimeInterval(-40 * 3600),
                                    waitingSince: now.addingTimeInterval(-30 * 3600), waiting: true)]
        })
        try expectEqual(h.overall, .attention)
        try expectEqual(h.causes.map(\.kind), [.destinationOverdue, .diskLow])
    },
    TestCase("config_invalid_keeps_line") {
        let h = HubState.make(inputs { $0.configErrors = ["Erreur ligne 12 : syntaxe"] })
        try expectEqual(h.overall, .error)
        try expectEqual(h.topIssue?.detail, "Erreur ligne 12 : syntaxe")
    },
    TestCase("all_in_order") {
        let h = HubState.make(inputs { $0.destinations = [dest("nas", success: now.addingTimeInterval(-3 * 3600))] })
        try expectEqual(h.overall, .ok)
        try expect(h.causes.isEmpty && h.topIssue == nil, "aucun bandeau attendu")
    },
    TestCase("overall_matches_menu_bar_status") {
        // Toutes les combinaisons d'entrées qui influencent l'icône.
        let destinations: [[HubState.Inputs.Destination]] = [
            [], [dest("a", success: now)], [dest("a", error: "x")], [dest("a", damaged: ["v1"])],
            [dest("a", waiting: true)], [dest("a", waitingSince: now.addingTimeInterval(-90_000), waiting: true)],
            [dest("a", success: now), dest("b", error: "x")],
        ]
        var checked = 0
        for d in destinations {
            for config in [[], ["error"]] {
                for alerts in [[], [alert("v", .low)], [alert("v", .critical)]] {
                    for folders in [[], ["/missing"]] {
                        for frequency in [CairnConfig.Frequency.manual, .daily] {
                            let i = inputs {
                                $0.destinations = d; $0.configErrors = config; $0.volumeAlerts = alerts
                                $0.unavailableFolders = folders; $0.schedule.frequency = frequency
                            }
                            try expectEqual(HubState.make(i).overall, referenceStatus(i), "entrées \(d.map(\.state)) \(config) \(alerts) \(folders)")
                            try expectEqual(HubState.overall(of: i), referenceStatus(i))
                            checked += 1
                        }
                    }
                }
            }
        }
        try expect(checked > 100)
    },
    TestCase("module_no_destination") {
        let b = HubState.make(inputs()).module(.backup)
        try expectEqual(b.tone, .attention)
        try expectEqual(b.figure, .noDestination)
        try expectEqual(b.action, .addDestination)
    },
    TestCase("module_backup_success") {
        let last = now.addingTimeInterval(-3 * 3600)
        let h = HubState.make(inputs {
            $0.schedule.frequency = .daily
            $0.schedule.time = "12:30"
            $0.destinations = [dest("nas", success: last)]
        })
        let b = h.module(.backup)
        try expectEqual(b.tone, .ok)
        try expectEqual(b.figure, .lastBackup(last))
        try expectEqual(b.action, .backupNow)
        guard case let .nextBackup(next) = b.detail else { throw TestFailure(message: "prochaine attendue : \(b.detail)", file: #filePath, line: #line) }
        try expect(next > now, "prochaine échéance dans le futur")
        try expectEqual(h.module(.restore).figure, .lastVersion(last))
    },
    TestCase("module_backup_failed") {
        let b = HubState.make(inputs { $0.destinations = [dest("nas", success: now.addingTimeInterval(-86_400), error: "boom")] })
            .module(.backup)
        try expectEqual(b.tone, .error)
        try expectEqual(b.figure, .failed("nas"))
        try expectEqual(b.action, .openBackup)
    },
    TestCase("module_unreachable_destination") {
        let b = HubState.make(inputs { $0.destinations = [dest("NAS", success: now, waiting: true)] }).module(.backup)
        try expectEqual(b.figure, .unreachable("NAS"))
    },
    TestCase("module_git_never_analyzed") {
        let g = HubState.make(inputs()).module(.git)
        try expectEqual(g.figure, .notAnalyzed)
        try expectEqual(g.action, .analyzeGit)
        try expectEqual(g.tone, .unknown)
        try expectEqual(HubState.make(inputs { $0.gitReports = [] }).module(.git).figure, .gitClean)
    },
    TestCase("module_storage") {
        try expectEqual(HubState.make(inputs()).module(.storage).action, .analyze)
        let s = HubState.make(inputs {
            $0.freeBytes = 100_000_000_000
            $0.summary = AnalysisSummary(date: now, totalBytes: 1, reclaimableByType: ["deps": 12_000_000_000],
                                         obsoleteWorktreeBytes: 0, trashBytes: 0)
        }).module(.storage)
        try expectEqual(s.figure, .free(100_000_000_000))
        try expectEqual(s.detail, .reclaimable(12_000_000_000))
        try expectEqual(s.action, .clean)
        try expectEqual(s.tone, .ok)
    },
    TestCase("hub_record_round_trip") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir)
            try expectEqual(HubRecord.load(paths).lastCheck, nil)
            try HubRecord(lastCheck: now).save(paths)
            try expectEqual(HubRecord.load(paths).lastCheck, now)
        }
    },
    TestCase("activity_missing_file") {
        try withTempDir { dir in
            try expect(ActivityLog(paths: CairnPaths(root: dir)).recent(10).isEmpty)
        }
    },
    TestCase("activity_most_recent_first_and_capped") {
        try withTempDir { dir in
            let log = ActivityLog(paths: CairnPaths(root: dir))
            for n in 0..<205 {
                log.append(.init(date: now.addingTimeInterval(Double(n)), kind: .check, count: n))
            }
            let lines = try String(contentsOf: log.url, encoding: .utf8).split(separator: "\n")
            try expectEqual(lines.count, ActivityLog.maxLines)
            let recent = log.recent(10)
            try expectEqual(recent.map { $0.count ?? -1 }, Array((195..<205).reversed()))
            try expectEqual(log.recent(500).last?.count, 5)
        }
    },
    TestCase("backup_service_logs_activity") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent("home"))
            try paths.ensure()
            let src = dir.appendingPathComponent("src")
            try writeFile(src.appendingPathComponent("a.txt"), size: 10)
            var c = CairnConfig()
            c.folders = [.init(path: src.path)]
            c.destinations = [.init(id: "disk", provider: .local, path: dir.appendingPathComponent("dest").path, encrypted: false)]
            var req = BackupService.Request()
            req.only = [.folder]
            _ = try BackupService(paths: paths, config: c).run(req)
            let events = ActivityLog(paths: paths).recent(10)
            try expectEqual(events.map(\.kind), [.backupSucceeded])
            try expectEqual(events.first?.subject, "disk")
            // Une simulation n'écrit rien dans l'activité.
            req.dryRun = true
            _ = try BackupService(paths: paths, config: c).run(req)
            try expectEqual(ActivityLog(paths: paths).recent(10).count, 1)
        }
    },
    TestCase("activity_backup_days") {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let day = 86_400.0
        let events: [ActivityLog.Event] = [
            .init(date: now.addingTimeInterval(-10 * day), kind: .backupSucceeded),  // hors fenêtre
            .init(date: now.addingTimeInterval(-2 * day), kind: .backupFailed),
            .init(date: now.addingTimeInterval(-1 * day), kind: .backupFailed),
            .init(date: now.addingTimeInterval(-1 * day + 60), kind: .backupSucceeded),
            .init(date: now, kind: .cleanup),
        ]
        try expectEqual(ActivityLog.backupDays(events, days: 7, now: now, calendar: cal),
                        [nil, nil, nil, nil, false, true, nil])
    },
    TestCase("activity_concurrent_processes_keep_every_event") {
        try withTempDir { dir in
            let exe = CommandLine.arguments[0]
            let procs = (0..<8).map { _ -> Process in
                let p = Process()
                p.executableURL = URL(fileURLWithPath: exe)
                p.arguments = ["--append-activity", dir.path, "20"]
                return p
            }
            try procs.forEach { try $0.run() }
            procs.forEach { $0.waitUntilExit() }
            try expectEqual(ActivityLog(paths: CairnPaths(root: dir)).recent(500).count, 160)
        }
    },
    TestCase("full_check_git_options_are_read_only_and_unfiltered") {
        var c = CairnConfig()
        c.git.fetchBefore = true
        var screen = GitOptions()
        screen.only = "cairn"
        let check = screen.forAnalysis(config: c, fullCheck: true)
        try expect(!check.fetch, "jamais de git fetch pendant « Tout vérifier »")
        try expectEqual(check.only, nil)
        let explicit = screen.forAnalysis(config: c, fullCheck: false)
        try expect(explicit.fetch, "l'analyse git explicite garde fetch_before")
        try expectEqual(explicit.only, "cairn")
    },
]
