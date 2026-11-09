import Foundation
import Darwin

/// Emplacements de `~/.cairn`. `CAIRN_HOME` remplace le dossier (tests, comptes de test).
public struct CairnPaths: Sendable {
    public let root: URL

    public init(root: URL? = nil) {
        if let root {
            self.root = root
        } else if let env = ProcessInfo.processInfo.environment["CAIRN_HOME"], !env.isEmpty {
            self.root = URL(fileURLWithPath: env)
        } else {
            self.root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cairn")
        }
    }

    public var config: URL { root.appendingPathComponent("config.toml") }
    public var logs: URL { root.appendingPathComponent("logs") }
    public var state: URL { root.appendingPathComponent("state") }
    public var operationLock: URL { state.appendingPathComponent("operation.lock") }

    /// Crée `~/.cairn` (droits 700), `logs/` et `state/`.
    public func ensure() throws {
        let fm = FileManager.default
        for dir in [root, logs, state] {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true,
                                   attributes: dir == root ? [.posixPermissions: 0o700] : nil)
        }
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    }

    /// Crée un sous-dossier (`logs/`, `state/`…). Une racine absente est d'abord créée en 700 ; une racine existante
    /// n'est pas modifiée (avec `--config`, c'est le dossier choisi par l'utilisateur).
    public func prepare(_ dir: URL) throws {
        if !FileManager.default.fileExists(atPath: root.path) { try ensure() }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
}

/// Verrou exclusif partagé entre l'app et la commande `cairn` (flock).
/// Le système le libère si le processus se termine, même brutalement.
public final class OperationLock: @unchecked Sendable {
    public enum Failure: Error, Equatable { case alreadyHeld, cannotOpen(Int32) }

    private var fd: Int32 = -1
    public let url: URL

    public init(url: URL) { self.url = url }

    /// Tente de prendre le verrou sans attendre.
    public func acquire(operation: String) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let f = open(url.path, O_RDWR | O_CREAT, 0o600)
        guard f >= 0 else { throw Failure.cannotOpen(errno) }
        if flock(f, LOCK_EX | LOCK_NB) != 0 {
            close(f)
            throw Failure.alreadyHeld
        }
        let info = "\(getpid()) \(operation)\n"
        ftruncate(f, 0)
        _ = info.withCString { write(f, $0, strlen($0)) }
        fd = f
    }

    public var isHeld: Bool { fd >= 0 }

    /// Verrou pris par une opération en cours (cette app ou la commande `cairn`), sans le garder.
    public static func isHeld(at url: URL) -> Bool {
        let f = open(url.path, O_RDONLY)
        guard f >= 0 else { return false }
        defer { close(f) }
        if flock(f, LOCK_EX | LOCK_NB) != 0 { return true }
        flock(f, LOCK_UN)
        return false
    }

    public func release() {
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }

    /// Opération en cours selon le fichier de verrou (pid et nom), à titre d'information.
    public func holderDescription() -> String? {
        try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    deinit { release() }
}

/// Journal d'une exécution dans `~/.cairn/logs/<type>-<horodatage>.log`.
public final class RunLog: @unchecked Sendable {
    public let url: URL
    private let handle: FileHandle?
    private let lock = NSLock()

    public init(paths: CairnPaths, type: String, now: Date = Date()) {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        url = paths.logs.appendingPathComponent("\(type)-\(f.string(from: now)).log")
        // `~/.cairn` en 700, même si le journal est le premier à le créer.
        try? paths.prepare(paths.logs)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
    }

    public func write(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
        lock.withLock { handle?.write(data) }
    }

    public func close() {
        lock.withLock { try? handle?.close() }
    }
}

/// Bundle des ressources de CairnCore (catalogues, profils IA, règles).
/// `Bundle.module` n'est jamais utilisé : il ne cherche qu'à la racine de l'app et dans le dossier de build de la
/// machine qui a compilé, et plante (assertion) s'il ne trouve rien, ce qui arrivait au lancement d'une app téléchargée.
/// Sans bundle trouvé, on retombe sur `Bundle.main` : textes non traduits, mais l'app démarre.
public enum CairnResources {
    static let name = "Cairn_CairnCore.bundle"

    public static let bundle: Bundle = resolve(candidates())

    public static func resolve(_ urls: [URL]) -> Bundle {
        for url in urls where FileManager.default.fileExists(atPath: url.path) {
            if let b = Bundle(url: url) { return b }
        }
        return Bundle.main
    }

    static func candidates() -> [URL] {
        var out: [URL] = []
        if let r = Bundle.main.resourceURL { out.append(r.appendingPathComponent(name)) }   // Cairn.app/Contents/Resources
        if let exe = Bundle.main.executableURL?.resolvingSymlinksInPath() {                // lien ~/.local/bin/cairn
            let dir = exe.deletingLastPathComponent()
            out.append(dir.deletingLastPathComponent().appendingPathComponent("Resources").appendingPathComponent(name))
            out.append(dir.appendingPathComponent(name))                                    // swift build, tests
        }
        out.append(Bundle.main.bundleURL.appendingPathComponent(name))
        return out
    }
}
