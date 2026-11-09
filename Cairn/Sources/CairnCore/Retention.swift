import Foundation

/// Versions à garder selon la rétention (fonction pure, testée avec une horloge simulée).
public enum RetentionPolicy {
    /// Renvoie les dates des versions à garder.
    /// - `tiered` : toutes celles de moins de `days` jours, puis la plus récente de chaque semaine ISO sur `weeks` semaines.
    /// - `count` : les `n` plus récentes.
    public static func keep(_ versions: [Date], retention: CairnConfig.Retention, now: Date) -> Set<Date> {
        let sorted = versions.sorted(by: >)
        switch retention {
        case let .count(n):
            return Set(sorted.prefix(max(n, 1)))
        case let .tiered(days, weeks):
            var keep = Set<Date>()
            let dailyLimit = now.addingTimeInterval(-Double(days) * 86_400)
            let weeklyLimit = dailyLimit.addingTimeInterval(-Double(weeks) * 7 * 86_400)
            var cal = Calendar(identifier: .iso8601)
            cal.timeZone = TimeZone(identifier: "UTC")!
            var seenWeeks = Set<String>()
            for d in sorted {
                if d >= dailyLimit {
                    keep.insert(d)
                } else if d >= weeklyLimit {
                    let c = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: d)
                    let key = "\(c.yearForWeekOfYear ?? 0)-\(c.weekOfYear ?? 0)"
                    if seenWeeks.insert(key).inserted { keep.insert(d) } // la plus récente de la semaine
                }
            }
            // Toujours garder au moins la dernière version.
            if let last = sorted.first { keep.insert(last) }
            return keep
        }
    }

    /// La nouvelle rétention peut-elle supprimer des versions que l'ancienne gardait ? (sans lire la destination)
    /// Passer d'un type de rétention à l'autre compte comme plus court : on ne peut pas le prouver sans les versions.
    public static func mayDeleteMore(_ new: CairnConfig.Retention, than old: CairnConfig.Retention) -> Bool {
        switch (old, new) {
        case let (.count(a), .count(b)): b < a
        case let (.tiered(d1, w1), .tiered(d2, w2)): d2 < d1 || d2 + 7 * w2 < d1 + 7 * w1
        default: true
        }
    }

    /// Nombre maximal de versions et durée couverte, pour l'affichage dans les réglages.
    public static func coverage(_ retention: CairnConfig.Retention, frequency: CairnConfig.Frequency) -> (maxVersions: Int, days: Int) {
        switch retention {
        case let .tiered(days, weeks):
            let daily = frequency == .daily ? days : (days + 6) / 7
            return (daily + weeks, days + weeks * 7)
        case let .count(n):
            let interval = frequency == .weekly ? 7 : 1
            return (n, n * interval)
        }
    }
}

/// État des sauvegardes (`~/.cairn/state/runs.json`).
public struct RunState: Codable, Equatable, Sendable {
    public struct Destination: Codable, Equatable, Sendable {
        public var lastSuccess: Date?
        public var lastAttempt: Date?
        public var lastError: String?
        /// Dernier échec réel (pas une destination injoignable) : la planification attend avant de relancer.
        public var lastFailure: Date?
        public var waitingSince: Date?          // destination injoignable
        public var lastOverdueNotice: Date?
        public var lastVerification: Date?
        public var damagedVersions: [String] = []
        /// Dernier contrôle de l'image disque (`hdiutil verify`) et son résultat.
        public var lastImageCheck: Date?
        public var lastImageCheckOK: Bool?
        public var lastBytesTransferred: Int64 = 0
        public var lastDuration: Double = 0
        /// Fichiers par partie lors de la dernière sauvegarde : total attendu de la barre de progression.
        public var fileCounts: [String: Int]?
        /// Journaux des versions encore présentes sur la destination (épargnés par la purge des journaux).
        public var keptLogs: [String]?
        public init() {}
    }

    public var destinations: [String: Destination] = [:]
    public init() {}

    public static func load(_ paths: CairnPaths) -> RunState {
        let url = paths.state.appendingPathComponent("runs.json")
        guard let data = try? Data(contentsOf: url) else { return RunState() }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return (try? d.decode(RunState.self, from: data)) ?? RunState()
    }

    public func save(_ paths: CairnPaths) throws {
        try FileManager.default.createDirectory(at: paths.state, withIntermediateDirectories: true)
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        try e.encode(self).write(to: paths.state.appendingPathComponent("runs.json"), options: .atomic)
    }

    /// Journaux à garder quelle que soit leur ancienneté.
    public var keptLogs: Set<String> { Set(destinations.values.flatMap { $0.keptLogs ?? [] }) }

    public subscript(id: String) -> Destination {
        get { destinations[id] ?? Destination() }
        set { destinations[id] = newValue }
    }
}
