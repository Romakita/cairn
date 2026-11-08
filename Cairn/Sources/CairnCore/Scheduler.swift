import Foundation
import IOKit.ps
import IOKit.pwr_mgt

/// Décisions de planification (fonctions pures, testées avec une horloge simulée).
public enum BackupSchedule {
    public enum Decision: Equatable, Sendable {
        case run
        case notDue
        case manual
        case alreadyRunning
        case waitingPower
        case waitingDestination
        /// Dernière tentative en échec trop récente : on attend `retryDelay` avant de relancer.
        case retryLater
    }

    /// Délai avant de relancer automatiquement une sauvegarde qui a échoué (évite une boucle de relances).
    public static let retryDelay: TimeInterval = 3600

    public struct Power: Equatable, Sendable {
        public var onBattery: Bool
        public var percent: Int
        public var lowPowerMode: Bool
        public init(onBattery: Bool, percent: Int, lowPowerMode: Bool) {
            self.onBattery = onBattery; self.percent = percent; self.lowPowerMode = lowPowerMode
        }
        public static let ac = Power(onBattery: false, percent: 100, lowPowerMode: false)
    }

    /// Dernière échéance prévue au plus tard à `now` (nil en manuel).
    public static func lastOccurrence(_ s: CairnConfig.Schedule, now: Date, calendar: Calendar = .current) -> Date? {
        guard s.frequency != .manual else { return nil }
        let parts = s.time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        var today = calendar.dateComponents([.year, .month, .day], from: now)
        today.hour = parts[0]
        today.minute = parts[1]
        guard var candidate = calendar.date(from: today) else { return nil }
        if s.frequency == .daily {
            if candidate > now { candidate = calendar.date(byAdding: .day, value: -1, to: candidate)! }
            return candidate
        }
        // Hebdomadaire : remonter jusqu'au bon jour.
        let target = (CairnConfig.weekdays.firstIndex(of: s.weekday) ?? 0) + 2 // Calendar : dimanche = 1, lundi = 2
        let wanted = target > 7 ? 1 : target
        for _ in 0..<8 {
            if calendar.component(.weekday, from: candidate) == wanted && candidate <= now { return candidate }
            candidate = calendar.date(byAdding: .day, value: -1, to: candidate)!
        }
        return nil
    }

    /// Une échéance est due si la dernière réussite précède la dernière échéance prévue.
    public static func isDue(_ s: CairnConfig.Schedule, lastSuccess: Date?, now: Date, calendar: Calendar = .current) -> Bool {
        guard let occ = lastOccurrence(s, now: now, calendar: calendar) else { return false }
        return lastSuccess.map { $0 < occ } ?? true
    }

    public static func decide(_ s: CairnConfig.Schedule, lastSuccess: Date?, lastAttempt: Date? = nil, now: Date,
                              running: Bool, power: Power, reachable: Bool, calendar: Calendar = .current) -> Decision {
        if s.frequency == .manual { return .manual }
        guard isDue(s, lastSuccess: lastSuccess, now: now, calendar: calendar) else { return .notDue }
        if running { return .alreadyRunning }
        if let a = lastAttempt, a > (lastSuccess ?? .distantPast), now.timeIntervalSince(a) < retryDelay { return .retryLater }
        if power.onBattery && (power.lowPowerMode || power.percent < s.onBatteryMinPercent) { return .waitingPower }
        if !reachable { return .waitingDestination }
        return .run
    }

    /// Retard d'une destination : notification après un jour, puis au plus une par jour.
    public static func shouldNotifyOverdue(_ s: CairnConfig.Schedule, lastSuccess: Date?, lastNotice: Date?, now: Date,
                                           calendar: Calendar = .current) -> Bool {
        guard let occ = lastOccurrence(s, now: now, calendar: calendar),
              lastSuccess.map({ $0 < occ }) ?? true else { return false }
        // Retard = depuis l'échéance manquée la plus ancienne (après la dernière réussite).
        var oldest = occ
        if let last = lastSuccess {
            var probe = calendar.date(byAdding: .second, value: -1, to: occ)!
            while let prev = lastOccurrence(s, now: probe, calendar: calendar), prev > last {
                oldest = prev
                probe = calendar.date(byAdding: .second, value: -1, to: prev)!
            }
        }
        guard now.timeIntervalSince(oldest) > 86_400 else { return false }
        return lastNotice.map { now.timeIntervalSince($0) >= 86_400 } ?? true
    }
}

/// État de l'alimentation et assertion anti-veille.
public enum PowerState {
    public static func current() -> BackupSchedule.Power {
        var power = BackupSchedule.Power.ac
        power.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return power }
        for src in list {
            guard let d = IOPSGetPowerSourceDescription(info, src)?.takeUnretainedValue() as? [String: Any] else { continue }
            if (d[kIOPSPowerSourceStateKey] as? String) == kIOPSBatteryPowerValue { power.onBattery = true }
            if let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 {
                power.percent = cur * 100 / max
            }
        }
        return power
    }

    /// Empêche la veille par inactivité (pas la veille demandée : capot fermé, menu Pomme).
    public final class IdleSleepAssertion: @unchecked Sendable {
        private var id: IOPMAssertionID = 0
        public init(reason: String) {
            IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep as CFString,
                                        IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
        }
        public func release() {
            if id != 0 { IOPMAssertionRelease(id); id = 0 }
        }
        deinit { release() }
    }
}
