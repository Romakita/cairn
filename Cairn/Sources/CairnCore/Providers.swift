import Foundation
import NetFS

/// Fournisseur de destination : rend un dossier local monté où écrire, puis nettoie.
/// Un futur drive en ligne n'a qu'à implémenter ce protocole.
public protocol BackupProvider: AnyObject, Sendable {
    var destination: CairnConfig.Destination { get }
    /// Joignable maintenant (sans rien monter) ?
    func isReachable() -> Bool
    /// Dossier racine prêt à recevoir les données.
    /// Dossier local où écrire. `create: false` (simulation, restauration) ne crée rien sur la destination.
    func prepare(create: Bool) throws -> URL
    func finish()
}

public extension BackupProvider {
    func prepare() throws -> URL { try prepare(create: true) }
}

public enum ProviderError: Error, CustomStringConvertible {
    case unreachable(String)
    case missingPassword(String)
    case missingImagePassword(String)
    case mountFailed(String, Int32)
    case image(String)
    /// Image encore ouverte ailleurs (montage d'une sauvegarde précédente resté bloqué) : verrou du sparsebundle pris.
    case imageBusy(String)
    /// Rien n'existe encore sur la destination (simulation ou restauration).
    case notCreated(String)
    public var description: String {
        switch self {
        case let .unreachable(d): L10n.tr("destination.error.unreachable", d)
        case let .missingPassword(d): L10n.tr("destination.error.password", d)
        case let .missingImagePassword(p): L10n.tr("destination.error.image_password", (p as NSString).lastPathComponent)
        case let .notCreated(d): L10n.tr("destination.error.not_created", d)
        case let .mountFailed(d, code): L10n.tr("destination.error.mount", d, Int(code))
        case let .image(m): L10n.tr("destination.error.image", m)
        case let .imageBusy(p): L10n.tr("destination.error.image_busy", (p as NSString).lastPathComponent)
        }
    }
}

/// Dossier local ou disque externe.
public final class LocalProvider: BackupProvider, @unchecked Sendable {
    public let destination: CairnConfig.Destination
    public init(_ d: CairnConfig.Destination) { destination = d }

    var path: String { ((destination.path ?? "") as NSString).expandingTildeInPath }

    public func isReachable() -> Bool {
        let p = path
        guard !p.isEmpty else { return false }
        // Disque externe : le volume doit être monté (le dossier lui-même peut ne pas encore exister).
        if p.hasPrefix("/Volumes/") {
            let volume = "/Volumes/" + (p.dropFirst("/Volumes/".count).split(separator: "/").first.map(String.init) ?? "")
            return FileManager.default.fileExists(atPath: volume)
        }
        return FileManager.default.fileExists(atPath: (p as NSString).deletingLastPathComponent)
    }

    public func prepare(create: Bool) throws -> URL {
        guard isReachable() else { throw ProviderError.unreachable(destination.id) }
        if !FileManager.default.fileExists(atPath: path) {
            guard create else { throw ProviderError.notCreated(destination.id) }
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        }
        return URL(fileURLWithPath: path)
    }

    public func finish() {}
}

/// Partage SMB (NAS Synology) : monté avec les identifiants du Trousseau, démonté s'il a été monté par Cairn.
public final class SMBProvider: BackupProvider, @unchecked Sendable {
    public let destination: CairnConfig.Destination
    private var mountedByUs: String?
    /// Mot de passe saisi pour cette session (restauration sur un Mac neuf, Trousseau vide).
    public var password: String?

    public init(_ d: CairnConfig.Destination) { destination = d }

    var url: URL? { destination.url.flatMap(URL.init(string:)) }

    /// Port 445 joignable en moins de 3 s.
    public func isReachable() -> Bool {
        guard let host = url?.host else { return false }
        return Reachability.tcp(host: host, port: url?.port ?? 445, timeout: 3)
    }

