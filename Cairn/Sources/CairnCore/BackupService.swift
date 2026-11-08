import Foundation

/// Assemble et lance une sauvegarde à partir de la configuration (utilisé par l'app et par `cairn backup`).
public final class BackupService: @unchecked Sendable {
    public struct Request: Sendable {
        public var destinationIDs: [String]? = nil   // nil = toutes
        public var dryRun = false
        public var only: Set<BackupPart.Kind>? = nil  // nil = tout
        public var aiTools: [String]? = nil           // limiter la partie IA
        public init() {}
    }

    public struct Result: Sendable {
        public let destination: String
        public let outcome: BackupOutcome?
        public let error: String?
        public let waiting: Bool
        public let newImagePassword: String?
    }

    public let paths: CairnPaths
    public let config: CairnConfig
    public let engine = BackupEngine()
    /// Parties supplémentaires fournies par d'autres capacités (outils IA).
    public var extraParts: ((CairnConfig, URL) throws -> [BackupPart])?

    public init(paths: CairnPaths, config: CairnConfig) {
        self.paths = paths
        self.config = config
    }

    /// Parties à sauvegarder. `staging` reçoit les fichiers générés (inventaire des outils…).
    public func parts(staging: URL, request: Request) throws -> [BackupPart] {
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
            parts += try extra(config, staging)
        }
        return parts
    }

    /// Lance la sauvegarde vers chaque destination demandée. Le verrou empêche deux sauvegardes simultanées.
    public func run(_ request: Request, progress: @escaping (String, BackupProgress) -> Void = { _, _ in }) throws -> [Result] {
        let lock = OperationLock(url: paths.operationLock)
        try lock.acquire(operation: request.dryRun ? "backup-dry-run" : "backup")
        defer { lock.release() }
        let log = RunLog(paths: paths, type: request.dryRun ? "backup-dry-run" : "backup")
        defer { log.close() }
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-staging-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }

        let parts = try parts(staging: staging, request: request)
        log.write("parts: " + parts.map(\.target).joined(separator: ", "))
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
                                      waiting: true, newImagePassword: nil))
                continue
            }
            do {
                let root = try session.open()
                defer { session.close(compact: !request.dryRun) }
                let versionsDir = BackupEngine.versionsDir(root: root)
                let previous = BackupEngine.versions(in: versionsDir).last.map { versionsDir.appendingPathComponent($0) }
                let outcome = try engine.run(parts: parts, root: root, retention: d.retention, dryRun: request.dryRun,
                                             manifestExtra: ["cairn": "1", "destination": d.id, "config_version": config.version],
                                             forceRecopy: Integrity.recopyPlan(previous: previous, parts: parts)) { p in
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
                    // Vérification mensuelle par échantillon.
                    if ds.lastVerification.map({ Date().timeIntervalSince($0) > 30 * 86_400 }) ?? true, let v = outcome.version {
                        let report = Integrity.verify(version: versionsDir.appendingPathComponent(v), full: false)
                        ds.lastVerification = Date()
                        if !report.damaged.isEmpty { ds.damagedVersions.append(v) }
                        log.write("\(d.id): verification \(report.checked) files, \(report.damaged.count) damaged")
                    }
                }
                results.append(Result(destination: d.id, outcome: outcome, error: nil, waiting: false,
                                      newImagePassword: session.newImagePassword))
            } catch {
                ds.lastError = String(describing: error)
                log.write("\(d.id): error \(error)")
                results.append(Result(destination: d.id, outcome: nil, error: String(describing: error), waiting: false,
                                      newImagePassword: session.newImagePassword))
            }
            state[d.id] = ds
        }
        if !request.dryRun { try? state.save(paths) }
        return results
    }

    public func cancel() { engine.cancel() }
}
