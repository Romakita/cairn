import Foundation

/// État de la page d'accueil (hub) : état global, problèmes classés par priorité et état de chaque module.
/// Décisions pures, calculées à partir de données déjà disponibles (aucune analyse lancée) ; les libellés sont
/// produits par l'app.
public struct HubState: Equatable, Sendable {
    /// Problème signalé. L'ordre des genres donne la priorité (le premier est le plus urgent).
    public struct Issue: Equatable, Sendable, Comparable {
        public enum Kind: Int, Comparable, Sendable, CaseIterable {
            case configInvalid, backupFailed, diskCritical, destinationOverdue, diskLow, folderUnavailable, versionsDamaged
            public static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }
        }
        public let kind: Kind
        /// Objet du problème : volume, destination (libellé), dossier ; vide pour la configuration.
        public let subject: String
        /// Identifiant pour la navigation : id de la destination, nom du volume, chemin du dossier.
        public let ref: String?
        /// Précision : ligne fautive de la configuration, espace libre du volume…
        public let detail: String?
        public let bytes: Int64?

        public init(kind: Kind, subject: String, ref: String? = nil, detail: String? = nil, bytes: Int64? = nil) {
            self.kind = kind; self.subject = subject; self.ref = ref; self.detail = detail; self.bytes = bytes
        }

        /// Erreur pour la configuration invalide et la sauvegarde en échec (comme l'icône de la barre des menus).
        public var level: Health.Level { kind == .configInvalid || kind == .backupFailed ? .error : .attention }

