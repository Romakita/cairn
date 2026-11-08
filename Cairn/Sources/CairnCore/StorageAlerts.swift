import Foundation

/// Résumé persistant de la dernière analyse (`state/analysis-summary.json`) : lu par la barre des menus et les alertes.
public struct AnalysisSummary: Codable, Equatable, Sendable {
    public var date: Date
    public var totalBytes: Int64
    public var reclaimableByType: [String: Int64]   // clé : Category.key
    public var obsoleteWorktreeBytes: Int64
    public var trashBytes: Int64
    public var reclaimableBytes: Int64 { reclaimableByType.values.reduce(0, +) + obsoleteWorktreeBytes + trashBytes }

    public init(date: Date, totalBytes: Int64, reclaimableByType: [String: Int64], obsoleteWorktreeBytes: Int64, trashBytes: Int64) {
        self.date = date; self.totalBytes = totalBytes; self.reclaimableByType = reclaimableByType
        self.obsoleteWorktreeBytes = obsoleteWorktreeBytes; self.trashBytes = trashBytes
    }

    static func url(_ paths: CairnPaths) -> URL { paths.state.appendingPathComponent("analysis-summary.json") }

    public static func load(_ paths: CairnPaths) -> AnalysisSummary? {
        guard let data = try? Data(contentsOf: url(paths)) else { return nil }
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        return try? d.decode(AnalysisSummary.self, from: data)
    }

    public func save(_ paths: CairnPaths) throws {
        try FileManager.default.createDirectory(at: paths.state, withIntermediateDirectories: true)
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.sortedKeys]
        try e.encode(self).write(to: Self.url(paths), options: .atomic)
    }

    /// Résumé d'une analyse (régénérable et corbeille du volume ; worktrees obsolètes fournis par la maintenance git).
    public static func from(roots: [Node], obsoleteWorktreeBytes: Int64 = 0, date: Date = Date()) -> AnalysisSummary {
        var byType: [String: Int64] = [:]
        for c in Category.allCases where c.isRegenerable {
            byType[c.key] = roots.reduce(0) { $0 + $1.bytes(c) }
        }
        return AnalysisSummary(date: date, totalBytes: roots.reduce(0) { $0 + $1.size }, reclaimableByType: byType,
                               obsoleteWorktreeBytes: obsoleteWorktreeBytes, trashBytes: roots.reduce(0) { $0 + $1.bytes(.trash) })
    }
}

/// Relevés de capacité des volumes (`state/volumes.json`), gardés 30 jours.
public struct VolumeHistory: Codable, Equatable, Sendable {
    public struct Reading: Codable, Equatable, Sendable {
        public let date: Date
        public let available: Int64
        public let total: Int64
        public init(date: Date, available: Int64, total: Int64) { self.date = date; self.available = available; self.total = total }
    }

    /// Clé : nom du volume.
    public var readings: [String: [Reading]] = [:]
    public init() {}

    public mutating func add(_ volume: String, _ r: Reading, keepDays: Double = 30) {
        var list = readings[volume, default: []]
        list.append(r)
        let limit = r.date.addingTimeInterval(-keepDays * 86_400)
        readings[volume] = list.filter { $0.date >= limit }
    }

    static func url(_ paths: CairnPaths) -> URL { paths.state.appendingPathComponent("volumes.json") }

    public static func load(_ paths: CairnPaths) -> VolumeHistory {
        guard let data = try? Data(contentsOf: url(paths)) else { return VolumeHistory() }
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        return (try? d.decode(VolumeHistory.self, from: data)) ?? VolumeHistory()
    }

    public func save(_ paths: CairnPaths) throws {
        try FileManager.default.createDirectory(at: paths.state, withIntermediateDirectories: true)
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601
        try e.encode(self).write(to: Self.url(paths), options: .atomic)
    }
}

/// Alertes de disque plein (décisions pures).
public enum StorageAlerts {
    public enum Level: Int, Codable, Comparable, Sendable {
        case ok = 0, low = 1, critical = 2
        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    }

    public struct Alert: Equatable, Sendable {
        public let volume: String
        public let level: Level
        public let available: Int64
        public let percentFree: Double
        /// Jours avant remplissage au rythme des 7 derniers jours (alerte anticipée).
        public let daysToFull: Double?

        public init(volume: String, level: Level, available: Int64, percentFree: Double, daysToFull: Double?) {
            self.volume = volume; self.level = level; self.available = available; self.percentFree = percentFree; self.daysToFull = daysToFull
        }
    }

