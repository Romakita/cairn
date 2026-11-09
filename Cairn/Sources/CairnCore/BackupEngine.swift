import Foundation

/// Version de Cairn écrite dans les manifests.
public enum CairnVersion {
    /// Version du code : égale au fichier `Cairn/VERSION` (un test le vérifie ; la CI les met à jour à chaque release).
    public static let fallback = "0.6.1"
    /// Version du bundle .app si disponible, sinon la constante.
    public static var current: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    }
}

/// Une partie copiée dans une version (`folders/<nom>`, `home`, `ai/<outil>`, `tools`…).
public struct BackupPart: Sendable {
    public enum Kind: String, Sendable { case folder, home, ai, tools }
    public let kind: Kind
    /// Chemin de la partie dans la version (ex. « folders/workspaces »).
    public let target: String
    public let source: String
    public let excludes: [String]
    /// Copie limitée à ces chemins relatifs (`--files-from`), sinon tout le dossier.
    public let filesFrom: [String]?

    public init(kind: Kind, target: String, source: String, excludes: [String] = [], filesFrom: [String]? = nil) {
        self.kind = kind; self.target = target; self.source = source; self.excludes = excludes; self.filesFrom = filesFrom
    }
}

/// Un compteur parallèle : fichiers trouvés, dernier chemin vu, terminé ou non.
public struct CountWorker: Sendable, Equatable {
    public var found = 0
    public var current = ""
    /// Dossier du premier niveau pris dans la pile.
    public var folder = ""
    public var done = false
    public init(found: Int = 0, current: String = "", folder: String = "", done: Bool = false) {
        self.found = found; self.current = current; self.folder = folder; self.done = done
    }
}

public struct BackupProgress: Sendable {
    /// Compteurs parallèles (vide une fois le total connu ou sans comptage).
    public var workers: [CountWorker] = []
    public var part: String
    /// Fichiers copiés (nouveaux ou modifiés).
    public var files: Int
    public var bytes: Int64
    /// Dernier fichier traité (chemin relatif à la partie).
    public var current: String
    /// Fichiers examinés (copiés ou repris de la version précédente), toutes parties confondues.
    public var processed: Int = 0
    /// Fichiers attendus : décompte de la sauvegarde précédente, sinon comptés avant de commencer.
    public var expected: Int?
    /// Comptage des fichiers encore en cours (il tourne en même temps que la copie) ; `found` : trouvés jusqu'ici.
    public var counting = false
    public var found = 0
    /// Étape de préparation en cours (inventaire, connexion, ouverture de l'image), avant le comptage.
    public var preparing: String?
    /// Finalisation après la copie (empreintes, vérification, image) : étape, avancement de l'étape.
    public var finishing: String?
    public var stepDone: Int?
    public var stepTotal: Int?
    public var stepFraction: Double? {
        guard let stepDone, let stepTotal, stepTotal > 0 else { return nil }
        return min(Double(stepDone) / Double(stepTotal), 1)
    }

    /// Destination terminée (finalisée, ou en échec) : plus rien à afficher pour elle.
    public var finished = false
    public static var done: BackupProgress {
        var p = BackupProgress(part: "", files: 0, bytes: 0, current: "")
        p.finished = true
        return p
    }

    /// Étape de finalisation, avec son avancement quand il est connu.
    public static func finishing(_ step: String, done: Int? = nil, total: Int? = nil, current: String = "") -> BackupProgress {
        var p = BackupProgress(part: "", files: 0, bytes: 0, current: current)
        p.finishing = step; p.stepDone = done; p.stepTotal = total
        return p
    }

    /// Dossier dont rsync dresse la liste (aucun fichier encore traité pour lui), et depuis quand.
    public var listing: String?
    public var listingSince: Date?
    /// Dossier du premier niveau en cours de copie : rang (à partir de 1) et nombre de dossiers de la partie.
    public var chunk: Int?
    public var chunks: Int?

    public init(part: String, files: Int, bytes: Int64, current: String, processed: Int = 0, expected: Int? = nil,
                counting: Bool = false, found: Int = 0, preparing: String? = nil) {
        self.part = part; self.files = files; self.bytes = bytes; self.current = current
        self.processed = processed; self.expected = expected; self.counting = counting; self.found = found
        self.preparing = preparing
    }

    /// Étape de préparation (rien de compté ni copié).
    public static func preparing(_ step: String) -> BackupProgress {
        BackupProgress(part: "", files: 0, bytes: 0, current: "", preparing: step)
    }

    /// Avancement de 0 à 1 ; plafonné à 99 % tant que la sauvegarde n'est pas finie (l'estimation peut être courte).
    public var fraction: Double? {
        guard !counting, preparing == nil, finishing == nil, let expected, expected > 0 else { return nil }
        return min(Double(processed) / Double(expected), 0.99)
    }
}

