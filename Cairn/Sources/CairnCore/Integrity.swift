import CryptoKit
import Foundation

/// Empreintes SHA-256 des versions (`checksums.tsv`), vérification et fichiers abîmés (`damaged.tsv`).
public enum Integrity {
    public struct Entry: Equatable, Sendable {
        public let size: Int64
        public let mtime: Int64
        public let sha256: String
    }

    public struct Report: Sendable {
        public let version: String
        public let checked: Int
        public let damaged: [String]
        public let missingChecksums: Bool
    }

    static let checksumsFile = "checksums.tsv"
    static let damagedFile = "damaged.tsv"

    public static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    public static func read(_ version: URL) -> [String: Entry] {
        guard let text = try? String(contentsOf: version.appendingPathComponent(checksumsFile), encoding: .utf8) else { return [:] }
        var out: [String: Entry] = [:]
        for line in text.split(separator: "\n") {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false)
            guard f.count == 4, let size = Int64(f[1]), let mtime = Int64(f[2]) else { continue }
            out[String(f[0])] = Entry(size: size, mtime: mtime, sha256: String(f[3]))
        }
        return out
    }

    /// Fichiers ordinaires d'une version (chemins relatifs), hors fichiers de Cairn.
    static func files(in version: URL) -> [(String, Int64, Int64)] {
        var out: [(String, Int64, Int64)] = []
        // Chemins résolus des deux côtés (/var → /private/var), sinon le découpage relatif est faux.
        let resolved = version.resolvingSymlinksInPath()
        let base = resolved.path.count + 1
        guard let e = FileManager.default.enumerator(at: resolved, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey],
                                                     options: [], errorHandler: { _, _ in true }) else { return [] }
        while let url = autoreleasepool(invoking: { e.nextObject() as? URL }) {
            autoreleasepool {
                let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey])
                guard v?.isRegularFile == true else { return }
                // L'énumérateur part de la racine résolue : ses chemins ont déjà le bon préfixe (résolution coûteuse
                // seulement en dernier recours, pour chaque composant du chemin).
                let p = url.path
                let rel = String((p.hasPrefix(resolved.path + "/") ? p : url.resolvingSymlinksInPath().path).dropFirst(base))
                if [checksumsFile, damagedFile, "manifest.json"].contains(rel) || rel.contains("/.cairn-partial/") { return }
                out.append((rel, Int64(v?.fileSize ?? 0), Int64(v?.contentModificationDate?.timeIntervalSince1970 ?? 0)))
            }
        }
        return out
    }

    /// Variante par partie : chaque partie reprend les empreintes de la version qui lui sert de base.
    public static func writeChecksums(version: URL, linkSources: [String: URL]) throws {
        var prev: [String: Entry] = [:]
        var damaged: Set<String> = []
        for (target, v) in linkSources {
            for (rel, e) in read(v) where rel.hasPrefix(target + "/") { prev[rel] = e }
            damaged.formUnion(readDamaged(v).filter { $0.hasPrefix(target + "/") })
        }
        try writeChecksums(version: version, prev: prev, damagedBefore: damaged)
    }

    /// Écrit `checksums.tsv` : seuls les fichiers nouveaux ou modifiés sont hachés, les autres reprennent l'empreinte précédente.
    public static func writeChecksums(version: URL, previous: URL?, transferred: [String: [String]] = [:]) throws {
        try writeChecksums(version: version, prev: previous.map(read) ?? [:], damagedBefore: previous.map(readDamaged) ?? [])
    }

    static func writeChecksums(version: URL, prev: [String: Entry], damagedBefore: Set<String>) throws {
        var lines: [String] = []
        for (rel, size, mtime) in files(in: version).sorted(by: { $0.0 < $1.0 }) {
            if let p = prev[rel], p.size == size, p.mtime == mtime, !damagedBefore.contains(rel) {
                lines.append("\(rel)\t\(size)\t\(mtime)\t\(p.sha256)")
            } else {
                let h = try sha256(of: version.appendingPathComponent(rel))
                lines.append("\(rel)\t\(size)\t\(mtime)\t\(h)")
            }
        }
        try (lines.joined(separator: "\n") + "\n").write(to: version.appendingPathComponent(checksumsFile), atomically: true, encoding: .utf8)
    }

    /// Vérifie une version : tous les fichiers (`full`) ou un échantillon aléatoire (2 %, au moins 500 et au plus `maxBytes` lus).
    public static func verify(version: URL, full: Bool, fraction: Double = 0.02, minFiles: Int = 500,
                              maxBytes: Int64 = 5_000_000_000) -> Report {
        let sums = read(version)
        guard !sums.isEmpty else {
            return Report(version: version.lastPathComponent, checked: 0, damaged: [], missingChecksums: true)
        }
        var paths = Array(sums.keys)
        if !full {
            paths.shuffle()
            let n = min(paths.count, max(minFiles, Int(Double(paths.count) * fraction)))
            var picked: [String] = []
            var read: Int64 = 0
            for p in paths.prefix(n) {
                let s = sums[p]!.size
                if read + s > maxBytes && !picked.isEmpty { continue }
                read += s
                picked.append(p)
            }
            paths = picked
        }
        var damaged: [String] = []
        for p in paths.sorted() {
            let url = version.appendingPathComponent(p)
            guard let h = try? sha256(of: url), h == sums[p]!.sha256 else { damaged.append(p); continue }
        }
        if !damaged.isEmpty { try? writeDamaged(version: version, paths: damaged) }
        return Report(version: version.lastPathComponent, checked: paths.count, damaged: damaged, missingChecksums: false)
    }

    public static func readDamaged(_ version: URL) -> Set<String> {
        guard let text = try? String(contentsOf: version.appendingPathComponent(damagedFile), encoding: .utf8) else { return [] }
        return Set(text.split(separator: "\n").map(String.init))
    }

    static func writeDamaged(version: URL, paths: [String]) throws {
        let all = readDamaged(version).union(paths).sorted()
        try (all.joined(separator: "\n") + "\n").write(to: version.appendingPathComponent(damagedFile), atomically: true, encoding: .utf8)
    }

    /// Variante par partie : les fichiers abîmés sont lus dans la version qui sert de base à chaque partie.
    public static func recopyPlan(linkSources: [String: URL], parts: [BackupPart]) -> [String: [String]] {
        var plan: [String: [String]] = [:]
        for p in parts {
            guard let v = linkSources[p.target] else { continue }
            let list = readDamaged(v).filter { $0.hasPrefix(p.target + "/") }.map { String($0.dropFirst(p.target.count + 1)) }.sorted()
            if !list.isEmpty { plan[p.target] = list }
        }
        return plan
    }

    /// Fichiers à recopier depuis la source à la prochaine sauvegarde, par partie (`folders/x` → chemins relatifs à la partie).
    public static func recopyPlan(previous: URL?, parts: [BackupPart]) -> [String: [String]] {
        guard let previous else { return [:] }
        let damaged = readDamaged(previous)
        var plan: [String: [String]] = [:]
        for d in damaged {
            for p in parts where d.hasPrefix(p.target + "/") {
                plan[p.target, default: []].append(String(d.dropFirst(p.target.count + 1)))
            }
        }
        return plan
    }
}
