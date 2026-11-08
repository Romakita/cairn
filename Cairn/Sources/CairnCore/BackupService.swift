import Foundation

/// Assemble et lance une sauvegarde à partir de la configuration (utilisé par l'app et par `cairn backup`).
public final class BackupService: @unchecked Sendable {
    public struct Request: Sendable {
        public var destinationIDs: [String]? = nil   // nil = toutes
        public var dryRun = false
        public var only: Set<BackupPart.Kind>? = nil  // nil = tout
        public var aiTools: [String]? = nil           // limiter la partie IA
        public init() {}
        /// Sauvegarde d'une partie seulement : la version est marquée partielle.
        public var isPartial: Bool { only != nil || aiTools != nil }
    }

    public struct Result: Sendable {
        public let destination: String
        public let outcome: BackupOutcome?
        public let error: String?
        public let waiting: Bool
        public let newImagePassword: String?
        /// Fichiers abîmés trouvés par la vérification mensuelle (chemins relatifs à la version).
        public let damagedFiles: [String]
        /// Contrôle de l'image disque fait pendant cette sauvegarde (vérification mensuelle).
        public let imageCheck: SparseImage.Check?
        /// Journal de l'exécution.
        public let log: URL?

        public init(destination: String, outcome: BackupOutcome?, error: String?, waiting: Bool, newImagePassword: String?,
                    damagedFiles: [String] = [], imageCheck: SparseImage.Check? = nil, log: URL? = nil) {
            self.destination = destination; self.outcome = outcome; self.error = error; self.waiting = waiting
            self.newImagePassword = newImagePassword; self.damagedFiles = damagedFiles; self.imageCheck = imageCheck; self.log = log
        }
    }

    /// Erreurs de la vérification à la demande.
    public enum VerifyFailure: Error, Equatable, CustomStringConvertible {
        case unknownVersion(String)
        public var description: String {
            switch self { case let .unknownVersion(v): L10n.tr("cli.verify.unknown_version", v) }
        }
    }

    /// Intervalle de la vérification automatique (échantillon et image).
    public static let verificationInterval: TimeInterval = 30 * 86_400

    public let paths: CairnPaths
    public let config: CairnConfig
    public let engine = BackupEngine()
    /// Parties supplémentaires fournies par d'autres capacités (outils IA) ; le 3e argument reçoit les avertissements.
    public var extraParts: ((CairnConfig, URL, (String) -> Void) throws -> [BackupPart])?

    private let stateLock = NSLock()
    private var running = false
    private var currentLog: URL?

    public init(paths: CairnPaths, config: CairnConfig) {
        self.paths = paths
        self.config = config
    }

    /// Journal de la dernière exécution (aussi quand `run` a levé une erreur après l'avoir créé).
    public var logURL: URL? { stateLock.withLock { currentLog } }

    public var isRunning: Bool { stateLock.withLock { running } }

    /// Parties à sauvegarder. `staging` reçoit les fichiers générés (inventaire des outils…).
    public func parts(staging: URL, request: Request, warn: (String) -> Void = { _ in }) throws -> [BackupPart] {
        var parts: [BackupPart] = []
        let want = { (k: BackupPart.Kind) in request.only?.contains(k) ?? true }
        let destPaths = config.destinations.compactMap { $0.provider == .local ? (($0.path ?? "") as NSString).expandingTildeInPath : nil }
        if want(.folder) {
            var used = Set<String>()
            for f in config.folders where f.backup && f.isAvailable {
                var name = (f.expandedPath as NSString).lastPathComponent
                while used.contains(name) { name += "-" }
                used.insert(name)
                parts.append(BackupPart(kind: .folder, target: "folders/\(name)", source: f.expandedPath,
                                        excludes: BackupExclusions.forFolder(f.expandedPath, userPatterns: f.exclude, destinations: destPaths)))
            }
        }
        if want(.home) {
            let home = NSHomeDirectory()
            let items = BackupExclusions.homeItems(config.home.include, home: home)
            if !items.isEmpty {
                parts.append(BackupPart(kind: .home, target: "home", source: home,
                                        excludes: BackupExclusions.homeExcludes + config.home.exclude, filesFrom: items))
            }
        }
        if want(.tools) {
            let dir = staging.appendingPathComponent("tools")
            let inv = InventoryCollector.collect(config: config)
            try InventoryExport.write(inv, to: dir)
            parts.append(BackupPart(kind: .tools, target: "tools", source: dir.path))
        }
        if want(.ai), let extra = extraParts {
            parts += try extra(config, staging, warn)
        }
        return parts
    }