public struct BackupOutcome: Sendable {
    public let version: String?          // nil en simulation
    public let dryRun: Bool
    public let bytesByPart: [String: Int64]
    /// Fichiers examinés par partie : estimation de la prochaine sauvegarde.
    public var filesByPart: [String: Int] = [:]
    public let filesTransferred: Int
    public let bytesTransferred: Int64
    public let warnings: [String]
    public let deletedVersions: [String]
    public let duration: TimeInterval
    public var totalBytes: Int64 { bytesByPart.values.reduce(0, +) }
}

public enum BackupError: Error, CustomStringConvertible {
    /// `detail` : dernières lignes d'erreur de rsync (cause de l'échec).
    case rsyncFailed(part: String, status: Int32, detail: String = "")
    case cancelled
    case destination(String)
    public var description: String {
        switch self {
        case let .rsyncFailed(part, status, detail):
            L10n.tr("backup.error.rsync", part, Int(status)) + (detail.isEmpty ? "" : "\n" + detail)
        case .cancelled: L10n.tr("backup.error.cancelled")
        case let .destination(m): m
        }
    }
}

/// Moteur de sauvegarde : rsync en sous-processus, versions par `--link-dest`, reprise des versions interrompues.
public final class BackupEngine: @unchecked Sendable {
    /// Format des noms de version (heure locale, triable).
    public static let versionFormat = "yyyy-MM-dd'T'HHmmss"
    public static let incompletePrefix = ".incomplete-"
    /// Une version incomplète plus vieille que ça est jetée.
    public static let maxResumeAge: TimeInterval = 7 * 86_400

    private let lock = NSLock()
    /// rsync en cours : la copie et les compteurs (plusieurs à la fois).
    private var processes: [ObjectIdentifier: Process] = [:]
    private var cancelled = false
    /// rsync GNU de Homebrew : liens physiques gardés (`-H`), à condition de copier une partie en un seul rsync.
    static var preservesHardLinks: Bool { rsyncPath == "/opt/homebrew/bin/rsync" }

    /// Nombre de rsync parallèles pour compter les fichiers d'une partie.
    public static let countWorkers = 4

    public init() {}

    public static var rsyncPath: String {
        FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/rsync") ? "/opt/homebrew/bin/rsync" : "/usr/bin/rsync"
    }

    public static func machineName() -> String {
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        return name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
    }