    /// État anti-harcèlement par volume (`state/alerts.json`).
    public struct VolumeState: Codable, Equatable, Sendable {
        public var lastNotified: Date?
        public var lastLevel: Level = .ok
        public var snoozedUntil: Date?
        public init() {}
    }

    public static func level(available: Int64, total: Int64, alerts a: CairnConfig.Alerts) -> Level {
        guard total > 0 else { return .ok }
        let pct = Double(available) / Double(total) * 100
        let gb = Double(available) / 1_000_000_000
        if pct < a.criticalPercent || gb < a.criticalGB { return .critical }
        if pct < a.lowPercent || gb < a.lowGB { return .low }
        return .ok
    }

    /// Jours avant que le volume soit plein, par régression linéaire sur les 7 derniers jours
    /// (au moins 3 jours d'historique, pente négative ; nil sinon).
    public static func daysToFull(_ readings: [VolumeHistory.Reading], now: Date) -> Double? {
        let recent = readings.filter { now.timeIntervalSince($0.date) <= 7 * 86_400 }
        guard let first = recent.map(\.date).min(), now.timeIntervalSince(first) >= 3 * 86_400, recent.count >= 3 else { return nil }
        let xs = recent.map { $0.date.timeIntervalSince(first) / 86_400 }
        let ys = recent.map { Double($0.available) }
        let n = Double(xs.count)
        let mx = xs.reduce(0, +) / n, my = ys.reduce(0, +) / n
        let num = zip(xs, ys).reduce(0) { $0 + ($1.0 - mx) * ($1.1 - my) }
        let den = xs.reduce(0) { $0 + ($1 - mx) * ($1 - mx) }
        guard den > 0 else { return nil }
        let slope = num / den // octets par jour
        guard slope < 0, let last = recent.max(by: { $0.date < $1.date }) else { return nil }
        return Double(last.available) / -slope
    }

    /// Alerte à envoyer maintenant (nil sinon) et nouvel état du volume.
    /// Règles : une notification par volume et par jour au plus, sauf passage au niveau critique ; un volume revenu
    /// 2 points au-dessus du seuil remet le compteur à zéro ; sourdine possible ; alerte anticipée si plein dans < 7 jours.
    public static func evaluate(volume: String, reading: VolumeHistory.Reading, history: [VolumeHistory.Reading],
                                state: VolumeState, alerts a: CairnConfig.Alerts, now: Date) -> (Alert?, VolumeState) {
        var s = state
        let pct = reading.total > 0 ? Double(reading.available) / Double(reading.total) * 100 : 100
        var lvl = level(available: reading.available, total: reading.total, alerts: a)
        let days = daysToFull(history + [reading], now: now)
        if lvl == .ok, let d = days, d < 7 { lvl = .low }

        if lvl == .ok {
            // Remise à zéro seulement avec une marge de 2 points (évite les oscillations autour du seuil).
            let freeGB = Double(reading.available) / 1_000_000_000
            if pct >= a.lowPercent + 2 && freeGB >= a.lowGB { s.lastLevel = .ok; s.lastNotified = nil }
            return (nil, s)
        }
        if let until = s.snoozedUntil, now < until, lvl != .critical || s.lastLevel == .critical { return (nil, s) }
        let escalated = lvl > s.lastLevel && lvl == .critical
        let dayPassed = s.lastNotified.map { now.timeIntervalSince($0) >= 86_400 } ?? true
        guard escalated || dayPassed else { return (nil, s) }
        s.lastNotified = now
        s.lastLevel = max(lvl, s.lastLevel)
        return (Alert(volume: volume, level: lvl, available: reading.available, percentFree: pct, daysToFull: days), s)
    }

    public static func snooze(_ state: VolumeState, now: Date) -> VolumeState {
        var s = state
        s.snoozedUntil = now.addingTimeInterval(7 * 86_400)
        return s
    }

    public static func loadStates(_ paths: CairnPaths) -> [String: VolumeState] {
        guard let data = try? Data(contentsOf: paths.state.appendingPathComponent("alerts.json")) else { return [:] }
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        return (try? d.decode([String: VolumeState].self, from: data)) ?? [:]
    }

    public static func saveStates(_ states: [String: VolumeState], _ paths: CairnPaths) {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: paths.state, withIntermediateDirectories: true)
        try? e.encode(states).write(to: paths.state.appendingPathComponent("alerts.json"), options: .atomic)
    }
}
