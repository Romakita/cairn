import Foundation

/// Vérification et parcours d'une destination avant son enregistrement (assistant et feuille « Ajouter une
/// destination »). Rien n'est écrit sur la destination hormis un fichier témoin supprimé aussitôt, et rien n'est
/// enregistré dans le Trousseau.
public enum ProbeFailure: Error, Equatable, Sendable, CustomStringConvertible {
    /// Adresse SMB illisible (pas de la forme `smb://hôte/partage`).
    case invalidAddress(String)
    /// Le serveur ne répond pas sur le port SMB.
    case unreachable(String)
    /// Ni mot de passe saisi ni entrée dans le Trousseau.
    case passwordRequired
    case authenticationFailed
    case mountFailed(Int32)
    case notFound(String)
    case readOnly(String)
    case volumeMissing(String)
    /// Contenu d'un dossier illisible (navigateur).
    case accessDenied(String)
    case invalidName(InvalidName)

    public enum InvalidName: Equatable, Sendable { case empty, forbiddenCharacter, exists }

    public var description: String {
        switch self {
        case let .invalidAddress(a): L10n.tr("probe.error.invalid_address", a)
        case let .unreachable(h): L10n.tr("probe.error.unreachable", h)
        case .passwordRequired: L10n.tr("probe.error.password_required")
        case .authenticationFailed: L10n.tr("probe.error.authentication")
        case let .mountFailed(code): L10n.tr("probe.error.mount", Int(code))
        case let .notFound(p): L10n.tr("probe.error.not_found", p)
        case let .readOnly(p): L10n.tr("probe.error.read_only", p)
        case let .volumeMissing(v): L10n.tr("probe.error.volume_missing", v)
        case let .accessDenied(p): L10n.tr("probe.error.access_denied", p)
        case .invalidName(.empty): L10n.tr("probe.error.name_empty")
        case .invalidName(.forbiddenCharacter): L10n.tr("probe.error.name_character")
        case .invalidName(.exists): L10n.tr("probe.error.name_exists")
        }
    }

    /// Ce qu'il faut faire pour s'en sortir.
    public var hint: String {
        switch self {
        case .invalidAddress: L10n.tr("probe.hint.address")
        case .unreachable: L10n.tr("probe.hint.unreachable")
        case .passwordRequired, .authenticationFailed: L10n.tr("probe.hint.password")
        case .mountFailed: L10n.tr("probe.hint.retry")
        case .notFound, .readOnly, .accessDenied: L10n.tr("probe.hint.other_folder")
        case .volumeMissing: L10n.tr("probe.hint.volume")
        case .invalidName: ""
        }
    }
}

/// Sauvegarde Cairn trouvée dans un dossier (`cairn-<machine>.sparsebundle`).
public struct ExistingImage: Equatable, Sendable {
    public let machine: String
    public let path: String
    public let isThisMac: Bool
}

public enum ProbeResult: Equatable, Sendable {
    case ok(freeBytes: Int64?, existingImages: [ExistingImage])
    case failed(ProbeFailure)
}

/// Dossier proposé par le navigateur.
public struct FolderEntry: Equatable, Sendable, Identifiable {
    public let name: String
    public let url: URL
    public var id: String { url.path }
    public init(name: String, url: URL) { self.name = name; self.url = url }
}

public enum DestinationProbe {
    /// Préfixe du fichier témoin ; un reste d'une vérification interrompue est supprimé à la suivante.
    public static let writeTestPrefix = ".cairn-write-test-"

    // MARK: Dossier

    /// Vérifie un dossier monté : volume présent, dossier existant, écriture possible, espace libre, sauvegardes.
    public static func checkFolder(_ folder: URL, machine: String = BackupEngine.machineName()) -> ProbeResult {
        let fm = FileManager.default
        let path = folder.path
        guard !path.isEmpty else { return .failed(.notFound(path)) }
        if let volume = volumeName(of: path), !fm.fileExists(atPath: "/Volumes/" + volume) {
            return .failed(.volumeMissing(volume))
        }
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { return .failed(.notFound(path)) }
        removeStaleWriteTests(in: folder)
        let probe = folder.appendingPathComponent(writeTestPrefix + UUID().uuidString)
        guard fm.createFile(atPath: probe.path, contents: Data("cairn".utf8)) else { return .failed(.readOnly(path)) }
        try? fm.removeItem(at: probe)
        return .ok(freeBytes: freeSpace(at: folder), existingImages: existingImages(at: folder, machine: machine))
    }