    static func formatter() -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = versionFormat
        return f
    }

    public static func date(ofVersion name: String) -> Date? { formatter().date(from: name) }

    /// Dossier des versions d'une machine sur une destination montée.
    public static func versionsDir(root: URL, machine: String = machineName()) -> URL {
        root.appendingPathComponent("cairn").appendingPathComponent(machine).appendingPathComponent("versions")
    }

    /// Version partielle (`--only`, une seule partie) : elle ne sert ni de base aux suivantes, ni de « latest »,
    /// ni de version par défaut à la restauration, et la rétention ne la compte pas.
    public static func isPartial(_ version: URL) -> Bool {
        guard let data = try? Data(contentsOf: version.appendingPathComponent("manifest.json")),
              let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return m["partial"] as? Bool ?? false
    }

    /// Pour chaque partie, la version la plus récente qui la contient (base de `--link-dest` et des empreintes).
    public static func linkSources(parts: [BackupPart], versionsDir: URL) -> [String: URL] {
        let all = versions(in: versionsDir).reversed().map { versionsDir.appendingPathComponent($0) }
        var out: [String: URL] = [:]
        for part in parts {
            if let v = all.first(where: { FileManager.default.fileExists(atPath: $0.appendingPathComponent(part.target).path) }) {
                out[part.target] = v
            }
        }
        return out
    }

    /// Journaux cités par les manifests des versions présentes.
    public static func logs(in versionsDir: URL) -> [String] {
        versions(in: versionsDir).compactMap { v -> String? in
            guard let data = try? Data(contentsOf: versionsDir.appendingPathComponent(v).appendingPathComponent("manifest.json")),
                  let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return m["log"] as? String
        }.sorted()
    }

    /// Versions terminées, de la plus ancienne à la plus récente.
    public static func versions(in dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { !$0.hasPrefix(".") && $0 != "latest" && date(ofVersion: $0) != nil }
            .sorted()
    }

    // MARK: Contrôle

    public func cancel() {
        lock.withLock {
            cancelled = true
            for p in processes.values where p.isRunning { p.terminate() }
        }
        // rsync bloqué sur un partage qui ne répond plus ignore SIGTERM : on force au bout de 5 s.
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.signalAll(SIGKILL)
        }
    }

    /// Veille : rsync est suspendu puis repris au réveil.
    public func suspend() { signalAll(SIGSTOP) }
    public func resume() { signalAll(SIGCONT) }

    private func signalAll(_ sig: Int32) {
        lock.withLock { for p in processes.values where p.isRunning { kill(p.processIdentifier, sig) } }
    }

    var isCancelled: Bool { lock.withLock { cancelled } }

    // MARK: Exécution

    /// Sauvegarde les parties dans une nouvelle version (ou simule si `dryRun`) : copie puis finalisation.
    public func run(parts: [BackupPart], root: URL, retention: CairnConfig.Retention, dryRun: Bool,
                    machine: String = BackupEngine.machineName(), now: Date = Date(),
                    manifestExtra: [String: Any] = [:], forceRecopy: [String: [String]] = [:], partial: Bool = false,
                    warnings initialWarnings: [String] = [], expectedFiles: [String: Int] = [:],
                    progress: @escaping (BackupProgress) -> Void = { _ in }) throws -> BackupOutcome {
        let c = try copy(parts: parts, root: root, retention: retention, dryRun: dryRun, machine: machine, now: now,
                         manifestExtra: manifestExtra, forceRecopy: forceRecopy, partial: partial,
                         warnings: initialWarnings, expectedFiles: expectedFiles, progress: progress)
        return try finish(c, progress: progress)
    }

    /// Copie des parties dans la version de travail (rsync). La version n'existe qu'après `finish`.
    public func copy(parts: [BackupPart], root: URL, retention: CairnConfig.Retention, dryRun: Bool,
                     machine: String = BackupEngine.machineName(), now: Date = Date(),
                     manifestExtra: [String: Any] = [:], forceRecopy: [String: [String]] = [:], partial: Bool = false,
                     warnings initialWarnings: [String] = [], expectedFiles: [String: Int] = [:],
                     progress: @escaping (BackupProgress) -> Void = { _ in }) throws -> CopyResult {
        let start = Date()
        let fm = FileManager.default
        let versionsDir = Self.versionsDir(root: root, machine: machine)
        // Une simulation n'écrit rien sur la destination, pas même le dossier des versions.
        if !dryRun { try fm.createDirectory(at: versionsDir, withIntermediateDirectories: true) }
        let sources = Self.linkSources(parts: parts, versionsDir: versionsDir)

        // Version de travail : reprise d'une version incomplète récente, sinon nouvelle.
        var work: URL
        // Reprise d'une version interrompue : des fichiers y sont déjà, rsync ne signale pas ceux qui n'ont pas changé.
        var resumed = false
        let incompletes = ((try? fm.contentsOfDirectory(atPath: versionsDir.path)) ?? []).filter { $0.hasPrefix(Self.incompletePrefix) }.sorted()
        if dryRun {
            work = versionsDir.appendingPathComponent(".dryrun-\(UUID().uuidString)")
        } else if let last = incompletes.last,
                  let d = Self.date(ofVersion: String(last.dropFirst(Self.incompletePrefix.count))),
                  now.timeIntervalSince(d) < Self.maxResumeAge {
            work = versionsDir.appendingPathComponent(last)
            resumed = true
            for old in incompletes.dropLast() { try? fm.removeItem(at: versionsDir.appendingPathComponent(old)) }
        } else {
            for old in incompletes { try? fm.removeItem(at: versionsDir.appendingPathComponent(old)) }
            work = versionsDir.appendingPathComponent(Self.incompletePrefix + Self.formatter().string(from: now))
        }
        if !dryRun { try fm.createDirectory(at: work, withIntermediateDirectories: true) }

        var bytesByPart: [String: Int64] = [:]
        var transferred: [String: [String]] = [:]
        var filesByPart: [String: Int] = [:]
        var files = 0
        var processed = 0
        var bytes: Int64 = 0
        var warnings = initialWarnings
        // Fichiers attendus : décompte de la sauvegarde précédente, sinon comptage en arrière-plan, pendant la copie
        // (rsync -n, plusieurs à la fois). Le pourcentage s'affiche dès que le total est connu.
        let counter = FileCounter(known: parts.compactMap { expectedFiles[$0.target] }.reduce(0, +))
        let toCount = parts.filter { expectedFiles[$0.target] == nil }
        let countGroup = ProcessGroup()
        let counting = DispatchGroup()
        if toCount.isEmpty {
            counter.finish()
        } else {
            DispatchQueue.global(qos: .utility).async(group: counting) { [self] in
                for part in toCount where !countGroup.isAborted {
                    let n = try? countFiles(part, group: countGroup, worker: { counter.setWorker($0, $1) }) { counter.add($0) }
                    if let n, !countGroup.isAborted { counter.setPart(part.target, n) }
                }
                if !countGroup.isAborted { counter.finish() }
            }
        }
        // Copie finie, annulée ou en échec : le comptage n'a plus d'utilité.
        defer {
            countGroup.abort()
            counting.wait()
        }
        // Dernier état connu, renvoyé chaque seconde : le comptage et la durée d'une liste avancent même quand rsync
        // ne signale aucun fichier (liste d'un gros dossier).
        let live = LiveProgress()
        let heartbeat = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        heartbeat.schedule(deadline: .now() + 1, repeating: 1)
        heartbeat.setEventHandler {
            guard var p = live.last else { return }
            let (total, found) = counter.state
            p.expected = total; p.counting = total == nil; p.found = found
            p.workers = total == nil ? counter.workers : []
            progress(p)
        }
        heartbeat.resume()
        defer { heartbeat.cancel() }
        func report(_ part: String, files: Int, current: String, processed: Int, listing: String? = nil,
                    chunk: Int? = nil, chunks: Int? = nil) {
            let (total, found) = counter.state
            var p = BackupProgress(part: part, files: files, bytes: bytes, current: current, processed: processed,
                                   expected: total, counting: total == nil, found: found)
            p.listing = listing
            p.workers = total == nil ? counter.workers : []
            p.chunk = chunk; p.chunks = chunks
            p.listingSince = listing == nil ? nil : (live.last?.listing == listing ? live.last?.listingSince : nil) ?? Date()
            live.last = p
            progress(p)
        }
        for part in parts {
            if isCancelled { throw BackupError.cancelled }
            let dest = work.appendingPathComponent(part.target)
            let done = processed
            // Partie en cours affichée dès son début (rsync peut parcourir longtemps avant le premier fichier).
            report(part.target, files: files, current: "", processed: done)
            let linkDest = sources[part.target]?.appendingPathComponent(part.target)
            // Un rsync par dossier du premier niveau : la liste de chacun est vite dressée, la progression avance
            // dès le début au lieu d'attendre la liste complète (plusieurs minutes pour des centaines de milliers
            // de fichiers sur un NAS).
            // rsync GNU (-H) : un seul rsync, sinon les liens physiques entre deux dossiers du premier niveau seraient
            // copiés deux fois.
            let chunks = Self.preservesHardLinks ? [(label: String?.none, filters: [String]())] : Self.copyChunks(part)
            var seen = 0
            var names: [String] = []
            var status: Int32 = 0
            var allSucceeded = true
            var errorLines: [String] = []
            for (i, chunk) in chunks.enumerated() {
                if isCancelled { throw BackupError.cancelled }
                let base = seen, copied = names.count
                let rank = chunks.count > 1 ? i + 1 : nil, ranks = chunks.count > 1 ? chunks.count : nil
                report(part.target, files: files + copied, current: "", processed: done + base,
                       listing: chunk.label ?? (chunks.count > 1 ? "" : nil), chunk: rank, chunks: ranks)
                let r = try rsync(part: part, dest: dest, linkDest: linkDest, dryRun: dryRun,
                                  forceRecopy: i == 0 ? forceRecopy[part.target] ?? [] : [],
                                  filters: chunk.filters, deleteExcluded: chunk.filters.isEmpty) { n, m, cur in
                    seen = base + m
                    report(part.target, files: files + copied + n, current: cur, processed: done + base + m,
                           listing: m == 0 ? chunk.label ?? (chunks.count > 1 ? "" : nil) : nil, chunk: rank, chunks: ranks)
                }
                names += r.0
                // Code le plus grave : un échec (≠ 0, 23, 24) l'emporte sur un transfert partiel.
                if r.1 != 0, status == 0 || status == 23 || status == 24 { status = r.1 }
                if r.1 != 0 { allSucceeded = false }
                if !r.2.isEmpty { errorLines.append(r.2) }
            }
            let errors = errorLines.joined(separator: "\n")
            // Reprise copiée par morceaux (sans --delete-excluded) : une passe qui ne copie rien retire ce qui a disparu
            // de la source et ce qui est désormais exclu. Seulement si toutes les copies ont réussi et que la source
            // est lisible : une source absente ne doit jamais vider la version.
            if resumed, !dryRun, chunks.count > 1, allSucceeded,
               (try? fm.contentsOfDirectory(atPath: part.source)) != nil {
                report(part.target, files: files + names.count, current: "", processed: done + seen)
                _ = try rsync(part: part, dest: dest, linkDest: nil, dryRun: false, forceRecopy: [],
                              extraArgs: ["--existing", "--ignore-existing"]) { _, _, _ in }
            }
            // Total retenu pour la prochaine fois : le comptage complet de la partie ; à défaut, les fichiers vus,
            // sauf en reprise (les fichiers déjà là n'y figurent pas : l'ancien total est gardé).
            if let n = counter.counted(part.target) { filesByPart[part.target] = n }
            else if !resumed { filesByPart[part.target] = seen }
            processed += seen
            if isCancelled { throw BackupError.cancelled }
            // 23/24 : transfert partiel (fichier illisible ou disparu pendant la copie) → avertissement.
            if status == 23 || status == 24 {
                warnings.append(L10n.tr("backup.warning.partial", part.target, Int(status)) + (errors.isEmpty ? "" : "\n" + errors))
            }
            else if status != 0 { throw BackupError.rsyncFailed(part: part.target, status: status, detail: errors) }
            let partBytes = names.reduce(Int64(0)) { sum, n in
                let attrs = try? fm.attributesOfItem(atPath: (part.source as NSString).appendingPathComponent(n))
                return sum + ((attrs?[.type] as? FileAttributeType) == .typeRegular ? ((attrs?[.size] as? Int64) ?? 0) : 0)
            }
            bytesByPart[part.target] = partBytes
            transferred[part.target] = names
            files += names.count
            bytes += partBytes
        }

        return CopyResult(work: work, versionsDir: versionsDir, sources: sources, parts: parts, manifestExtra: manifestExtra,
                          now: now, machine: machine, partial: partial, retention: retention, dryRun: dryRun, start: start,
                          bytesByPart: bytesByPart, filesByPart: filesByPart, files: files, bytes: bytes, warnings: warnings)
    }

    /// Finalisation d'une copie : empreintes des fichiers nouveaux ou modifiés, manifest, version visible, rétention.
    /// Peut tourner pendant la copie vers une autre destination ; « Arrêter » l'interrompt entre deux fichiers.
    public func finish(_ c: CopyResult, progress: @escaping (BackupProgress) -> Void = { _ in }) throws -> BackupOutcome {
        let fm = FileManager.default
        let (work, versionsDir, parts, now, machine, partial, bytes) = (c.work, c.versionsDir, c.parts, c.now, c.machine, c.partial, c.bytes)
        if c.dryRun {
            var outcome = BackupOutcome(version: nil, dryRun: true, bytesByPart: c.bytesByPart, filesTransferred: c.files,
                                        bytesTransferred: bytes, warnings: c.warnings, deletedVersions: [],
                                        duration: Date().timeIntervalSince(c.start))
            outcome.filesByPart = c.filesByPart
            return outcome
        }

        // Empreintes (fichiers transférés hachés, autres repris de la version précédente) puis manifest.
        progress(.finishing(L10n.tr("backup.finish.listing")))
        try Integrity.writeChecksums(version: work, linkSources: c.sources, isCancelled: { [weak self] in self?.isCancelled ?? false }) { done, total, file in
            progress(.finishing(L10n.tr("backup.finish.checksums", Fmt.count(done), Fmt.count(total)), done: done, total: total, current: file))
        }
        if isCancelled { throw BackupError.cancelled }
        progress(.finishing(L10n.tr("backup.finish.version")))
        var manifest: [String: Any] = c.manifestExtra
        manifest["format"] = 1
        manifest["date"] = ISO8601DateFormatter().string(from: now)
        manifest["machine"] = machine
        manifest["arch"] = Self.arch()
        manifest["macos"] = ProcessInfo.processInfo.operatingSystemVersionString
        manifest["parts"] = parts.map { ["kind": $0.kind.rawValue, "target": $0.target, "source": $0.source] }
        manifest["bytes_transferred"] = bytes
        manifest["partial"] = partial
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: work.appendingPathComponent("manifest.json"))

        // Version terminée : renommage atomique, lien « latest », rétention.
        let name = String(work.lastPathComponent.dropFirst(Self.incompletePrefix.count))
        let final = versionsDir.appendingPathComponent(name)
        try fm.moveItem(at: work, to: final)
        if !partial {
            let latest = versionsDir.appendingPathComponent("latest")
            try? fm.removeItem(at: latest)
            try? fm.createSymbolicLink(atPath: latest.path, withDestinationPath: name)
        }

        let deleted = try applyRetention(versionsDir: versionsDir, retention: c.retention, now: now)
        var outcome = BackupOutcome(version: name, dryRun: false, bytesByPart: c.bytesByPart, filesTransferred: c.files,
                                    bytesTransferred: bytes, warnings: c.warnings, deletedVersions: deleted,
                                    duration: Date().timeIntervalSince(c.start))
        outcome.filesByPart = c.filesByPart
        return outcome
    }

    /// Supprime les versions hors rétention (seulement après une réussite).
    @discardableResult
    public func applyRetention(versionsDir: URL, retention: CairnConfig.Retention, now: Date) throws -> [String] {
        let deleted = Self.excessVersions(versionsDir: versionsDir, retention: retention, now: now)
        for n in deleted { try FileManager.default.removeItem(at: versionsDir.appendingPathComponent(n)) }
        return deleted
    }

    /// Versions qui seraient supprimées avec une autre rétention (pour la confirmation dans les réglages).
    /// La politique porte sur les versions complètes ; une version partielle est gardée tant qu'aucune version
    /// complète plus récente ne la remplace.
    public static func excessVersions(versionsDir: URL, retention: CairnConfig.Retention, now: Date) -> [String] {
        let dated = versions(in: versionsDir).compactMap { n in date(ofVersion: n).map { (n, $0) } }
        let partial = Set(dated.map(\.0).filter { isPartial(versionsDir.appendingPathComponent($0)) })
        let complete = dated.filter { !partial.contains($0.0) }
        let keep = RetentionPolicy.keep(complete.map(\.1), retention: retention, now: now)
        let newestComplete = complete.map(\.1).max()
        return dated.filter { n, d in
            partial.contains(n) ? (newestComplete.map { d < $0 } ?? false) : !keep.contains(d)
        }.map(\.0)
    }

    /// Octets des fichiers qui n'existent que dans ces versions (lien unique ou partagés entre elles) : espace libéré.
    public static func uniqueBytes(_ dirs: [URL]) -> Int64 {
        var counts: [UInt64: (Int, Int64, Int)] = [:] // inode → (vus, taille, liens)
        for d in dirs {
            guard let e = FileManager.default.enumerator(atPath: d.path) else { continue }
            for case let rel as String in e {
                var st = stat()
                guard lstat(d.appendingPathComponent(rel).path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { continue }
                let c = counts[st.st_ino] ?? (0, Int64(st.st_blocks) * 512, Int(st.st_nlink))
                counts[st.st_ino] = (c.0 + 1, c.1, c.2)
            }
        }
        return counts.values.filter { $0.0 >= $0.2 }.reduce(0) { $0 + $1.1 }
    }

    public static func arch() -> String {
        var u = utsname()
        uname(&u)
        return withUnsafePointer(to: &u.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
    }

    /// Nombre de fichiers d'une partie (exclusions comprises) : simulation vers un dossier vide, rien n'est écrit.
    /// Les dossiers du premier niveau forment une pile partagée : chacun des `workers` rsync en prend un, le compte,
    /// puis prend le suivant jusqu'à ce que la pile soit vide. Les exclusions de la partie s'appliquent avant le
    /// filtre du dossier : le total est le même qu'avec un seul rsync. `progress` reçoit les fichiers trouvés depuis
    /// le dernier appel ; `worker(rang, état)` l'avancement de chaque worker.
    public func countFiles(_ part: BackupPart, workers: Int = BackupEngine.countWorkers, group: ProcessGroup? = nil,
                           worker: @escaping (Int, CountWorker) -> Void = { _, _ in },
                           progress: @escaping (Int) -> Void = { _ in }) throws -> Int {
        let items = Self.copyChunks(part)
        let pile = WorkPile(count: items.count)
        let total = FileCounter(known: 0)
        DispatchQueue.concurrentPerform(iterations: max(1, min(workers, items.count))) { w in
            var found = 0
            while !(group?.isAborted ?? false), let k = pile.next() {
                let label = items[k].label ?? ""
                worker(w, CountWorker(found: found, folder: label))
                let empty = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-count-\(UUID().uuidString)")
                var last = 0
                let base = found
                let r = try? rsync(part: part, dest: empty, linkDest: nil, dryRun: true, forceRecopy: [],
                                   filters: items[k].filters, deleteExcluded: items[k].filters.isEmpty, group: group) { _, m, cur in
                    progress(m - last)
                    last = m
                    worker(w, CountWorker(found: base + m, current: cur, folder: label))
                }
                let n = r?.0.count ?? 0
                progress(n - last)
                found += n
                total.add(n)
            }
            worker(w, CountWorker(found: found, done: true))
        }
        return total.state.found
    }

    /// Copie d'une partie en morceaux : un par dossier du premier niveau, puis un pour les fichiers du premier niveau.
    /// Un seul morceau sans filtre pour une liste de fichiers, un dossier sans sous-dossier ou un nom avec joker.
    public static func copyChunks(_ part: BackupPart) -> [(label: String?, filters: [String])] {
        let fm = FileManager.default
        let names = ((try? fm.contentsOfDirectory(atPath: part.source)) ?? []).sorted()
        guard part.filesFrom == nil, names.count > 1,
              !names.contains(where: { $0.contains(where: { "*?[]\\".contains($0) }) }) else { return [(nil, [])] }
        var isDir: ObjCBool = false
        let dirs = names.filter {
            fm.fileExists(atPath: (part.source as NSString).appendingPathComponent($0), isDirectory: &isDir) && isDir.boolValue
        }
        let files = names.filter { !dirs.contains($0) }
        guard !dirs.isEmpty else { return [(nil, [])] }
        var chunks: [(label: String?, filters: [String])] = dirs.map { ($0, ["--include=/\($0)", "--include=/\($0)/**", "--exclude=*"]) }
        if !files.isEmpty { chunks.append((nil, files.map { "--include=/\($0)" } + ["--exclude=*"])) }
        return chunks
    }


    /// Lance rsync pour une partie ; renvoie les fichiers transférés (relatifs à la source) et le code de sortie.
    /// `progress(copiés, examinés, fichier courant)`, au plus dix fois par seconde.
    /// `filters` : règles ajoutées après les exclusions de la partie ; `group` : arrêt groupé (comptage).
    func rsync(part: BackupPart, dest: URL, linkDest: URL?, dryRun: Bool, forceRecopy: [String],
               filters: [String] = [], deleteExcluded: Bool = true, extraArgs: [String] = [], group: ProcessGroup? = nil,
               progress: @escaping (Int, Int, String) -> Void) throws -> ([String], Int32, String) {
        let fm = FileManager.default
        // Simulation : openrsync échoue avec -n et --link-dest vers un dossier absent. On compare donc directement
        // à la version de base : la liste obtenue est exactement ce qui serait copié, et -n n'écrit rien.
        var dest = dest, linkDest = linkDest
        if dryRun, let base = linkDest, fm.fileExists(atPath: base.path) { dest = base; linkDest = nil }
        let tmp = fm.temporaryDirectory.appendingPathComponent("cairn-\(UUID().uuidString)")
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tmp) }

        // Sans --delete-excluded quand des filtres limitent la copie à un dossier : les autres dossiers, exclus
        // par `--exclude=*`, seraient effacés de la version.
        var args = ["-a", "--out-format=%i|%n", "--partial-dir=.cairn-partial", "--delete"]
        if deleteExcluded { args.append("--delete-excluded") }
        // rsync GNU (Homebrew) : liens physiques de la source conservés (décision 3 du design).
        if Self.rsyncPath == "/opt/homebrew/bin/rsync" { args.insert("-H", at: 1) }
        if dryRun { args.append("-n") }
        if !part.excludes.isEmpty {
            let f = tmp.appendingPathComponent("exclude.txt")
            try (part.excludes.joined(separator: "\n") + "\n").write(to: f, atomically: true, encoding: .utf8)
            args.append("--exclude-from=\(f.path)")
        }
        args += filters + extraArgs
        if let list = part.filesFrom {
            let f = tmp.appendingPathComponent("files.txt")
            try (list.joined(separator: "\n") + "\n").write(to: f, atomically: true, encoding: .utf8)
            args += ["-r", "--files-from=\(f.path)"]
        }
        // Fichiers abîmés dans la version précédente : jamais liés, toujours recopiés depuis la source.
        if let linkDest, fm.fileExists(atPath: linkDest.path), forceRecopy.isEmpty {
            args.append("--link-dest=\(linkDest.path)")
        } else if let linkDest, fm.fileExists(atPath: linkDest.path) {
            args.append("--link-dest=\(linkDest.path)")
            let f = tmp.appendingPathComponent("recopy.txt")
            try (forceRecopy.map { "/" + $0 }.joined(separator: "\n") + "\n").write(to: f, atomically: true, encoding: .utf8)
            // Copie préalable sans lien des fichiers abîmés.
            if !dryRun {
                try fm.createDirectory(at: dest, withIntermediateDirectories: true)
                let pre = Process()
                pre.executableURL = URL(fileURLWithPath: Self.rsyncPath)
                pre.arguments = ["-a", "--files-from=\(f.path)", part.source + "/", dest.path + "/"]
                try pre.run(); pre.waitUntilExit()
            }
        }
        if !dryRun { try fm.createDirectory(at: dest, withIntermediateDirectories: true) }
        args += [part.source.hasSuffix("/") ? part.source : part.source + "/", dest.path + "/"]

        let p = Process()
        p.executableURL = URL(fileURLWithPath: Self.rsyncPath)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        // Erreurs gardées (20 dernières lignes) : la cause d'un échec va dans le message et le journal.
        let errPipe = Pipe()
        p.standardError = errPipe
        let errors = RsyncErrors()
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { errors.append(d) }
        }
        // Publié seulement une fois lancé : terminate() sur un processus non lancé lève une exception.
        try p.run()
        let id = ObjectIdentifier(p)
        let cancelledBeforeStart = lock.withLock { () -> Bool in
            processes[id] = p
            return cancelled
        }
        let aborted = group?.add(p) ?? false
        defer {
            lock.withLock { processes[id] = nil }
            group?.remove(p)
        }
        if cancelledBeforeStart || aborted { p.terminate() }

        var names: [String] = []
        var buffer = Data()
        var count = 0
        var examined = 0
        var lastReport = Date.distantPast
        let handle = pipe.fileHandleForReading
        while true {
            // Pool par lecture : les blocs autoreleased s'accumuleraient sinon pendant toute la sauvegarde.
            let chunk = autoreleasepool { handle.availableData }
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                buffer.removeSubrange(buffer.startIndex...nl)
                // « >f… » : fichier réellement transféré ; « hf » : lié à la version précédente ; « cd » : dossier.
                guard let bar = line.firstIndex(of: "|") else { continue }
                let item = line[line.startIndex..<bar]
                // Deuxième caractère « f » : un fichier, copié (>f, <f) ou repris de la version précédente (hf).
                guard item.dropFirst().first == "f" else { continue }
                let name = String(line[line.index(after: bar)...])
                examined += 1
                if item.hasPrefix(">f") || item.hasPrefix("<f") {
                    names.append(name)
                    count += 1
                }
                if Date().timeIntervalSince(lastReport) >= 0.1 {
                    lastReport = Date()
                    progress(count, examined, name)
                }
            }
        }
        p.waitUntilExit()
        errPipe.fileHandleForReading.readabilityHandler = nil
        errors.append(errPipe.fileHandleForReading.readDataToEndOfFile())
        progress(count, examined, "")
        return (names, p.terminationStatus, errors.tail)
    }
}

