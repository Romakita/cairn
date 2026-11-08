import Foundation

/// Journal d'activité affiché sur l'accueil (`state/activity.jsonl`) : une ligne JSON par événement, 200 au plus.
/// Seuls des noms (destination, volume) et des compteurs y sont écrits, jamais de chemin ni de message d'erreur.
public struct ActivityLog: Sendable {
    public struct Event: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            case backupSucceeded, backupFailed, cleanup, gitCleanup, diskAlert, check
        }
        public let date: Date
        public let kind: Kind
        /// Destination ou volume concerné.
        public let subject: String?
        /// Compteur : éléments supprimés, branches, problèmes trouvés…
        public let count: Int?
        public let bytes: Int64?
        /// Niveau : `critical` pour une alerte de disque critique.
        public let level: String?

        public init(date: Date = Date(), kind: Kind, subject: String? = nil, count: Int? = nil, bytes: Int64? = nil,
                    level: String? = nil) {
            self.date = date; self.kind = kind; self.subject = subject; self.count = count; self.bytes = bytes; self.level = level
        }
    }

    public static let maxLines = 200
    public let url: URL

    public init(paths: CairnPaths) { url = paths.state.appendingPathComponent("activity.jsonl") }

    private static let lock = NSLock()

    /// Ajoute un événement ; au-delà de 200 lignes, les plus anciennes sont retirées.
    public func append(_ event: Event) {
        Self.lock.withLock {
            let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.sortedKeys]
            guard let line = try? e.encode(event) else { return }
            var lines = readLines()
            lines.append(String(decoding: line, as: UTF8.self))
            if lines.count > Self.maxLines { lines.removeFirst(lines.count - Self.maxLines) }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// Les `limit` derniers événements, du plus récent au plus ancien (vide si le fichier est absent).
    public func recent(_ limit: Int = 10) -> [Event] {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        let events = readLines().compactMap { try? d.decode(Event.self, from: Data($0.utf8)) }
        // Ordre d'écriture = ordre chronologique.
        return Array(events.reversed().prefix(limit))
    }

    private func readLines() -> [String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }
}