    /// Supprime les fichiers témoins restés d'une vérification interrompue (plantage, partage coupé).
    static func removeStaleWriteTests(in folder: URL) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for n in names where n.hasPrefix(writeTestPrefix) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(n))
        }
    }

    /// Volume externe d'un chemin `/Volumes/<nom>/…`.
    public static func volumeName(of path: String) -> String? {
        guard path.hasPrefix("/Volumes/") else { return nil }
        return path.dropFirst("/Volumes/".count).split(separator: "/").first.map(String.init)
    }

    /// Espace disponible du volume qui porte `url` (repli sur `statfs` pour les partages réseau).
    public static func freeSpace(at url: URL) -> Int64? {
        if let v = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let c = v.volumeAvailableCapacityForImportantUsage, c > 0 { return c }
        var s = statfs()
        guard statfs(url.path, &s) == 0 else { return nil }
        return Int64(s.f_bavail) * Int64(s.f_bsize)
    }

    /// Sauvegardes Cairn du dossier, celle de ce Mac repérée.
    public static func existingImages(at folder: URL, machine: String = BackupEngine.machineName()) -> [ExistingImage] {
        SparseImage.images(at: folder).map { path in
            let name = (path as NSString).lastPathComponent
            let m = String(name.dropFirst("cairn-".count).dropLast(".sparsebundle".count))
            return ExistingImage(machine: m, path: path, isThisMac: m == machine)
        }
    }

    // MARK: Parcours

    /// Sous-dossiers visibles, triés comme le Finder. Les paquets (images Cairn comprises) sont exclus.
    public static func listFolders(at folder: URL) -> Result<[FolderEntry], ProbeFailure> {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey]
        let items: [URL]
        do {
            items = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys,
                                                                options: [.skipsHiddenFiles])
        } catch {
            // Dossier présent mais illisible : droits insuffisants.
            return .failure(FileManager.default.fileExists(atPath: folder.path) ? .accessDenied(folder.path) : .notFound(folder.path))
        }
        let folders = items.filter {
            let v = try? $0.resourceValues(forKeys: Set(keys))
            return v?.isDirectory == true && v?.isPackage != true
        }
        return .success(folders.map { FolderEntry(name: $0.lastPathComponent, url: $0) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending })
    }

    /// Crée un dossier. Un nom vide, contenant `/` ou `:`, ou déjà pris est refusé sans rien écrire.
    public static func createFolder(named raw: String, in parent: URL) -> Result<URL, ProbeFailure> {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != ".." else { return .failure(.invalidName(.empty)) }
        guard !name.contains("/"), !name.contains(":") else { return .failure(.invalidName(.forbiddenCharacter)) }
        let url = parent.appendingPathComponent(name)
        guard !FileManager.default.fileExists(atPath: url.path) else { return .failure(.invalidName(.exists)) }
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        } catch {
            return .failure(.readOnly(parent.path))
        }
        return .success(url)
    }

    /// Racines du navigateur local : volumes montés (hors disque système), puis le home.
    public static func localRoots(volumes: URL = URL(fileURLWithPath: "/Volumes"),
                                  home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [FolderEntry] {
        let fm = FileManager.default
        let names = ((try? fm.contentsOfDirectory(atPath: volumes.path)) ?? []).filter { !$0.hasPrefix(".") }
        let vols = names.compactMap { n -> FolderEntry? in
            let url = volumes.appendingPathComponent(n)
            // Le disque système apparaît dans /Volumes comme un lien vers « / ».
            if url.resolvingSymlinksInPath().path == "/" { return nil }
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { return nil }
            return FolderEntry(name: n, url: url)
        }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return vols + [FolderEntry(name: home.lastPathComponent, url: home)]
    }

    // MARK: SMB

    /// Hôte, partage et sous-dossier d'une adresse `smb://hôte/partage/sous/dossier`.
    public static func smbParts(_ address: String) -> (host: String, share: String, subpath: [String])? {
        guard address.lowercased().hasPrefix("smb://"), let url = URL(string: address), let host = url.host, !host.isEmpty
        else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        guard let share = parts.first else { return nil }
        return (host, share, Array(parts.dropFirst()))
    }

    /// Adresse finale : partage + dossier choisi dans le navigateur (`smb://hôte/partage/sous/dossier`).
    public static func smbAddress(host: String, share: String, subpath: [String]) -> String {
        let enc: (String) -> String = { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? $0 }
        return "smb://\(host)/" + ([share] + subpath).map(enc).joined(separator: "/")
    }

    /// Cause lisible d'un code renvoyé par `NetFSMountURLSync`.
    public static func failure(forMountStatus status: Int32, share: String) -> ProbeFailure {
        switch status {
        // EAUTH, EACCES, mot de passe à changer, compte restreint.
        case 80, 13, -5045, -5046, -5999: .authenticationFailed
        // ENOENT, aucun partage disponible (NetFS / NetAuth).
        case 2, -5998, -6003: .notFound(share)
        default: .mountFailed(status)
        }
    }
}