/// Sortie d'erreur de rsync, lue au fil de l'eau ; seules les dernières lignes sont gardées.
final class RsyncErrors: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    private var partial = ""

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.withLock {
            let text = partial + String(decoding: data, as: UTF8.self)
            var parts = text.components(separatedBy: "\n")
            partial = parts.removeLast()
            lines = Array((lines + parts.filter { !$0.isEmpty }).suffix(20))
        }
    }

    var tail: String {
        lock.withLock { (lines + (partial.isEmpty ? [] : [partial])).suffix(20).joined(separator: "\n") }
    }
}

/// Total de fichiers attendus, rempli en arrière-plan par le comptage.
final class FileCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var found: Int
    private var done = false

    init(known: Int) { found = known }

    private var workerStates: [Int: CountWorker] = [:]
    private var perPart: [String: Int] = [:]

    /// Total d'une partie entièrement comptée.
    func setPart(_ target: String, _ n: Int) { lock.withLock { perPart[target] = n } }
    func counted(_ target: String) -> Int? { lock.withLock { perPart[target] } }

    func add(_ n: Int) { lock.withLock { found += n } }
    func setWorker(_ i: Int, _ w: CountWorker) { lock.withLock { workerStates[i] = w } }
    var workers: [CountWorker] { lock.withLock { workerStates.keys.sorted().compactMap { workerStates[$0] } } }
    func finish() { lock.withLock { done = true } }

    /// Total (`nil` tant que le comptage tourne) et fichiers trouvés jusqu'ici.
    var state: (total: Int?, found: Int) { lock.withLock { (done ? found : nil, found) } }
}

