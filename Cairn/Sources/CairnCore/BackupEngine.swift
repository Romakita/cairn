import Foundation

/// Version de Cairn écrite dans les manifests.
public enum CairnVersion {
    /// Version du code (à garder égale à `CFBundleShortVersionString` dans `build-app.sh`).
    public static let fallback = "0.1"
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

public struct BackupProgress: Sendable {
    public var part: String
    public var files: Int
    public var bytes: Int64
    public var current: String
}

public struct BackupOutcome: Sendable {
    public let version: String?          // nil en simulation
    public let dryRun: Bool
    public let bytesByPart: [String: Int64]
    public let filesTransferred: Int
    public let bytesTransferred: Int64
    public let warnings: [String]
    public let deletedVersions: [String]
    public let duration: TimeInterval
    public var totalBytes: Int64 { bytesByPart.values.reduce(0, +) }
}

public enum BackupError: Error, CustomStringConvertible {
    case rsyncFailed(part: String, status: Int32)
    case cancelled
    case destination(String)
    public var description: String {
        switch self {
        case let .rsyncFailed(part, status): L10n.tr("backup.error.rsync", part, Int(status))
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
    private var process: Process?
    private var cancelled = false

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
            process?.terminate()
        }
    }

    /// Veille : rsync est suspendu puis repris au réveil.
    public func suspend() { lock.withLock { if let p = process, p.isRunning { kill(p.processIdentifier, SIGSTOP) } } }
    public func resume() { lock.withLock { if let p = process, p.isRunning { kill(p.processIdentifier, SIGCONT) } } }

    var isCancelled: Bool { lock.withLock { cancelled } }

    // MARK: Exécution

