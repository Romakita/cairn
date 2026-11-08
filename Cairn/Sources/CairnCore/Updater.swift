import CryptoKit
import Foundation

/// Release publiée sur GitHub qui peut remplacer l'app installée.
public struct AppRelease: Equatable, Sendable {
    public let version: String
    public let notes: String
    public let pageURL: URL
    public let archiveURL: URL
    public let checksumURL: URL

    public init(version: String, notes: String, pageURL: URL, archiveURL: URL, checksumURL: URL) {
        self.version = version; self.notes = notes; self.pageURL = pageURL
        self.archiveURL = archiveURL; self.checksumURL = checksumURL
    }
}

public enum UpdateError: Error, Equatable, CustomStringConvertible {
    case network(String)
    case checksumMismatch
    case invalidArchive
    case wrongBundle(String)
    case notInstallable

    public var description: String {
        switch self {
        case let .network(m): L10n.tr("update.error.network", m)
        case .checksumMismatch: L10n.tr("update.error.checksum")
        case .invalidArchive: L10n.tr("update.error.archive")
        case let .wrongBundle(m): L10n.tr("update.error.bundle", m)
        case .notInstallable: L10n.tr("update.error.not_installable")
        }
    }
}

/// Mises à jour de l'app depuis les releases GitHub (voir `.github/workflows/release.yml`).
public enum Updater {
    public static let bundleIdentifier = "fr.lenzotti.cairn"
    public static let releasesPage = URL(string: "https://github.com/Romakita/cairn/releases")!
    /// Dernière release publiée (brouillons et préversions exclus par GitHub). `CAIRN_UPDATE_URL` la remplace (tests).
    public static var latestURL: URL {
        ProcessInfo.processInfo.environment["CAIRN_UPDATE_URL"].flatMap(URL.init(string:))
            ?? URL(string: "https://api.github.com/repos/Romakita/cairn/releases/latest")!
    }

    public static var arch: String {
        #if arch(arm64)
        "arm64"
        #else
        "x86_64"
        #endif
    }

    // MARK: Versions

    /// `a` est strictement plus récente que `b` (« v » initial ignoré ; « 1.0.0-beta » < « 1.0.0 »).
    public static func isNewer(_ a: String, than b: String) -> Bool {
        func split(_ v: String) -> ([Int], String?) {
            var s = v.trimmingCharacters(in: .whitespaces)
            if s.hasPrefix("v") { s.removeFirst() }
            let parts = s.split(separator: "-", maxSplits: 1).map(String.init)
            let nums = (parts.first ?? "").split(separator: ".").map { Int($0) ?? 0 }
            return (nums, parts.count > 1 ? parts[1] : nil)
        }
        let (na, pa) = split(a), (nb, pb) = split(b)
        for i in 0..<max(na.count, nb.count) {
            let x = i < na.count ? na[i] : 0, y = i < nb.count ? nb[i] : 0
            if x != y { return x > y }
        }
        switch (pa, pb) {
        case (nil, .some): return true
        case (.some, nil), (nil, nil): return false
        case let (.some(x), .some(y)): return x.compare(y, options: .numeric) == .orderedDescending
        }
    }

    // MARK: Lecture de la release