    /// Lance la sauvegarde vers chaque destination demandée. Le verrou empêche deux sauvegardes simultanées.
    public func run(_ request: Request, progress: @escaping (String, BackupProgress) -> Void = { _, _ in }) throws -> [Result] {
        stateLock.withLock { running = true; currentLog = nil }
        // Déclaré en premier : exécuté en dernier, une fois l'image détachée et le verrou rendu.
        defer { stateLock.withLock { running = false } }
        let lock = OperationLock(url: paths.operationLock)
        try lock.acquire(operation: request.dryRun ? "backup-dry-run" : "backup")
        defer { lock.release() }
        let log = RunLog(paths: paths, type: request.dryRun ? "backup-dry-run" : "backup")
        stateLock.withLock { currentLog = log.url }
        defer { log.close() }
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-staging-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }

        let parts: [BackupPart]
        // Avertissements de préparation (base d'un outil IA illisible…) : repris dans le résultat de chaque destination.
        var prepWarnings: [String] = []
        do { parts = try self.parts(staging: staging, request: request, warn: { prepWarnings.append($0) }) } catch {
            log.write("error before destinations: \(error)")
            // Noté sur chaque destination visée : l'état l'affiche et la planification attend avant de relancer.
            if !request.dryRun {
                var state = RunState.load(paths)
                for d in config.destinations where request.destinationIDs?.contains(d.id) ?? true {
                    var ds = state[d.id]
                    ds.lastAttempt = Date()
                    ds.lastError = String(describing: error)
                    state[d.id] = ds
                }
                try? state.save(paths)
            }
            throw error
        }
        log.write("parts: " + parts.map(\.target).joined(separator: ", "))
        if request.only?.contains(.ai) ?? true, let line = AIBackup.openToolsLogLine(config: config) { log.write(line) }
        var state = RunState.load(paths)
        var results: [Result] = []
        let dests = config.destinations.filter { request.destinationIDs?.contains($0.id) ?? true }
        let sleep = PowerState.IdleSleepAssertion(reason: "Cairn backup")
        defer { sleep.release() }

