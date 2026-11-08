import Foundation
import Security

/// Chargement, migration, enregistrement et surveillance de `config.toml`.
public final class ConfigStore: @unchecked Sendable {
    public struct Loaded: Sendable {
        public let config: CairnConfig
        public let issues: [ConfigIssue]
        public let document: TOMLDocument
        public let migrated: Bool
        public var hasErrors: Bool { issues.contains { $0.severity == .error } }
    }

    public enum LoadError: Error, CustomStringConvertible {
        case syntax(TOMLError)
        case unreadable(String)
        public var description: String {
            switch self {
            case let .syntax(e): L10n.tr("config.issue.syntax", e.line, e.message)
            case let .unreadable(m): m
            }
        }

        /// Problème bloquant équivalent : une erreur de syntaxe désactive les sauvegardes comme une erreur de schéma.
        public var issue: ConfigIssue {
            switch self {
            case let .syntax(e): ConfigIssue(severity: .error, key: "", line: e.line, message: e.message)
            case let .unreadable(m): ConfigIssue(severity: .error, key: "", line: nil, message: m)
            }
        }
    }

    /// Enregistrement refusé : le fichier sur disque est invalide, l'écraser ferait perdre les modifications à la main.
    public enum SaveError: Error, CustomStringConvertible {
        case invalidFile([ConfigIssue])
        public var description: String {
            switch self {
            case let .invalidFile(issues): L10n.tr("config.save.refused", issues.first.map(\.description) ?? "")
            }
        }
    }

    /// Problèmes à afficher pour une erreur de chargement (erreur de syntaxe avec sa ligne, fichier illisible…).
    public static func issues(for error: Error) -> [ConfigIssue] {
        if let e = error as? LoadError { return [e.issue] }
        return [ConfigIssue(severity: .error, key: "", line: nil, message: String(describing: error))]
    }

    public let paths: CairnPaths
    public let fileURL: URL

    public init(paths: CairnPaths = CairnPaths(), fileURL: URL? = nil) {
        self.paths = paths
        self.fileURL = fileURL ?? paths.config
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: fileURL.path) }

    /// Charge le fichier. Un fichier d'une version antérieure est migré, avec une copie `config.toml.bak`.
    public func load() throws -> Loaded {
        let text: String
        do { text = try String(contentsOf: fileURL, encoding: .utf8) } catch {
            throw LoadError.unreadable(error.localizedDescription)
        }
        var doc: TOMLDocument
        do { doc = try TOMLDocument(parsing: text) } catch let e as TOMLError { throw LoadError.syntax(e) }

        var migrated = false
        if ConfigMigration.version(of: doc) < CairnConfig.currentVersion {
            let bak = fileURL.appendingPathExtension("bak")
            try? FileManager.default.removeItem(at: bak)
            try FileManager.default.copyItem(at: fileURL, to: bak)
            ConfigMigration.migrate(&doc)
            try write(doc)
            migrated = true
        }
        do {
            let (config, issues) = try ConfigDecoder.decode(doc)
            return Loaded(config: config, issues: issues, document: doc, migrated: migrated)
        } catch let e as TOMLError { throw LoadError.syntax(e) }
    }

    /// Enregistre la configuration en réécrivant le document existant (commentaires conservés).
    /// Refuse (`SaveError.invalidFile`) si le fichier sur disque contient une erreur : la configuration en mémoire est
    /// alors la dernière valide, et l'appliquer écraserait ce que l'utilisateur est en train de corriger à la main.
    public func save(_ config: CairnConfig) throws {
        var doc: TOMLDocument
        if exists {
            let text: String
            do { text = try String(contentsOf: fileURL, encoding: .utf8) } catch {
                throw SaveError.invalidFile([LoadError.unreadable(error.localizedDescription).issue])
            }
            let errors: [ConfigIssue]
            do {
                doc = try TOMLDocument(parsing: text)
                errors = try ConfigDecoder.decode(doc).1.filter { $0.severity == .error }
            } catch let e as TOMLError {
                throw SaveError.invalidFile([LoadError.syntax(e).issue])
            }
            if !errors.isEmpty { throw SaveError.invalidFile(errors) }
            ConfigWriter.apply(config, to: &doc)
        } else {
            doc = ConfigWriter.newDocument(config)
        }
        try write(doc)
    }

    /// Écriture atomique ; crée `~/.cairn` (700) si besoin.
    public func write(_ doc: TOMLDocument) throws {
        try ensureDirectory()
        try doc.render().write(to: fileURL, atomically: true, encoding: .utf8)
    }

    /// Crée le dossier du fichier : `~/.cairn` (700, avec `logs/` et `state/`), ou le dossier de `--config`.
    func ensureDirectory() throws {
        if fileURL.deletingLastPathComponent().standardizedFileURL.path == paths.root.standardizedFileURL.path { try paths.ensure() }
        else { try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true) }
    }

    /// Surveille le fichier (y compris les remplacements atomiques des éditeurs) et appelle `onChange`.
    public func watch(queue: DispatchQueue = .main, onChange: @escaping () -> Void) -> FileWatcher {
        // Le dossier doit exister (et être en 700) avant que le FileWatcher ne l'ouvre.
        try? ensureDirectory()
        return FileWatcher(url: fileURL, queue: queue, onChange: onChange)
    }
}