    /// Point de montage existant du partage, s'il est déjà monté.
    func existingMount() -> String? {
        guard let url, let host = url.host?.lowercased() else { return nil }
        let share = url.path.split(separator: "/").first.map { String($0).lowercased() } ?? ""
        var mounts: UnsafeMutablePointer<statfs>?
        let n = getmntinfo(&mounts, MNT_NOWAIT)
        guard n > 0, let mounts else { return nil }
        for i in 0..<Int(n) {
            var m = mounts[i]
            let type = withUnsafePointer(to: &m.f_fstypename) { $0.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) } }
            guard type == "smbfs" else { continue }
            let from = withUnsafePointer(to: &m.f_mntfromname) { $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }.lowercased()
            if from.contains(host) && from.hasSuffix("/" + share) {
                return withUnsafePointer(to: &m.f_mntonname) { $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }
            }
        }
        return nil
    }

    public func prepare(create: Bool) throws -> URL {
        guard let url, let host = url.host else { throw ProviderError.unreachable(destination.id) }
        guard isReachable() else { throw ProviderError.unreachable(destination.id) }
        let sub = url.path.split(separator: "/").dropFirst().joined(separator: "/")
        if let mount = existingMount() { return URL(fileURLWithPath: mount).appendingPathComponent(sub) }
        let user = destination.username ?? NSUserName()
        guard let password = password ?? Keychain.internetPassword(server: host, account: user) else {
            throw ProviderError.missingPassword(destination.id)
        }
        let share = URL(string: "smb://\(host)/" + (url.path.split(separator: "/").first.map(String.init) ?? ""))!
        var points: Unmanaged<CFArray>?
        let openOptions = NSMutableDictionary(dictionary: [kNAUIOptionKey as String: kNAUIOptionNoUI as String])
        let mountOptions = NSMutableDictionary(dictionary: [kNetFSSoftMountKey as String: true])
        let status = NetFSMountURLSync(share as CFURL, nil, user as CFString, password as CFString,
                                       openOptions as CFMutableDictionary, mountOptions as CFMutableDictionary, &points)
        guard status == 0, let mount = (points?.takeRetainedValue() as? [String])?.first else {
            throw ProviderError.mountFailed(destination.id, status)
        }
        mountedByUs = mount
        return URL(fileURLWithPath: mount).appendingPathComponent(sub)
    }

    public func finish() {
        if let m = mountedByUs { unmount(m, 0); mountedByUs = nil }
    }
}

public enum Reachability {
    /// Connexion TCP avec délai (sonde de joignabilité, sans rien envoyer).
    public static func tcp(host: String, port: Int, timeout: TimeInterval) -> Bool {
        var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM, ai_protocol: 0,
                             ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let first = res else { return false }
        defer { freeaddrinfo(res) }
        var ai: UnsafeMutablePointer<addrinfo>? = first
        while let a = ai {
            let fd = socket(a.pointee.ai_family, a.pointee.ai_socktype, a.pointee.ai_protocol)
            if fd >= 0 {
                defer { close(fd) }
                _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
                let r = connect(fd, a.pointee.ai_addr, a.pointee.ai_addrlen)
                if r == 0 { return true }
                if errno == EINPROGRESS {
                    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    if poll(&pfd, 1, Int32(timeout * 1000)) == 1 {
                        var err: Int32 = 0
                        var len = socklen_t(MemoryLayout<Int32>.size)
                        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
                        if err == 0 { return true }
                    }
                }
            }
            ai = a.pointee.ai_next
        }
        return false
    }
}

/// Image disque sparsebundle APFS (chiffrée en AES-256 si demandé), posée sur la destination.
public final class SparseImage: @unchecked Sendable {
    public let path: String
    public let encrypted: Bool
    public let keychainService: String
    let keychainAccount: String
    private(set) var mountPoint: String?

    public init(root: URL, destinationID: String, encrypted: Bool, machine: String = BackupEngine.machineName()) {
        path = root.appendingPathComponent("cairn-\(machine).sparsebundle").path
        self.encrypted = encrypted
        keychainService = Keychain.servicePrefix + "image." + destinationID
        keychainAccount = machine
    }

    /// Image existante d'une autre machine (restauration) ; le chiffrement est lu sur l'image elle-même.
    public init(existing path: String, destinationID: String) {
        self.path = path
        let name = (path as NSString).lastPathComponent
        let machine = String(name.dropFirst("cairn-".count).dropLast(".sparsebundle".count))
        encrypted = SparseImage.isEncrypted(path)
        keychainService = Keychain.servicePrefix + "image." + destinationID
        keychainAccount = machine
    }