        public static func < (a: Issue, b: Issue) -> Bool { a.kind < b.kind }
    }

    public enum Module: String, CaseIterable, Sendable { case storage, backup, git, ai, restore }

    /// Ton d'une carte : `unknown` tant que le module n'a pas de données, `info` quand une action est possible.
    public enum Tone: String, Sendable { case ok, info, attention, error, unknown }

    /// Chiffre ou phrase clé d'une carte.
    public enum Figure: Equatable, Sendable {
        case notAnalyzed
        case free(Int64)
        case noDestination
        case backingUp
        case failed(String)
        case unreachable(String)
        case lastBackup(Date)
        case neverBackedUp
        case gitCandidates(Int)
        case gitClean
        case aiTools(Int)
        case noAITool
        case versions(Int)
        case lastVersion(Date)
        case noVersion
    }

    /// Ligne secondaire d'une carte.
    public enum Detail: Equatable, Sendable {
        case none
        case reclaimable(Int64)
        case nextBackup(Date)
        case backupDue
        case manualSchedule
        case gitReclaimable(Int64)
        case aiLastBackup(Date)
        case destinations(Int)
        case damaged(Int)
        case latestVersion
    }

    /// Action principale : navigation, ou sauvegarde pour « Sauvegarder maintenant ». Jamais destructive.
    public enum Action: String, Sendable { case clean, analyze, backupNow, addDestination, openBackup, analyzeGit, openGit, viewAI, restore }

    public struct ModuleState: Equatable, Sendable {
        public let module: Module
        public let tone: Tone
        public let figure: Figure
        public let detail: Detail
        public let action: Action
    }

    /// Données d'entrée (valeurs simples fournies par l'app ou par les tests).
    public struct Inputs: Sendable {
        public struct Destination: Sendable {
            public var id: String
            public var label: String
            public var state: RunState.Destination
            /// Injoignable au dernier contrôle.
            public var waiting: Bool
            public init(id: String, label: String, state: RunState.Destination = .init(), waiting: Bool = false) {
                self.id = id; self.label = label; self.state = state; self.waiting = waiting
            }
        }

        /// Erreurs bloquantes de `config.toml` (description avec la ligne).
        public var configErrors: [String] = []
        public var destinations: [Destination] = []
        public var schedule = CairnConfig.Schedule()
        /// Alertes de volume en cours (tous les volumes suivis).
        public var volumeAlerts: [StorageAlerts.Alert] = []
        public var unavailableFolders: [String] = []
        /// Espace libre du volume principal (nil si inconnu).
        public var freeBytes: Int64?
        public var summary: AnalysisSummary?
        public var gitReports: [RepoReport]?
        public var gitOptions = GitOptions()
        /// Outils IA détectés (nil : pas encore relevé).
        public var aiDetected: Int?
        public var aiLastBackup: Date?
        /// Nombre de versions par destination, quand la liste a été lue.
        public var versions: [String: Int] = [:]
        public var isBackingUp = false
        public var now = Date()
        public var calendar = Calendar.current

        public init() {}
    }

    public let overall: Health.Level
    /// Problèmes triés par priorité.
    public let causes: [Issue]
    public let modules: [ModuleState]
    public var topIssue: Issue? { causes.first }

    public func module(_ m: Module) -> ModuleState { modules.first { $0.module == m }! }

    /// État global seul (icône de la barre des menus) : le niveau le plus grave des problèmes.
    public static func overall(of i: Inputs) -> Health.Level { issues(i).map(\.level).max() ?? .ok }

    public static func make(_ i: Inputs) -> HubState {
        let causes = issues(i)
        let overall = causes.map(\.level).max() ?? .ok
        let modules: [ModuleState] = [storage(i), backup(i), git(i), ai(i), restore(i)]
        return HubState(overall: overall, causes: causes, modules: modules)
    }

    /// Problèmes en cours, du plus urgent au moins urgent (même règles que l'icône de la barre des menus).
    public static func issues(_ i: Inputs) -> [Issue] {
        var out: [Issue] = i.configErrors.map { Issue(kind: .configInvalid, subject: "", detail: $0) }
        for d in i.destinations {
            switch Health.destination(d.state, waiting: d.waiting, schedule: i.schedule, now: i.now, calendar: i.calendar) {
            case .error:
                out.append(Issue(kind: .backupFailed, subject: d.label, ref: d.id))
            case .attention:
                if !d.state.damagedVersions.isEmpty {
                    out.append(Issue(kind: .versionsDamaged, subject: d.label, ref: d.id, bytes: Int64(d.state.damagedVersions.count)))
                } else {
                    out.append(Issue(kind: .destinationOverdue, subject: d.label, ref: d.id))
                }
            case .ok: break
            }
        }
        for a in i.volumeAlerts {
            out.append(Issue(kind: a.level == .critical ? .diskCritical : .diskLow, subject: a.volume, ref: a.volume, bytes: a.available))
        }
        out += i.unavailableFolders.map { Issue(kind: .folderUnavailable, subject: ($0 as NSString).lastPathComponent, ref: $0) }
        // Tri stable : à priorité égale, l'ordre d'entrée est gardé.
        return out.enumerated().sorted { ($0.element.kind, $0.offset) < ($1.element.kind, $1.offset) }.map(\.element)
    }

    static func storage(_ i: Inputs) -> ModuleState {
        let level = i.volumeAlerts.map(\.level).max() ?? .ok
        let tone: Tone = level == .critical ? .error : (level == .low ? .attention : (i.summary == nil ? .unknown : .ok))
        let figure: Figure = i.freeBytes.map { .free($0) } ?? .notAnalyzed
        guard let s = i.summary else {
            return ModuleState(module: .storage, tone: tone, figure: figure, detail: .none, action: .analyze)
        }
        return ModuleState(module: .storage, tone: tone, figure: figure, detail: .reclaimable(s.reclaimableBytes),
                           action: s.reclaimableBytes > 0 ? .clean : .analyze)
    }

    static func backup(_ i: Inputs) -> ModuleState {
        guard !i.destinations.isEmpty else {
            return ModuleState(module: .backup, tone: .attention, figure: .noDestination, detail: .none, action: .addDestination)
        }
        let levels = i.destinations.map {
            Health.destination($0.state, waiting: $0.waiting, schedule: i.schedule, now: i.now, calendar: i.calendar)
        }
        let worst = levels.max() ?? .ok
        let last = i.destinations.compactMap(\.state.lastSuccess).max()
        var tone: Tone = worst == .error ? .error : (worst == .attention ? .attention : (last == nil ? .unknown : .ok))
        let figure: Figure
        if i.isBackingUp {
            figure = .backingUp
        } else if let failed = i.destinations.first(where: { $0.state.lastError != nil }) {
            figure = .failed(failed.label)
        } else if let w = i.destinations.first(where: \.waiting) {
            figure = .unreachable(w.label)
            if tone == .ok || tone == .unknown { tone = .info }
        } else if let last {
            figure = .lastBackup(last)
        } else {
            figure = .neverBackedUp
        }
        let detail: Detail
        if i.schedule.frequency == .manual {
            detail = .manualSchedule
        } else if let next = i.destinations.compactMap({ Health.nextBackup(i.schedule, lastSuccess: $0.state.lastSuccess,
                                                                           now: i.now, calendar: i.calendar) }).min() {
            detail = next <= i.now ? .backupDue : .nextBackup(next)
        } else {
            detail = .destinations(i.destinations.count)
        }
        return ModuleState(module: .backup, tone: tone, figure: figure, detail: detail,
                           action: worst == .error ? .openBackup : .backupNow)
    }

    static func git(_ i: Inputs) -> ModuleState {
        guard let reports = i.gitReports else {
            return ModuleState(module: .git, tone: .unknown, figure: .notAnalyzed, detail: .none, action: .analyzeGit)
        }
        let branches = reports.flatMap(\.branches).filter { GitMaintenance.selectedByDefault($0, options: i.gitOptions) }.count
        let worktrees = reports.flatMap(\.worktrees).filter { GitMaintenance.selectedByDefault($0, options: i.gitOptions) }
        let count = branches + worktrees.count
        let bytes = reports.reduce(Int64(0)) { $0 + $1.reclaimableBytes } + worktrees.reduce(Int64(0)) { $0 + $1.size }
        guard count > 0 else {
            return ModuleState(module: .git, tone: .ok, figure: .gitClean, detail: .none, action: .openGit)
        }
        return ModuleState(module: .git, tone: .info, figure: .gitCandidates(count),
                           detail: bytes > 0 ? .gitReclaimable(bytes) : .none, action: .openGit)
    }

    static func ai(_ i: Inputs) -> ModuleState {
        guard let n = i.aiDetected else {
            return ModuleState(module: .ai, tone: .unknown, figure: .notAnalyzed, detail: .none, action: .viewAI)
        }
        return ModuleState(module: .ai, tone: n > 0 ? .ok : .unknown, figure: n > 0 ? .aiTools(n) : .noAITool,
                           detail: i.aiLastBackup.map { .aiLastBackup($0) } ?? .none, action: .viewAI)
    }

    static func restore(_ i: Inputs) -> ModuleState {
        let damaged = i.destinations.reduce(0) { $0 + $1.state.damagedVersions.count }
        let last = i.destinations.compactMap(\.state.lastSuccess).max()
        let known = i.destinations.compactMap { i.versions[$0.id] }
        let figure: Figure = !known.isEmpty ? .versions(known.reduce(0, +)) : (last.map { .lastVersion($0) } ?? .noVersion)
        let tone: Tone = damaged > 0 ? .attention : (last == nil && known.reduce(0, +) == 0 ? .unknown : .ok)
        let detail: Detail = damaged > 0 ? .damaged(damaged) : (known.isEmpty && last != nil ? .latestVersion : .none)
        return ModuleState(module: .restore, tone: tone, figure: figure, detail: detail,
                           action: .restore)
    }
}

// MARK: - Dernière vérification complète

/// État persistant du hub (`state/hub.json`) : heure de la dernière vérification complète.
public struct HubRecord: Codable, Equatable, Sendable {
    public var lastCheck: Date?
    public init(lastCheck: Date? = nil) { self.lastCheck = lastCheck }

    static func url(_ paths: CairnPaths) -> URL { paths.state.appendingPathComponent("hub.json") }

    public static func load(_ paths: CairnPaths) -> HubRecord {
        guard let data = try? Data(contentsOf: url(paths)) else { return HubRecord() }
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        return (try? d.decode(HubRecord.self, from: data)) ?? HubRecord()
    }

    public func save(_ paths: CairnPaths) throws {
        try FileManager.default.createDirectory(at: paths.state, withIntermediateDirectories: true)
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601
        try e.encode(self).write(to: Self.url(paths), options: .atomic)
    }
}

/// Jeton d'annulation partagé entre threads (vérification complète).
public final class CancelToken: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    public init() {}
    public func cancel() { lock.withLock { flag = true } }
    public var isCancelled: Bool { lock.withLock { flag } }
}
