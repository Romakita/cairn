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
    /// Parties supplémentaires fournies par d'autres capacités (outils IA) ; le 3e argument reçoit les avertissements.
    public var extraParts: ((CairnConfig, URL, (String) -> Void) throws -> [BackupPart])?

    /// Inventaire des outils de la machine (lance brew, mise, npm…). Les tests le remplacent par un inventaire vide.
    nonisolated(unsafe) public static var collectInventory: (CairnConfig) -> Inventory = { InventoryCollector.collect(config: $0) }

    private let stateLock = NSLock()
    private var running = false
    private var currentLog: URL?
    /// Arrêt de toute la sauvegarde (préparation comprise), ou de certaines destinations seulement.
    private var cancelledAll = false
    private var cancelledIDs: Set<String> = []
    /// Destinations visées pas encore terminées (nil tant que `run` ne les connaît pas) ; un moteur par destination,
    /// pour n'arrêter que celle demandée.
    private var pendingIDs: Set<String>?
    private var engines: [String: BackupEngine] = [:]

    public init(paths: CairnPaths, config: CairnConfig) {
        self.paths = paths
        self.config = config
    }

    /// Journal de la dernière exécution (aussi quand `run` a levé une erreur après l'avoir créé).
    public var logURL: URL? { stateLock.withLock { currentLog } }

    public var isRunning: Bool { stateLock.withLock { running } }

    /// Parties à sauvegarder. `staging` reçoit les fichiers générés (inventaire des outils…).
    /// `step` : étape en cours (dossier examiné, inventaire…), pour la progression.
    /// `isCancelled` : « Arrêter » pendant la préparation (parcours des dossiers, inventaire…) lève `.cancelled`.
    public func parts(staging: URL, request: Request, warn: (String) -> Void = { _ in },
                      isCancelled: () -> Bool = { false }, step: (String) -> Void = { _ in }) throws -> [BackupPart] {
        var lastStep = Date.distantPast
        func report(_ text: String) {
            guard Date().timeIntervalSince(lastStep) >= 0.1 else { return }
            lastStep = Date()
            step(text)
        }
        var parts: [BackupPart] = []
        let want = { (k: BackupPart.Kind) in request.only?.contains(k) ?? true }
        let destPaths = config.destinations.compactMap { $0.provider == .local ? (($0.path ?? "") as NSString).expandingTildeInPath : nil }
        if want(.folder) {
            var used = Set<String>()
            for f in config.folders where f.backup && f.isAvailable {
                if isCancelled() { throw BackupError.cancelled }
                var name = (f.expandedPath as NSString).lastPathComponent
                while used.contains(name) { name += "-" }
                used.insert(name)
                let excludes = BackupExclusions.forFolder(f.expandedPath, userPatterns: f.exclude, destinations: destPaths,
                                                          isCancelled: isCancelled) { dir in
                    report(L10n.tr("backup.prepare.generated", name + (dir.isEmpty ? "" : "/" + dir)))
                }
                parts.append(BackupPart(kind: .folder, target: "folders/\(name)", source: f.expandedPath, excludes: excludes))
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
        if isCancelled() { throw BackupError.cancelled }
        if want(.tools) {
            let dir = staging.appendingPathComponent("tools")
            step(L10n.tr("backup.prepare.tools"))
            let inv = Self.collectInventory(config)
            try InventoryExport.write(inv, to: dir)
            parts.append(BackupPart(kind: .tools, target: "tools", source: dir.path))
        }
        if isCancelled() { throw BackupError.cancelled }
        if want(.ai), let extra = extraParts {
            step(L10n.tr("backup.prepare.ai"))
            parts += try extra(config, staging, warn)
        }
        if isCancelled() { throw BackupError.cancelled }
        return parts
    }

    /// Lance la sauvegarde vers chaque destination demandée. Le verrou empêche deux sauvegardes simultanées.
    public func run(_ request: Request, progress report: @escaping (String, BackupProgress) -> Void = { _, _ in }) throws -> [Result] {
        let targets = config.destinations.filter { request.destinationIDs?.contains($0.id) ?? true }.map(\.id)
        stateLock.withLock {
            running = true; currentLog = nil; pendingIDs = Set(targets); engines = [:]
            // « Arrêter » cliqué avant le lancement sur toutes les destinations visées : rien ne démarre.
            if !targets.isEmpty, Set(targets).isSubset(of: cancelledIDs) { cancelledAll = true }
        }
        // Destination terminée : elle ne compte plus pour savoir si tout a été arrêté.
        let progress: (String, BackupProgress) -> Void = { [self] id, p in
            if p.finished { stateLock.withLock { _ = pendingIDs?.remove(id) } }
            report(id, p)
        }
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

        // Préparation affichée tout de suite : l'inventaire et l'ouverture de l'image prennent parfois des minutes.
        for id in targets { progress(id, .preparing(L10n.tr("backup.prepare.parts"))) }
        let parts: [BackupPart]
        // Avertissements de préparation (base d'un outil IA illisible…) : repris dans le résultat de chaque destination.
        var prepWarnings: [String] = []
        do {
            parts = try self.parts(staging: staging, request: request, warn: { prepWarnings.append($0) },
                                   isCancelled: { [self] in isCancelled }) { text in
                for id in targets { progress(id, .preparing(text)) }
            }
        } catch BackupError.cancelled {
            // « Arrêter » pendant la préparation : rien n'a été écrit, ce n'est pas un échec.
            log.write("cancelled before destinations")
            throw BackupError.cancelled
        } catch {
            log.write("error before destinations: \(error)")
            // Noté sur chaque destination visée : l'état l'affiche et la planification attend avant de relancer.
            if !request.dryRun {
                var state = RunState.load(paths)
                for d in config.destinations where request.destinationIDs?.contains(d.id) ?? true {
                    var ds = state[d.id]
                    ds.lastAttempt = Date()
                    ds.lastFailure = Date()
                    ds.lastError = String(describing: error)
                    state[d.id] = ds
                }
                try? state.save(paths)
            }
            throw error
        }
        // « Arrêter » pendant la préparation : rien n'a encore été écrit sur une destination.
        if isCancelled { log.write("cancelled before destinations"); throw BackupError.cancelled }
        log.write("parts: " + parts.map(\.target).joined(separator: ", "))
        if request.only?.contains(.ai) ?? true, let line = AIBackup.openToolsLogLine(config: config) { log.write(line) }
        var state = RunState.load(paths)
        var results: [Result] = []
        let dests = config.destinations.filter { request.destinationIDs?.contains($0.id) ?? true }
        let sleep = PowerState.IdleSleepAssertion(reason: "Cairn backup")
        defer { sleep.release() }

        // Chaque destination : copie, puis finalisation en arrière-plan (empreintes, contrôle, image) pendant que la
        // copie vers la destination suivante commence. La sauvegarde se termine quand toutes sont finalisées.
        let collected = Collected(state: state)
        let finishing = DispatchGroup()
        for d in dests {
            // Arrêt demandé : les destinations suivantes ne sont pas commencées.
            if isCancelled { break }
            if isCancelled(d.id) { log.write("\(d.id): cancelled before start"); progress(d.id, .done); continue }
            let engine = self.engine(for: d.id)
            let session = DestinationSession(d)
            var ds = collected.destination(d.id)
            ds.lastAttempt = Date()
            guard session.provider.isReachable() else {
                if ds.waitingSince == nil { ds.waitingSince = Date() }
                log.write("\(d.id): unreachable, waiting")
                progress(d.id, .done)
                collected.record(d.id, ds, Result(destination: d.id, outcome: nil, error: ProviderError.unreachable(d.id).description,
                                                  waiting: true, newImagePassword: nil, log: log.url))
                continue
            }
            progress(d.id, .preparing(L10n.tr("backup.prepare.open")))
            do {
                // Une simulation n'écrit rien : ni image, ni dossier. Sur une destination encore vide, elle simule
                // contre un dossier temporaire vide (tout serait copié).
                var root: URL
                do {
                    root = try session.open(createIfMissing: !request.dryRun)
                } catch ProviderError.notCreated where request.dryRun {
                    root = staging.appendingPathComponent("empty-destination")
                }
                // Montage du partage et de l'image (non interruptibles) : l'arrêt demandé entre-temps est pris ici.
                if engine.isCancelled { throw BackupError.cancelled }
                let versionsDir = BackupEngine.versionsDir(root: root)
                let sources = BackupEngine.linkSources(parts: parts, versionsDir: versionsDir)
                let recopy = Integrity.recopyPlan(linkSources: sources, parts: parts)
                let copied = try engine.copy(parts: parts, root: root, retention: d.retention, dryRun: request.dryRun,
                                             manifestExtra: ["cairn": CairnVersion.current, "destination": d.id,
                                                             "config_version": config.version, "log": log.url.lastPathComponent],
                                             forceRecopy: recopy, partial: request.isPartial,
                                             warnings: prepWarnings, expectedFiles: ds.fileCounts ?? [:]) { p in
                    progress(d.id, p)
                }
                let started = ds
                finishing.enter()
                WaitedWork.async {
                    defer { finishing.leave() }
                    self.finalize(d, engine: engine, session: session, copied: copied, state: started, versionsDir: versionsDir,
                                  recopy: recopy, dryRun: request.dryRun, log: log, collected: collected) { progress(d.id, $0) }
                }
            } catch {
                session.close()
                progress(d.id, .done)
                ds.lastError = String(describing: error)
                if !request.dryRun { ds.lastFailure = Date() }
                log.write("\(d.id): error \(error)")
                collected.record(d.id, ds, Result(destination: d.id, outcome: nil, error: String(describing: error), waiting: false,
                                                  newImagePassword: session.newImagePassword, log: log.url))
            }
        }
        finishing.wait()
        state = collected.state
        let order = dests.map(\.id)
        results = collected.results.sorted { (order.firstIndex(of: $0.destination) ?? 0) < (order.firstIndex(of: $1.destination) ?? 0) }
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

    /// Finalisation d'une destination copiée : empreintes, version, vérification mensuelle, fermeture (et compactage
    /// après une réussite). Tourne en arrière-plan ; l'état et le résultat vont dans `collected`.
    func finalize(_ d: CairnConfig.Destination, engine: BackupEngine, session: DestinationSession, copied: CopyResult, state started: RunState.Destination,
                  versionsDir: URL, recopy: [String: [String]], dryRun: Bool, log: RunLog, collected: Collected,
                  progress: @escaping (BackupProgress) -> Void) {
        var ds = started
        var damagedFiles: [String] = []
        var imageCheck: SparseImage.Check?
        // Compactage (long sur un NAS) seulement après une sauvegarde réussie, pas après un arrêt ou un échec.
        var succeeded = false
        defer {
            if !dryRun { progress(.finishing(L10n.tr(succeeded ? "backup.finish.compact" : "backup.finish.close"))) }
            session.close(compact: succeeded && !dryRun)
            progress(.done)
        }
        do {
            let outcome = try engine.finish(copied, progress: progress)
            succeeded = true
            outcome.warnings.forEach { log.write("\(d.id): \($0)") }
            if !dryRun {
                ds.lastSuccess = Date()
                ds.waitingSince = nil
                ds.lastError = nil
                ds.lastBytesTransferred = outcome.bytesTransferred
                ds.lastDuration = outcome.duration
                ds.fileCounts = (ds.fileCounts ?? [:]).merging(outcome.filesByPart) { $1 }
                log.write("\(d.id): version \(outcome.version ?? "-") \(outcome.bytesTransferred) bytes, deleted \(outcome.deletedVersions)")
                // Journaux des versions encore gardées : la purge des journaux les épargne.
                ds.keptLogs = BackupEngine.logs(in: versionsDir)
                // Les versions dont les fichiers abîmés viennent d'être recopiés (ou supprimées) ne comptent plus.
                ds.damagedVersions = Self.stillDamaged(ds.damagedVersions, versionsDir: versionsDir, recopied: recopy)
                // Vérification mensuelle : échantillon de la nouvelle version, puis l'image disque (détachée).
                if ds.lastVerification.map({ Date().timeIntervalSince($0) > Self.verificationInterval }) ?? true,
                   let v = outcome.version {
                    progress(.finishing(L10n.tr("backup.finish.verify")))
                    let report = Integrity.verify(version: versionsDir.appendingPathComponent(v), full: false)
                    ds.lastVerification = Date()
                    damagedFiles = report.damaged
                    if !report.damaged.isEmpty, !ds.damagedVersions.contains(v) { ds.damagedVersions.append(v) }
                    log.write("\(d.id): verification \(report.checked) files, \(report.damaged.count) damaged")
                    report.damaged.prefix(50).forEach { log.write("\(d.id): damaged \(v)/\($0)") }
                    progress(.finishing(L10n.tr("backup.finish.image")))
                    if let check = session.verifyImage() {
                        imageCheck = check
                        ds.lastImageCheck = Date()
                        ds.lastImageCheckOK = check.ok
                        log.write("\(d.id): image verify \(check.ok ? "ok" : "FAILED"): \(check.output)")
                    }
                }
            }
            collected.record(d.id, ds, Result(destination: d.id, outcome: outcome, error: nil, waiting: false,
                                              newImagePassword: session.newImagePassword, damagedFiles: damagedFiles,
                                              imageCheck: imageCheck, log: log.url))
        } catch {
            ds.lastError = String(describing: error)
            if !dryRun { ds.lastFailure = Date() }
            log.write("\(d.id): error \(error)")
            collected.record(d.id, ds, Result(destination: d.id, outcome: nil, error: String(describing: error), waiting: false,
                                              newImagePassword: session.newImagePassword, log: log.url))
        }
    }

    /// État et résultats des destinations, remplis depuis plusieurs finalisations à la fois.
    final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var _state: RunState
        private var _results: [Result] = []
        init(state: RunState) { _state = state }
        var state: RunState { lock.withLock { _state } }
        var results: [Result] { lock.withLock { _results } }
        func destination(_ id: String) -> RunState.Destination { lock.withLock { _state[id] } }
        func record(_ id: String, _ ds: RunState.Destination, _ result: Result) {
            lock.withLock { _state[id] = ds; _results.append(result) }
        }
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

    /// Arrête toute la sauvegarde : préparation, copie et finalisations en cours.
    public func cancel() {
        let all = stateLock.withLock { () -> [BackupEngine] in
            cancelledAll = true
            return Array(engines.values)
        }
        all.forEach { $0.cancel() }
    }

    /// Arrête une destination seulement ; les autres continuent. Si plus aucune destination visée ne reste,
    /// toute la sauvegarde s'arrête (y compris la préparation commune).
    public func cancel(destination id: String) {
        let (engine, everything) = stateLock.withLock { () -> (BackupEngine?, Bool) in
            cancelledIDs.insert(id)
            // Avant `run`, les destinations visées sont inconnues : l'arrêt est noté, `run` le reprend.
            guard let pendingIDs else { return (nil, false) }
            return (engines[id], pendingIDs.isSubset(of: cancelledIDs))
        }
        if everything { cancel() } else { engine?.cancel() }
    }

    var isCancelled: Bool { stateLock.withLock { cancelledAll } }
    func isCancelled(_ id: String) -> Bool { stateLock.withLock { cancelledAll || cancelledIDs.contains(id) } }

    /// Moteur de la destination (copie et finalisation), déjà arrêté si l'arrêt a été demandé entre-temps.
    private func engine(for id: String) -> BackupEngine {
        let e = BackupEngine()
        let stop = stateLock.withLock { () -> Bool in
            engines[id] = e
            return cancelledAll || cancelledIDs.contains(id)
        }
        if stop { e.cancel() }
        return e
    }

    /// Veille : les rsync de toutes les destinations sont suspendus, puis repris au réveil.
    public func suspend() { stateLock.withLock { Array(engines.values) }.forEach { $0.suspend() } }
    public func resume() { stateLock.withLock { Array(engines.values) }.forEach { $0.resume() } }

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