    /// Sauvegarde les parties dans une nouvelle version (ou simule si `dryRun`).
    public func run(parts: [BackupPart], root: URL, retention: CairnConfig.Retention, dryRun: Bool,
                    machine: String = BackupEngine.machineName(), now: Date = Date(),
                    manifestExtra: [String: Any] = [:], forceRecopy: [String: [String]] = [:], partial: Bool = false,
                    progress: @escaping (BackupProgress) -> Void = { _ in }) throws -> BackupOutcome {
        let start = Date()
        let fm = FileManager.default
        let versionsDir = Self.versionsDir(root: root, machine: machine)
        // Une simulation n'écrit rien sur la destination, pas même le dossier des versions.
        if !dryRun { try fm.createDirectory(at: versionsDir, withIntermediateDirectories: true) }
        let sources = Self.linkSources(parts: parts, versionsDir: versionsDir)

        // Version de travail : reprise d'une version incomplète récente, sinon nouvelle.
        var work: URL
        let incompletes = ((try? fm.contentsOfDirectory(atPath: versionsDir.path)) ?? []).filter { $0.hasPrefix(Self.incompletePrefix) }.sorted()
        if dryRun {
            work = versionsDir.appendingPathComponent(".dryrun-\(UUID().uuidString)")
        } else if let last = incompletes.last,
                  let d = Self.date(ofVersion: String(last.dropFirst(Self.incompletePrefix.count))),
                  now.timeIntervalSince(d) < Self.maxResumeAge {
            work = versionsDir.appendingPathComponent(last)
            for old in incompletes.dropLast() { try? fm.removeItem(at: versionsDir.appendingPathComponent(old)) }
        } else {
            for old in incompletes { try? fm.removeItem(at: versionsDir.appendingPathComponent(old)) }
            work = versionsDir.appendingPathComponent(Self.incompletePrefix + Self.formatter().string(from: now))
        }
        if !dryRun { try fm.createDirectory(at: work, withIntermediateDirectories: true) }

        var bytesByPart: [String: Int64] = [:]
        var transferred: [String: [String]] = [:]
        var files = 0
        var bytes: Int64 = 0
        var warnings: [String] = []
        for part in parts {
            if isCancelled { throw BackupError.cancelled }
            let dest = work.appendingPathComponent(part.target)
            let linkDest = sources[part.target]?.appendingPathComponent(part.target)
            let (names, status) = try rsync(part: part, dest: dest, linkDest: linkDest, dryRun: dryRun,
                                            forceRecopy: forceRecopy[part.target] ?? [], progress: { n, b, cur in
                progress(BackupProgress(part: part.target, files: files + n, bytes: bytes + b, current: cur))
            })
            if isCancelled { throw BackupError.cancelled }
            // 23/24 : transfert partiel (fichier illisible ou disparu pendant la copie) → avertissement.
            if status == 23 || status == 24 { warnings.append(L10n.tr("backup.warning.partial", part.target, Int(status))) }
            else if status != 0 { throw BackupError.rsyncFailed(part: part.target, status: status) }
            let partBytes = names.reduce(Int64(0)) { sum, n in
                let attrs = try? fm.attributesOfItem(atPath: (part.source as NSString).appendingPathComponent(n))
                return sum + ((attrs?[.type] as? FileAttributeType) == .typeRegular ? ((attrs?[.size] as? Int64) ?? 0) : 0)
            }
            bytesByPart[part.target] = partBytes
            transferred[part.target] = names
            files += names.count
            bytes += partBytes
        }

        if dryRun {
            return BackupOutcome(version: nil, dryRun: true, bytesByPart: bytesByPart, filesTransferred: files,
                                 bytesTransferred: bytes, warnings: warnings, deletedVersions: [],
                                 duration: Date().timeIntervalSince(start))
        }

        // Empreintes (fichiers transférés hachés, autres repris de la version précédente) puis manifest.
        try Integrity.writeChecksums(version: work, linkSources: sources)
        var manifest: [String: Any] = manifestExtra
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

        let deleted = try applyRetention(versionsDir: versionsDir, retention: retention, now: now)
        return BackupOutcome(version: name, dryRun: false, bytesByPart: bytesByPart, filesTransferred: files,
                             bytesTransferred: bytes, warnings: warnings, deletedVersions: deleted,
                             duration: Date().timeIntervalSince(start))
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

    /// Lance rsync pour une partie ; renvoie les fichiers transférés (relatifs à la source) et le code de sortie.
    func rsync(part: BackupPart, dest: URL, linkDest: URL?, dryRun: Bool, forceRecopy: [String],
               progress: @escaping (Int, Int64, String) -> Void) throws -> ([String], Int32) {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent("cairn-\(UUID().uuidString)")
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tmp) }

        var args = ["-a", "--out-format=%i|%n", "--partial-dir=.cairn-partial", "--delete", "--delete-excluded"]
        if dryRun { args.append("-n") }
        if !part.excludes.isEmpty {
            let f = tmp.appendingPathComponent("exclude.txt")
            try (part.excludes.joined(separator: "\n") + "\n").write(to: f, atomically: true, encoding: .utf8)
            args.append("--exclude-from=\(f.path)")
        }
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
        p.standardError = FileHandle.nullDevice
        lock.withLock { process = p }
        defer { lock.withLock { process = nil } }
        try p.run()

        var names: [String] = []
        var buffer = Data()
        var count = 0
        let handle = pipe.fileHandleForReading
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                buffer.removeSubrange(buffer.startIndex...nl)
                // « >f… » : fichier réellement transféré ; « hf » : lié à la version précédente ; « cd » : dossier.
                guard let bar = line.firstIndex(of: "|") else { continue }
                let item = line[line.startIndex..<bar]
                guard item.hasPrefix(">f") || item.hasPrefix("<f") else { continue }
                names.append(String(line[line.index(after: bar)...]))
                count += 1
                if count % 200 == 0 { progress(count, 0, line) }
            }
        }
        p.waitUntilExit()
        progress(count, 0, "")
        return (names, p.terminationStatus)
    }
}