    /// Lit la réponse de `releases/latest` ; `nil` si ce n'est pas une release utilisable pour cette architecture.
    public static func parseRelease(_ data: Data, arch: String = arch) -> AppRelease? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String,
              json["draft"] as? Bool != true, json["prerelease"] as? Bool != true,
              let page = (json["html_url"] as? String).flatMap(URL.init(string:)) else { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let assets = (json["assets"] as? [[String: Any]] ?? []).reduce(into: [String: URL]()) { acc, a in
            if let n = a["name"] as? String, let u = (a["browser_download_url"] as? String).flatMap(URL.init(string:)) { acc[n] = u }
        }
        let name = "Cairn-\(version)-\(arch).zip"
        guard let archive = assets[name], let sum = assets[name + ".sha256"] else { return nil }
        return AppRelease(version: version, notes: (json["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                          pageURL: page, archiveURL: archive, checksumURL: sum)
    }

    /// Release plus récente que `current`, ou `nil` si Cairn est à jour.
    public static func check(current: String = CairnVersion.current) async throws -> AppRelease? {
        var req = URLRequest(url: latestURL, timeoutInterval: 20)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Cairn/\(current)", forHTTPHeaderField: "User-Agent")
        let data = try await fetch(req)
        guard let r = parseRelease(data), isNewer(r.version, than: current) else { return nil }
        return r
    }

    private static func fetch(_ req: URLRequest) async throws -> Data {
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let h = resp as? HTTPURLResponse, !(200..<300).contains(h.statusCode) {
                throw UpdateError.network("HTTP \(h.statusCode)")
            }
            return data
        } catch let e as UpdateError {
            throw e
        } catch {
            throw UpdateError.network(error.localizedDescription)
        }
    }

    // MARK: Installation

    /// Bundle remplaçable : un `.app` dont le dossier parent est modifiable. `nil` en exécution de développement.
    public static func installableBundle(_ path: String = Bundle.main.bundlePath) -> URL? {
        let url = URL(fileURLWithPath: path)
        guard url.pathExtension == "app",
              FileManager.default.isWritableFile(atPath: url.deletingLastPathComponent().path) else { return nil }
        return url
    }

    /// Télécharge, vérifie et prépare la release ; renvoie l'app extraite, prête à remplacer `bundle`.
    public static func download(_ r: AppRelease, replacing bundle: URL) async throws -> URL {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let archive = tmp.appendingPathComponent(r.archiveURL.lastPathComponent)
        try await fetch(URLRequest(url: r.archiveURL, timeoutInterval: 300)).write(to: archive)
        let sum = String(decoding: try await fetch(URLRequest(url: r.checksumURL, timeoutInterval: 30)), as: UTF8.self)
        return try prepare(archive: archive, checksum: sum, version: r.version,
                           staging: stagingDirectory(for: bundle))
    }

    /// Dossier caché à côté du bundle : le remplacement reste un simple renommage sur le même volume.
    public static func stagingDirectory(for bundle: URL) -> URL {
        bundle.deletingLastPathComponent().appendingPathComponent(".cairn-update")
    }

    /// Vérifie le SHA-256 (format `shasum`), extrait l'archive dans `staging` et contrôle le bundle obtenu.
    public static func prepare(archive: URL, checksum: String, version: String, staging: URL) throws -> URL {
        let expected = checksum.split(whereSeparator: \.isWhitespace).first.map { $0.lowercased() } ?? ""
        guard let data = try? Data(contentsOf: archive) else { throw UpdateError.invalidArchive }
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard !expected.isEmpty, actual == expected else { throw UpdateError.checksumMismatch }

        let fm = FileManager.default
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        guard run("/usr/bin/ditto", ["-x", "-k", archive.path, staging.path]) == 0 else {
            try? fm.removeItem(at: staging)
            throw UpdateError.invalidArchive
        }
        let app = staging.appendingPathComponent("Cairn.app")
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        let id = info?["CFBundleIdentifier"] as? String, v = info?["CFBundleShortVersionString"] as? String
        guard id == bundleIdentifier, v == version else {
            try? fm.removeItem(at: staging)
            throw UpdateError.wrongBundle("\(id ?? "?") \(v ?? "?")")
        }
        // App non notarisée : même consigne que les notes de release.
        run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
        return app
    }

    /// Script qui attend la fin de `pid`, remplace `$2` par `$3`, remet l'ancien en cas d'échec puis relance.
    /// Arguments : pid, bundle installé, nouveau bundle, dossier de préparation, relance (1/0).
    public static let swapScript = """
    pid=$1; app=$2; new=$3; staging=$4; relaunch=$5
    old="$staging/Cairn.previous.app"
    i=0
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i+1)); [ $i -gt 300 ] && exit 1; done
    rm -rf "$old"
    if mv "$app" "$old"; then
      if mv "$new" "$app"; then rm -rf "$staging"; else mv "$old" "$app"; fi
    fi
    [ "$relaunch" = 1 ] && /usr/bin/open "$app"
    exit 0
    """

    /// Lance le remplacement en arrière-plan ; l'appelant doit quitter ensuite.
    @discardableResult
    public static func scheduleSwap(newApp: URL, replacing bundle: URL, after pid: Int32 = getpid(),
                                    relaunch: Bool = true) throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", swapScript, "cairn-update", String(pid), bundle.path, newApp.path,
                       newApp.deletingLastPathComponent().path, relaunch ? "1" : "0"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        return p
    }

    @discardableResult
    private static func run(_ tool: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}