        for d in dests {
            let session = DestinationSession(d)
            var ds = state[d.id]
            ds.lastAttempt = Date()
            guard session.provider.isReachable() else {
                if ds.waitingSince == nil { ds.waitingSince = Date() }
                state[d.id] = ds
                log.write("\(d.id): unreachable, waiting")
                results.append(Result(destination: d.id, outcome: nil, error: ProviderError.unreachable(d.id).description,
                                      waiting: true, newImagePassword: nil, log: log.url))
                continue
            }
            var damagedFiles: [String] = []
            var imageCheck: SparseImage.Check?
            do {
                // Une simulation n'écrit rien : ni image, ni dossier. Sur une destination encore vide, elle simule
                // contre un dossier temporaire vide (tout serait copié).
                var root: URL
                do {
                    root = try session.open(createIfMissing: !request.dryRun)
                } catch ProviderError.notCreated where request.dryRun {
                    root = staging.appendingPathComponent("empty-destination")
                }
                defer { session.close(compact: !request.dryRun) }
                let versionsDir = BackupEngine.versionsDir(root: root)
                let sources = BackupEngine.linkSources(parts: parts, versionsDir: versionsDir)
                let recopy = Integrity.recopyPlan(linkSources: sources, parts: parts)
                let outcome = try engine.run(parts: parts, root: root, retention: d.retention, dryRun: request.dryRun,
                                             manifestExtra: ["cairn": CairnVersion.current, "destination": d.id,
                                                             "config_version": config.version, "log": log.url.lastPathComponent],
                                             forceRecopy: recopy, partial: request.isPartial,
                                             warnings: prepWarnings) { p in
                    progress(d.id, p)
                }
                outcome.warnings.forEach { log.write("\(d.id): \($0)") }
                if !request.dryRun {
                    ds.lastSuccess = Date()
                    ds.waitingSince = nil
                    ds.lastError = nil
                    ds.lastBytesTransferred = outcome.bytesTransferred
                    ds.lastDuration = outcome.duration
                    log.write("\(d.id): version \(outcome.version ?? "-") \(outcome.bytesTransferred) bytes, deleted \(outcome.deletedVersions)")
                    // Journaux des versions encore gardées : la purge des journaux les épargne.
                    ds.keptLogs = BackupEngine.logs(in: versionsDir)
                    // Les versions dont les fichiers abîmés viennent d'être recopiés (ou supprimées) ne comptent plus.
                    ds.damagedVersions = Self.stillDamaged(ds.damagedVersions, versionsDir: versionsDir, recopied: recopy)
                    // Vérification mensuelle : échantillon de la nouvelle version, puis l'image disque (détachée).
                    if ds.lastVerification.map({ Date().timeIntervalSince($0) > Self.verificationInterval }) ?? true,
                       let v = outcome.version {
                        let report = Integrity.verify(version: versionsDir.appendingPathComponent(v), full: false)
                        ds.lastVerification = Date()
                        damagedFiles = report.damaged
                        if !report.damaged.isEmpty, !ds.damagedVersions.contains(v) { ds.damagedVersions.append(v) }
                        log.write("\(d.id): verification \(report.checked) files, \(report.damaged.count) damaged")
                        report.damaged.prefix(50).forEach { log.write("\(d.id): damaged \(v)/\($0)") }
                        if let check = session.verifyImage() {
                            imageCheck = check
                            ds.lastImageCheck = Date()
                            ds.lastImageCheckOK = check.ok
                            log.write("\(d.id): image verify \(check.ok ? "ok" : "FAILED"): \(check.output)")
                        }
                    }
                }
                results.append(Result(destination: d.id, outcome: outcome, error: nil, waiting: false,
                                      newImagePassword: session.newImagePassword, damagedFiles: damagedFiles,
                                      imageCheck: imageCheck, log: log.url))
            } catch {
                ds.lastError = String(describing: error)
                log.write("\(d.id): error \(error)")
                results.append(Result(destination: d.id, outcome: nil, error: String(describing: error), waiting: false,
                                      newImagePassword: session.newImagePassword, log: log.url))
            }
            state[d.id] = ds
        }
        if !request.dryRun {
            try? state.save(paths)
            // Activité récente de l'accueil : réussite ou échec par destination (sans le message d'erreur).
            let activity = ActivityLog(paths: paths)
            for r in results where !r.waiting {
                activity.append(.init(kind: r.error == nil ? .backupSucceeded : .backupFailed, subject: r.destination,
                                      bytes: r.outcome?.bytesTransferred))
            }
        }
        return results
    }

    /// Versions encore abîmées : présentes sur la destination, avec des fichiers abîmés qui n'ont pas tous été
    /// recopiés depuis la source par cette sauvegarde (`recopied` : partie → chemins relatifs à la partie).
    public static func stillDamaged(_ versions: [String], versionsDir: URL, recopied: [String: [String]]) -> [String] {
        let present = Set(BackupEngine.versions(in: versionsDir))
        let fixed = Set(recopied.flatMap { target, list in list.map { target + "/" + $0 } })
        var seen = Set<String>()
        return versions.filter { v in
            guard present.contains(v), seen.insert(v).inserted else { return false }
            let damaged = Integrity.readDamaged(versionsDir.appendingPathComponent(v))
            return !damaged.isEmpty && !damaged.isSubset(of: fixed)
        }
    }

    public func cancel() { engine.cancel() }

    /// Attend la fin de `run` (rsync arrêté, image détachée, verrou rendu) ; `false` si le délai est dépassé.
    @discardableResult
    public func waitUntilFinished(timeout: TimeInterval) -> Bool {
        let limit = Date().addingTimeInterval(timeout)
        while isRunning {
            if Date() >= limit { return false }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return true
    }

    // MARK: Vérification à la demande (app et `cairn verify`)

    /// Vérifie une destination : la dernière version (échantillon), toutes les versions (`full`) ou `version`.
    /// Prend le verrou d'opération et note le résultat dans `runs.json` (`lastVerification`, `damagedVersions`).
    public static func verify(destination d: CairnConfig.Destination, paths: CairnPaths, version: String? = nil,
                              full: Bool, now: Date = Date()) throws -> [Integrity.Report] {
        let lock = OperationLock(url: paths.operationLock)
        try lock.acquire(operation: "verify")
        defer { lock.release() }
        let session = DestinationSession(d)
        let root = try session.open(createIfMissing: false)
        defer { session.close() }
        let dir = BackupEngine.versionsDir(root: root)
        let all = BackupEngine.versions(in: dir)
        if let version, !all.contains(version) { throw VerifyFailure.unknownVersion(version) }
        let targets = version.map { [$0] } ?? (full ? all : Array(all.suffix(1)))
        let reports = targets.map { Integrity.verify(version: dir.appendingPathComponent($0), full: full) }
        recordVerification(reports, destination: d.id, paths: paths, now: now)
        return reports
    }

    /// Note une vérification dans l'état : date et versions abîmées (sans doublon).
    public static func recordVerification(_ reports: [Integrity.Report], destination: String, paths: CairnPaths, now: Date = Date()) {
        guard reports.contains(where: { !$0.missingChecksums }) else { return }
        var state = RunState.load(paths)
        var ds = state[destination]
        ds.lastVerification = now
        for r in reports where !r.damaged.isEmpty && !ds.damagedVersions.contains(r.version) {
            ds.damagedVersions.append(r.version)
        }
        state[destination] = ds
        try? state.save(paths)
    }
}
