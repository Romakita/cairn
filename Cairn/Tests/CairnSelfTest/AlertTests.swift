import CairnCore
import Foundation

private let GB: Int64 = 1_000_000_000
private let total: Int64 = 1000 * GB
private func r(_ hoursAgo: Double, _ freeGB: Double, now: Date) -> VolumeHistory.Reading {
    .init(date: now.addingTimeInterval(-hoursAgo * 3600), available: Int64(freeGB * Double(GB)), total: total)
}

let alertTests: [TestCase] = [
    TestCase("thresholds") {
        let a = CairnConfig.Alerts()
        try expectEqual(StorageAlerts.level(available: 200 * GB, total: total, alerts: a), .ok)
        try expectEqual(StorageAlerts.level(available: 90 * GB, total: total, alerts: a), .low)       // 9 %
        try expectEqual(StorageAlerts.level(available: 40 * GB, total: total, alerts: a), .critical)  // 4 %
        try expectEqual(StorageAlerts.level(available: 15 * GB, total: 100 * GB, alerts: a), .low)   // 15 % mais < 20 Go
    },
    TestCase("oscillation_notifies_once_per_day") {
        let a = CairnConfig.Alerts()
        let now = Date()
        var state = StorageAlerts.VolumeState()
        var sent = 0
        for (i, free) in [98.0, 102, 98, 102, 98].enumerated() {
            let (alert, s) = StorageAlerts.evaluate(volume: "w", reading: r(Double(5 - i), free, now: now), history: [],
                                                    state: state, alerts: a, now: now.addingTimeInterval(Double(i) * 3600))
            state = s
            if alert != nil { sent += 1 }
        }
        try expectEqual(sent, 1)
    },
    TestCase("critical_escalation_is_immediate") {
        let a = CairnConfig.Alerts()
        let now = Date()
        var (first, state) = StorageAlerts.evaluate(volume: "w", reading: r(0, 90, now: now), history: [], state: .init(), alerts: a, now: now)
        try expectEqual(first?.level, .low)
        let later = now.addingTimeInterval(4 * 3600)
        (first, state) = StorageAlerts.evaluate(volume: "w", reading: r(0, 40, now: later), history: [], state: state, alerts: a, now: later)
        try expectEqual(first?.level, .critical, "passage critique notifié sans attendre le lendemain")
        let (again, _) = StorageAlerts.evaluate(volume: "w", reading: r(0, 39, now: later), history: [], state: state, alerts: a, now: later.addingTimeInterval(3600))
        try expect(again == nil)
    },
    TestCase("forecast_announces_six_days") {
        let now = Date()
        // Perte de 5 Go par jour depuis une semaine, 30 Go libres sur 100 Go (au-dessus des seuils).
        let history = (1...7).map { d in VolumeHistory.Reading(date: now.addingTimeInterval(-Double(d) * 86_400),
                                                              available: (30 + 5 * Int64(d)) * GB, total: 100 * GB) }
        let days = StorageAlerts.daysToFull(history + [.init(date: now, available: 30 * GB, total: 100 * GB)], now: now)
        try expect(days != nil && abs(days! - 6) < 0.5, "\(String(describing: days))")
        var a = CairnConfig.Alerts(); a.lowGB = 10; a.criticalGB = 1
        let (alert, _) = StorageAlerts.evaluate(volume: "w", reading: .init(date: now, available: 30 * GB, total: 100 * GB),
                                                history: history, state: .init(), alerts: a, now: now)
        try expect(alert?.daysToFull != nil, "alerte anticipée")
        try expect(StorageAlerts.daysToFull(Array(history.prefix(2)), now: now) == nil, "moins de 3 jours d'historique")
    },
    TestCase("snooze_for_seven_days") {
        let a = CairnConfig.Alerts()
        let now = Date()
        let state = StorageAlerts.snooze(.init(), now: now)
        let (silent, _) = StorageAlerts.evaluate(volume: "w", reading: r(0, 90, now: now), history: [], state: state, alerts: a, now: now)
        try expect(silent == nil)
        let later = now.addingTimeInterval(8 * 86_400)
        let (back, _) = StorageAlerts.evaluate(volume: "w", reading: r(0, 90, now: later), history: [], state: state, alerts: a, now: later)
        try expect(back != nil)
    },
    TestCase("summary_and_history_persist") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir)
            try writeFile(dir.appendingPathComponent("tree/node_modules/x.js"), size: 200_000)
            let scan = Scanner.scan(root: dir.appendingPathComponent("tree").path, ctx: ScanContext())
            let s = AnalysisSummary.from(roots: [scan.root], obsoleteWorktreeBytes: 1000)
            try s.save(paths)
            try expectEqual(AnalysisSummary.load(paths)?.reclaimableByType["deps"], scan.root.bytes(.deps))
            var h = VolumeHistory()
            let now = Date()
            h.add("w", .init(date: now.addingTimeInterval(-40 * 86_400), available: 1, total: 2))
            h.add("w", .init(date: now, available: 1, total: 2))
            try expectEqual(h.readings["w"]?.count, 1, "relevés de plus de 30 jours purgés")
            try h.save(paths)
            try expectEqual(VolumeHistory.load(paths).readings["w"]?.count, 1)
        }
    },
]
