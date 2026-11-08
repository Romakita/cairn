import Foundation

// Modification et suppression d'une destination, et disponibilité des actions de sa page.

public extension CairnConfig.Destination {
    /// Destination modifiée : seule la connexion (chemin, adresse, identifiant) vient de `edited`. L'identifiant,
    /// dont dépendent le mot de passe de l'image et l'état des sauvegardes, le type, le chiffrement et la rétention
    /// sont conservés.
    func updatingConnection(from edited: CairnConfig.Destination) -> CairnConfig.Destination {
        var d = self
        d.path = edited.path
        d.url = edited.url
        d.username = edited.username
        return d
    }
}

/// Suppression d'une destination : plan (simulation) puis exécution. Seules les sauvegardes de ce Mac sont visées ;
/// celles des autres Mac posées sur la même destination ne sont jamais listées ni supprimées.
public enum DestinationRemoval {
    public enum Item: Equatable, Sendable {
        /// Entrée de `config.toml`.
        case configuration(id: String)
        /// État des sauvegardes (`runs.json`).
        case state(id: String)
        /// Image ou dossier de ce Mac sur la destination.
        case backups(path: String, bytes: Int64)
    }

    public struct Plan: Equatable, Sendable {
        public let destination: CairnConfig.Destination
        public let includeBackups: Bool
        /// Machine dont les sauvegardes sont visées (ce Mac).
        public let machine: String
        public var items: [Item]
        /// Sauvegardes illisibles (destination injoignable, mot de passe absent…) : la suppression avec les
        /// sauvegardes est alors impossible.
        public var backupsUnavailable: String?

        public init(destination: CairnConfig.Destination, includeBackups: Bool, machine: String, items: [Item],
                    backupsUnavailable: String? = nil) {
            self.destination = destination; self.includeBackups = includeBackups; self.machine = machine
            self.items = items; self.backupsUnavailable = backupsUnavailable
        }

        public var canExecute: Bool { !includeBackups || backupsUnavailable == nil }
        public var backupBytes: Int64 {
            items.reduce(0) { if case let .backups(_, b) = $1 { return $0 + b } else { return $0 } }
        }
    }

    /// Emplacement des sauvegardes de ce Mac sous la racine de la destination.
    public static func backupsPath(base: URL, destination d: CairnConfig.Destination, machine: String) -> URL {
        if DestinationSession(d).usesImage { return base.appendingPathComponent("cairn-\(machine).sparsebundle") }
        return base.appendingPathComponent("cairn").appendingPathComponent(machine)
    }

    /// Simulation : ce que la suppression retirerait. Monte la destination si besoin (sans rien créer) et la démonte.
    public static func plan(_ d: CairnConfig.Destination, includeBackups: Bool,
                            machine: String = BackupEngine.machineName()) -> Plan {
        var plan = Plan(destination: d, includeBackups: includeBackups, machine: machine, items: [.configuration(id: d.id), .state(id: d.id)])
        guard includeBackups else { return plan }
        let provider = DestinationSession.provider(for: d)
        defer { provider.finish() }
        do {
            let base = try provider.prepare(create: false)
            let path = backupsPath(base: base, destination: d, machine: machine)
            if FileManager.default.fileExists(atPath: path.path) {
                plan.items.append(.backups(path: path.path, bytes: BackupEngine.uniqueBytes([path])))
            }
        } catch ProviderError.notCreated {
            // Rien encore sur la destination.
        } catch {
            plan.backupsUnavailable = String(describing: error)
        }
        return plan
    }

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case backupsUnavailable(String)
        case removal(String)
        public var description: String {
            switch self {
            case let .backupsUnavailable(m): L10n.tr("destination.delete.error.unavailable", m)
            case let .removal(m): L10n.tr("destination.delete.error.removal", m)
            }
        }
    }

    /// Exécute un plan sous le verrou d'opération : sauvegardes d'abord, puis état. Si la suppression sur la
    /// destination échoue, rien d'autre n'est retiré. Le mot de passe de l'image reste dans le Trousseau : il ouvre
    /// peut-être aussi une image laissée à un ancien emplacement de la destination, et une image recréée le reprend.
    /// L'appelant retire la destination de `config.toml` avant l'exécution, et la remet si elle échoue.
    public static func execute(_ plan: Plan, paths: CairnPaths) throws {
        guard plan.canExecute else { throw Failure.backupsUnavailable(plan.backupsUnavailable ?? "") }
        let lock = OperationLock(url: paths.operationLock)
        try lock.acquire(operation: "remove-destination")
        defer { lock.release() }
        if plan.includeBackups, plan.items.contains(where: { if case .backups = $0 { true } else { false } }) {
            let provider = DestinationSession.provider(for: plan.destination)
            defer { provider.finish() }
            do {
                let base = try provider.prepare(create: false)
                // Chemin recalculé sous la racine montée maintenant (le point de montage peut changer d'une session
                // à l'autre) : seules les sauvegardes de la machine du plan sont visées.
                let current = backupsPath(base: base, destination: plan.destination, machine: plan.machine)
                if FileManager.default.fileExists(atPath: current.path) { try FileManager.default.removeItem(at: current) }
            } catch let e as ProviderError {
                throw Failure.backupsUnavailable(e.description)
            } catch {
                throw Failure.removal(error.localizedDescription)
            }
        }
        var state = RunState.load(paths)
        if state.destinations.removeValue(forKey: plan.destination.id) != nil { try state.save(paths) }
    }
}

/// Actions de la page d'une destination, et raison de leur indisponibilité.
public enum BackupAction: CaseIterable, Sendable { case simulate, verify, verifyFull, backup }

public enum BackupActions {
    public struct Context: Sendable {
        /// `nil` : pas encore sondée (ne bloque pas).
        public var reachable: Bool?
        public var backingUp: Bool
        public var verifying: Bool
        public var hasBackups: Bool
        public init(reachable: Bool?, backingUp: Bool, verifying: Bool, hasBackups: Bool) {
            self.reachable = reachable; self.backingUp = backingUp; self.verifying = verifying; self.hasBackups = hasBackups
        }
    }

    /// Clé de traduction de la raison pour laquelle l'action est indisponible, `nil` si elle est possible.
    public static func unavailableReason(_ action: BackupAction, _ c: Context) -> String? {
        if c.backingUp && action != .backup { return "backup.unavailable.running" }
        if c.verifying { return "backup.unavailable.verifying" }
        if c.reachable == false { return "backup.unavailable.unreachable" }
        if !c.hasBackups && (action == .verify || action == .verifyFull) { return "backup.unavailable.nothing_to_verify" }
        return nil
    }
}