/// Connexion ouverte pendant la saisie d'une destination : le partage monté pour vérifier reste monté pour le
/// parcours, puis `close()` démonte ce que la session a monté (un partage déjà monté dans le Finder est conservé).
public final class ProbeSession: @unchecked Sendable {
    private var provider: SMBProvider?
    public private(set) var host: String?
    public private(set) var share: String?
    /// Point de montage du partage (racine du navigateur).
    public private(set) var mountRoot: URL?

    public init() {}

    /// Sonde TCP 445 (3 s), puis montage sans interface avec le mot de passe de session (ou celui du Trousseau).
    /// Renvoie la racine du partage.
    public func connect(address: String, username: String, password: String?) -> Result<URL, ProbeFailure> {
        close()
        guard let parts = DestinationProbe.smbParts(address) else { return .failure(.invalidAddress(address)) }
        let shareURL = "smb://\(parts.host)/" + parts.share
        let p = SMBProvider(CairnConfig.Destination(id: "probe", provider: .smb, url: shareURL,
                                                    username: username.isEmpty ? nil : username))
        p.password = (password?.isEmpty ?? true) ? nil : password
        do {
            let root = try p.prepare(create: false)
            provider = p
            host = parts.host
            share = parts.share
            mountRoot = root
            return .success(root)
        } catch let e as ProviderError {
            p.finish()
            switch e {
            case .missingPassword: return .failure(.passwordRequired)
            case let .mountFailed(_, code): return .failure(DestinationProbe.failure(forMountStatus: code, share: shareURL))
            default: return .failure(.unreachable(parts.host))
            }
        } catch {
            p.finish()
            return .failure(.unreachable(parts.host))
        }
    }

    /// Chemin local d'un sous-dossier du partage monté.
    public func folder(_ subpath: [String]) -> URL? {
        subpath.reduce(mountRoot) { $0?.appendingPathComponent($1) }
    }

    /// Vérification complète d'une adresse SMB : connexion puis contrôle du dossier.
    public func check(address: String, username: String, password: String?) -> ProbeResult {
        switch connect(address: address, username: username, password: password) {
        case let .failure(f): return .failed(f)
        case .success:
            let sub = DestinationProbe.smbParts(address)?.subpath ?? []
            return folder(sub).map { DestinationProbe.checkFolder($0) } ?? .failed(.notFound(address))
        }
    }

    public var isConnected: Bool { mountRoot != nil }

    /// Démonte uniquement ce que la session a monté.
    public func close() {
        provider?.finish()
        provider = nil
        mountRoot = nil
        host = nil
        share = nil
    }

    deinit { provider?.finish() }
}

public extension CairnConfig {
    /// Identifiant d'une nouvelle destination : `main` pour la première, puis `nas` / `disk`, `nas-2`…
    static func newDestinationID(provider: Provider, existing: [String]) -> String {
        if existing.isEmpty { return OnboardingDraft.destinationID }
        let base = provider == .smb ? "nas" : "disk"
        if !existing.contains(base) { return base }
        var n = 2
        while existing.contains("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }
}
