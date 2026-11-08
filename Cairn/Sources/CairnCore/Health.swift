import Foundation

/// État global affiché par la barre des menus (décisions pures, testées avec une horloge simulée).
public enum Health {
    public enum Level: Int, Comparable, Sendable {
        case ok = 0, attention = 1, error = 2
        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    }

    /// Une destination : erreur si la dernière sauvegarde a échoué ; attention si des versions sont abîmées ou si
    /// elle est injoignable depuis plus d'un jour (ou avec une échéance manquée depuis plus d'un jour).
    public static func destination(_ ds: RunState.Destination, waiting: Bool, schedule: CairnConfig.Schedule,
                                   now: Date, calendar: Calendar = .current) -> Level {
        if ds.lastError != nil { return .error }
        if !ds.damagedVersions.isEmpty { return .attention }
        guard waiting || ds.waitingSince != nil else { return .ok }
        if let since = ds.waitingSince, now.timeIntervalSince(since) > 86_400 { return .attention }
        if BackupSchedule.shouldNotifyOverdue(schedule, lastSuccess: ds.lastSuccess, lastNotice: nil, now: now, calendar: calendar) {
            return .attention
        }
        return .ok
    }

    /// Prochaine échéance de sauvegarde (nil en manuel). Une échéance déjà passée signifie « en retard ».
    public static func nextBackup(_ s: CairnConfig.Schedule, lastSuccess: Date?, now: Date, calendar: Calendar = .current) -> Date? {
        guard let last = BackupSchedule.lastOccurrence(s, now: now, calendar: calendar) else { return nil }
        if BackupSchedule.isDue(s, lastSuccess: lastSuccess, now: now, calendar: calendar) { return last }
        return calendar.date(byAdding: .day, value: s.frequency == .weekly ? 7 : 1, to: last)
    }

    /// La dernière analyse date de plus de `days` jours (ou n'a jamais eu lieu).
    public static func analysisIsStale(_ date: Date?, now: Date, days: Double = 7) -> Bool {
        guard let date else { return true }
        return now.timeIntervalSince(date) > days * 86_400
    }
}