/// Surveille un fichier via son dossier parent : couvre l'écriture directe, le remplacement et la création.
public final class FileWatcher: @unchecked Sendable {
    private var source: DispatchSourceFileSystemObject?
    private var lastStamp: Date?
    private let url: URL
    private let queue: DispatchQueue
    private let onChange: () -> Void

    init(url: URL, queue: DispatchQueue, onChange: @escaping () -> Void) {
        self.url = url
        self.queue = queue
        self.onChange = onChange
        lastStamp = Self.stamp(url)
        let dir = url.deletingLastPathComponent().path
        let fd = open(dir, O_EVTONLY)
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .extend, .attrib], queue: queue)
        s.setEventHandler { [weak self] in self?.check() }
        s.setCancelHandler { close(fd) }
        s.resume()
        source = s
        // Les écritures « en place » ne modifient pas le dossier : on vérifie aussi périodiquement.
        poll()
    }

    private func poll() {
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.source != nil else { return }
            self.check()
            self.poll()
        }
    }

    private func check() {
        let s = Self.stamp(url)
        if s != lastStamp {
            lastStamp = s
            onChange()
        }
    }

    private static func stamp(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
    }

    public func cancel() {
        source?.cancel()
        source = nil
    }

    deinit { cancel() }
}

/// Mots de passe dans le Trousseau macOS (services `fr.lenzotti.cairn.*`).
public enum Keychain {
    public static let servicePrefix = "fr.lenzotti.cairn."

    public enum Failure: Error, Equatable { case status(OSStatus) }

    /// Mot de passe générique (image chiffrée, jeton…), identifié par `service` et `account`.
    public static func setPassword(_ password: String, service: String, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        let data = Data(password.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = "Cairn — \(service)"
            let s = SecItemAdd(add as CFDictionary, nil)
            guard s == errSecSuccess else { throw Failure.status(s) }
        } else if status != errSecSuccess {
            throw Failure.status(status)
        }
    }

    public static func password(service: String, account: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func deletePassword(service: String, account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }

    /// Mot de passe d'un serveur (NAS en SMB) : réutilise l'entrée créée par le Finder si elle existe.
    public static func internetPassword(server: String, account: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassInternetPassword,
                                    kSecAttrServer as String: server, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func setInternetPassword(_ password: String, server: String, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassInternetPassword,
                                    kSecAttrServer as String: server, kSecAttrAccount as String: account,
                                    kSecAttrProtocol as String: kSecAttrProtocolSMB]
        let data = Data(password.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            let s = SecItemAdd(add as CFDictionary, nil)
            guard s == errSecSuccess else { throw Failure.status(s) }
        } else if status != errSecSuccess {
            throw Failure.status(status)
        }
    }

    public static func deleteInternetPassword(server: String, account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassInternetPassword,
                                    kSecAttrServer as String: server, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}

/// Rétention des journaux de `~/.cairn/logs`.
public enum LogJanitor {
    /// Supprime les journaux plus vieux que `retentionDays`, sauf ceux de `keep` (journaux de versions gardées).
    @discardableResult
    public static func prune(paths: CairnPaths, retentionDays: Int, keep: Set<String> = [], now: Date = Date()) -> [String] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: paths.logs.path) else { return [] }
        let limit = now.addingTimeInterval(-Double(retentionDays) * 86_400)
        var removed: [String] = []
        for name in names where name.hasSuffix(".log") && !keep.contains(name) {
            let url = paths.logs.appendingPathComponent(name)
            guard let date = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date, date < limit else { continue }
            if (try? fm.removeItem(at: url)) != nil { removed.append(name) }
        }
        return removed.sorted()
    }
}