    /// Images Cairn posées sur une destination (une par machine).
    public static func images(at base: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? [])
            .filter { $0.hasPrefix("cairn-") && $0.hasSuffix(".sparsebundle") }.sorted()
            .map { base.appendingPathComponent($0).path }
    }

    static func isEncrypted(_ path: String) -> Bool {
        hdiutil(["isencrypted", path]).1.contains("encrypted: YES")
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: path) }

    static func hdiutil(_ args: [String], stdin: String? = nil) -> (Int32, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        p.arguments = args
        // Messages en anglais (reconnus par `attachFailure`), quelle que soit la langue du Mac.
        p.environment = ProcessInfo.processInfo.environment.merging(["LC_ALL": "C", "LANG": "C"]) { $1 }
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        let input = Pipe()
        if stdin != nil { p.standardInput = input }
        do { try p.run() } catch { return (127, "") }
        if let stdin {
            let writer = input.fileHandleForWriting
            WaitedWork.async(qos: .userInitiated) {
                writer.write(Data((stdin + "\0").utf8))
                try? writer.close()
            }
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        // L'avertissement « -nobrowse is deprecated » n'apporte rien au message d'erreur.
        let text = String(decoding: data, as: UTF8.self).components(separatedBy: "\n")
            .filter { !$0.contains("WARNING:") || !$0.contains("deprecated") }.joined(separator: "\n")
        return (p.terminationStatus, text)
    }

    /// Mot de passe de l'image (Trousseau).
    public var password: String? { Keychain.password(service: keychainService, account: keychainAccount) }

    /// Crée l'image ; renvoie son mot de passe (à montrer une seule fois) si elle est chiffrée. Un mot de passe déjà
    /// rangé pour cette destination et cette machine est repris, jamais remplacé : il ouvre peut-être une image
    /// laissée à l'ancien emplacement de la destination (dossier modifié).
    @discardableResult
    public func create(size: String = "4t", password provided: String? = nil) throws -> String? {
        var args = ["create", "-size", size, "-type", "SPARSEBUNDLE", "-fs", "APFS", "-volname", "Cairn", path]
        var pw: String?
        if encrypted {
            let existing = password
            pw = provided ?? existing ?? Self.generatePassword()
            args += ["-encryption", "AES-256", "-stdinpass"]
            if pw != existing { try Keychain.setPassword(pw!, service: keychainService, account: keychainAccount) }
        }
        let (code, out) = Self.hdiutil(args, stdin: pw)
        guard code == 0 else { throw ProviderError.image(out.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return pw
    }

    /// Monte l'image (invisible dans le Finder) et renvoie son point de montage.
    public func attach(password provided: String? = nil) throws -> URL {
        var args = ["attach", "-nobrowse", "-noautoopen", "-plist", path]
        var pw: String?
        if encrypted {
            pw = provided ?? password
            guard pw != nil else { throw ProviderError.missingImagePassword(path) }
            args.insert("-stdinpass", at: 1)
        }
        let (code, out) = Self.hdiutil(args, stdin: pw)
        guard code == 0, let data = out.data(using: .utf8),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let entities = plist["system-entities"] as? [[String: Any]],
              let mp = entities.compactMap({ $0["mount-point"] as? String }).first else {
            throw Self.attachFailure(output: out, path: path)
        }
        mountPoint = mp
        return URL(fileURLWithPath: mp)
    }

    /// Erreur d'un `hdiutil attach` raté. EAGAIN : le verrou de l'image est tenu par un autre processus.
    public static func attachFailure(output: String, path: String) -> ProviderError {
        // hdiutil répond dans la langue du Mac malgré LC_ALL : message anglais et français.
        let busy = ["Resource temporarily unavailable", "Ressources temporairement indisponibles"]
        if busy.contains(where: output.contains) { return .imageBusy(path) }
        return .image(output.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public func detach() {
        guard let mp = mountPoint else { return }
        if Self.hdiutil(["detach", mp]).0 != 0 { _ = Self.hdiutil(["detach", "-force", mp]) }
        mountPoint = nil
    }

    /// Résultat de `hdiutil verify`.
    public struct Check: Sendable, Equatable {
        public let ok: Bool
        public let output: String
    }

    /// Contrôle de l'image avec `hdiutil verify` (image détachée). Un sparsebundle n'a pas de somme de contrôle
    /// globale : « has no checksum » veut dire que l'image s'ouvre (structure lisible, mot de passe accepté) et compte
    /// comme réussi ; toute autre erreur (image illisible, mot de passe refusé) est un échec.
    public func verify(password provided: String? = nil) -> Check {
        var args = ["verify", path]
        var pw: String?
        if encrypted {
            pw = provided ?? password
            guard pw != nil else { return Check(ok: false, output: ProviderError.missingImagePassword(path).description) }
            args.insert("-stdinpass", at: 1)
        }
        let (code, out) = Self.hdiutil(args, stdin: pw)
        let text = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return Check(ok: code == 0 || text.contains("has no checksum"), output: text)
    }

    /// Récupère l'espace libéré par la rétention.
    public func compact() {
        _ = Self.hdiutil(["compact", "-batteryallowed", path] + (encrypted ? ["-stdinpass"] : []), stdin: encrypted ? password : nil)
    }

    static func generatePassword() -> String {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789")
        var g = SystemRandomNumberGenerator()
        return (0..<4).map { _ in String((0..<6).map { _ in alphabet.randomElement(using: &g)! }) }.joined(separator: "-")
    }
}

/// Destination prête à l'emploi : fournisseur + image éventuelle.
public final class DestinationSession: @unchecked Sendable {
    public let destination: CairnConfig.Destination
    public let provider: BackupProvider
    var image: SparseImage?
    public private(set) var root: URL?
    public private(set) var imageBase: URL?
    /// Mot de passe généré à la création de l'image (à montrer une fois).
    public private(set) var newImagePassword: String?

    public init(_ d: CairnConfig.Destination) {
        destination = d
        provider = Self.provider(for: d)
    }

    public static func provider(for d: CairnConfig.Destination) -> BackupProvider {
        switch d.provider {
        case .local: LocalProvider(d)
        case .smb: SMBProvider(d)
        }
    }

    /// Une image est utilisée sur un NAS (liens physiques et droits fiables) ou si le chiffrement est demandé.
    public var usesImage: Bool { destination.provider == .smb || destination.encrypted }

    /// Mot de passe de l'image saisi pour cette session (le Trousseau d'un Mac neuf est vide).
    public var imagePassword: String?
    /// Mot de passe du partage SMB saisi pour cette session.
    public var sharePassword: String? {
        get { (provider as? SMBProvider)?.password }
        set { (provider as? SMBProvider)?.password = newValue }
    }

    /// Ouvre la destination. `createIfMissing: false` (simulation, restauration) n'écrit rien : sans image ni
    /// dossier, l'erreur est `notCreated`. En restauration, l'image d'une autre machine est reprise si celle de ce Mac
    /// n'existe pas.
    /// `preferredImage` : nom de l'image (`cairn-<machine>.sparsebundle`) choisie par l'utilisateur pour une
    /// restauration ; prise si elle existe (le point de montage d'un NAS change d'une session à l'autre).
    public func open(createIfMissing: Bool = true, preferredImage: String? = nil) throws -> URL {
        let base = try provider.prepare(create: createIfMissing)
        imageBase = base
        guard usesImage else { root = base; return base }
        if let name = preferredImage,
           let chosen = SparseImage.images(at: base).first(where: { ($0 as NSString).lastPathComponent == name }) {
            return try attach(SparseImage(existing: chosen, destinationID: destination.id))
        }
        var img = SparseImage(root: base, destinationID: destination.id, encrypted: destination.encrypted)
        if !img.exists {
            guard !createIfMissing else {
                newImagePassword = try img.create()
                return try attach(img)
            }
            guard let other = SparseImage.images(at: base).first else { throw ProviderError.notCreated(destination.id) }
            img = SparseImage(existing: other, destinationID: destination.id)
        }
        return try attach(img)
    }

    private func attach(_ img: SparseImage) throws -> URL {
        let mp = try img.attach(password: imagePassword)
        image = img
        root = mp
        return mp
    }

    public func close(compact: Bool = false) {
        image?.detach()
        if compact { image?.compact() }
        provider.finish()
    }

    /// `hdiutil verify` de l'image utilisée (nil sans image). À appeler avant `close` : l'image est détachée
    /// pour le contrôle, le partage qui la porte reste monté jusqu'à `close`.
    public func verifyImage() -> SparseImage.Check? {
        guard let image else { return nil }
        image.detach()
        return image.verify(password: imagePassword)
    }
}