/// rsync lancés ensemble (compteurs) : `abort()` les arrête tous, et ceux lancés ensuite aussitôt.
public final class ProcessGroup: @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [ObjectIdentifier: Process] = [:]
    private var aborted = false

    var isAborted: Bool { lock.withLock { aborted } }

    /// Ajoute un processus lancé ; vrai si le groupe est déjà arrêté (à terminer tout de suite).
    func add(_ p: Process) -> Bool { lock.withLock { processes[ObjectIdentifier(p)] = p; return aborted } }
    func remove(_ p: Process) { lock.withLock { processes[ObjectIdentifier(p)] = nil } }

    func abort() {
        lock.withLock {
            aborted = true
            for p in processes.values where p.isRunning { p.terminate() }
        }
    }
}

/// Dernière progression envoyée (relue par le battement d'une seconde).
final class LiveProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var value: BackupProgress?
    var last: BackupProgress? {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// Pile de dossiers partagée par les workers de comptage : chacun prend le suivant dès qu'il a fini.
final class WorkPile: @unchecked Sendable {
    private let lock = NSLock()
    private var nextIndex = 0
    private let count: Int
    init(count: Int) { self.count = count }
    func next() -> Int? {
        lock.withLock {
            guard nextIndex < count else { return nil }
            defer { nextIndex += 1 }
            return nextIndex
        }
    }
}

/// Résultat d'une copie, en attente de finalisation (`BackupEngine.finish`).
public struct CopyResult: @unchecked Sendable {
    let work: URL
    let versionsDir: URL
    let sources: [String: URL]
    let parts: [BackupPart]
    let manifestExtra: [String: Any]
    let now: Date
    let machine: String
    let partial: Bool
    let retention: CairnConfig.Retention
    let dryRun: Bool
    let start: Date
    let bytesByPart: [String: Int64]
    public let filesByPart: [String: Int]
    let files: Int
    let bytes: Int64
    public let warnings: [String]
}
