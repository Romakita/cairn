import Foundation

/// Brouillon de l'assistant de premier lancement. Rien n'est écrit sur disque avant `finish`.
public struct OnboardingDraft: Equatable, Sendable {
    public struct Choice: Equatable, Sendable, Identifiable {
        public var path: String
        public var selected: Bool
        public var id: String { path }
        public init(path: String, selected: Bool) { self.path = path; self.selected = selected }
    }

    public struct AIChoice: Equatable, Sendable, Identifiable {
        public var id: String
        public var detected: Bool
        public var categories: Set<String>
        public init(id: String, detected: Bool, categories: Set<String>) {
            self.id = id; self.detected = detected; self.categories = categories
        }
    }

    public enum DestinationChoice: Equatable, Sendable {
        case later
        case local(path: String)
        case smb(url: String, username: String)
    }

    public var folders: [Choice] = []
    public var home: [Choice] = []
    public var ai: [AIChoice] = []
    public var destination = DestinationChoice.later
    public var encrypted = true
    public var frequency = CairnConfig.Frequency.daily
    public var time = "12:30"
    public var weekday = "monday"
    public var background = false
    public var language = "auto"

    public init() {}


    /// Fichiers de configuration du home proposés s'ils existent (les dossiers des outils IA sont gérés à part).
    public static let homeCandidates = [
        ".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".gitconfig", ".gitignore_global",
        ".ssh", ".aws", ".kube", ".docker/config.json", ".npmrc", ".yarnrc", ".netrc", ".config/mise", ".config/gh",
        ".config/git", ".config/starship.toml", ".oh-my-zsh/custom", ".zsh_history", ".gnupg",
    ]

    /// Dossiers cachés à la racine du home (sans suivre les liens symboliques).
    public static func listHiddenFolders(_ home: URL) -> [String] {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: home.path)) ?? []
        return names.filter { name in
            guard name.hasPrefix("."), name != ".", name != ".." else { return false }
            let values = try? home.appendingPathComponent(name).resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            return values?.isDirectory == true && values?.isSymbolicLink != true
        }
    }

    /// Dossiers visibles à la racine du home, sans `Library` (système, gérée à part pour les outils IA)
    /// ni liens symboliques.
    public static func listVisibleFolders(_ home: URL) -> [String] {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: home.path)) ?? []
        return names.filter { name in
            guard !name.hasPrefix("."), name != "Library" else { return false }
            let values = try? home.appendingPathComponent(name).resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            return values?.isDirectory == true && values?.isSymbolicLink != true
        }
    }

    /// Éléments du home proposés dans les réglages, triés par nom (sans le point initial) : ceux déjà sauvegardés,
    /// les fichiers de configuration connus présents, et tous les dossiers cachés ou visibles de la racine du home
    /// (hors outils IA, caches et corbeille).
    public static func homeChoices(include: [String], home: URL = FileManager.default.homeDirectoryForCurrentUser,
                                   exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                                   hiddenFolders: (URL) -> [String] = OnboardingDraft.listHiddenFolders,
                                   visibleFolders: (URL) -> [String] = OnboardingDraft.listVisibleFolders,
                                   profiles: [AIProfile] = AIProfiles.bundled) -> [String] {
        let known = homeCandidates.filter { exists(home.appendingPathComponent($0).path) }
        let folders = (hiddenFolders(home) + visibleFolders(home)).filter { !homeSkipped($0, profiles: profiles) }
        return sortedHomeItems(include + known + folders)
    }

    /// Éléments du home sans doublons, triés par nom sans le point initial (`.aws` avec les `a`).
    public static func sortedHomeItems(_ items: [String]) -> [String] {
        var seen = Set<String>()
        return items.filter { seen.insert($0).inserted }
            .sorted { sortKey($0).localizedStandardCompare(sortKey($1)) == .orderedAscending }
    }

    /// Dossiers cachés jamais proposés : outils IA (gérés à part), caches et corbeille, dossier de Cairn.
    static func homeSkipped(_ name: String, profiles: [AIProfile]) -> Bool {
        if name == ".cairn" || Scanner.alwaysRegenerable[name] != nil { return true }
        let excludes = BackupExclusions.homeExcludes.map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 }
        if excludes.contains(name) { return true }
        return BackupExclusions.aiManaged(profiles: profiles).contains(name)
    }

    /// Clé de tri : sans le point initial, pour ranger `.aws` avec les `a`.
    static func sortKey(_ path: String) -> String { path.hasPrefix(".") ? String(path.dropFirst()) : path }

    /// Propositions détectées sur la machine.
    public static func detect(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                              legacyRootPath: String? = nil,
                              exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                              hiddenFolders: (URL) -> [String] = OnboardingDraft.listHiddenFolders,
                              profiles: [AIProfile] = AIProfiles.bundled) -> OnboardingDraft {
        var d = OnboardingDraft()
        var seen = Set<String>()
        let candidates = ["/Volumes/workspaces", legacyRootPath].compactMap { $0 }
            + ["Projects", "Projets", "Developer", "workspace", "code"].map { home.appendingPathComponent($0).path }
        // Présélection : /Volumes/workspaces et l'ancien dossier de l'app, repérés par leur chemin (pas leur rang).
        let preselected = Set(["/Volumes/workspaces", legacyRootPath].compactMap { $0 })
        for path in candidates where exists(path) && seen.insert(path).inserted {
            d.folders.append(.init(path: path, selected: preselected.contains(path)))
        }
        if !d.folders.contains(where: \.selected), !d.folders.isEmpty { d.folders[0].selected = true }

        // Fichiers connus (cochés) puis tous les autres dossiers cachés du home (à cocher), triés par nom.
        let known = homeCandidates.filter { exists(home.appendingPathComponent($0).path) }
        let others = hiddenFolders(home).filter { name in
            !known.contains(name) && !homeSkipped(name, profiles: profiles)
        }
        d.home = (known.map { Choice(path: $0, selected: true) } + others.map { Choice(path: $0, selected: false) })
            .sorted { sortKey($0.path).localizedStandardCompare(sortKey($1.path)) == .orderedAscending }

        // Outils IA : un par profil ; présélection des catégories que l'outil remplit vraiment
        // (pas d'« identifiants » pour un outil qui les range dans le Trousseau).
        for p in profiles {
            let found = p.detect.contains { exists(home.appendingPathComponent($0).path) }
            let cats = CairnConfig.AITool.categories.filter { !(p.categories[$0] ?? []).isEmpty }
            d.ai.append(.init(id: p.id, detected: found, categories: found ? Set(cats) : []))
        }
        return d
    }

    /// Les identifiants ne sont cochés que si la destination est chiffrée.
    public var effectiveAI: [AIChoice] {
        ai.map { c in
            var c = c
            if !encrypted || destination == .later { c.categories.remove("credentials") }
            return c
        }
    }

    /// Identifiant de la destination créée par l'assistant.
    public static let destinationID = "main"

    /// Configuration produite par l'assistant.
    public func makeConfig() -> CairnConfig {
        var c = CairnConfig()
        c.language = language
        c.folders = folders.filter(\.selected).map { .init(path: $0.path) }
        c.home.include = home.filter(\.selected).map(\.path)
        c.ai = effectiveAI.filter(\.detected).map {
            .init(id: $0.id, categories: CairnConfig.AITool.categories.filter($0.categories.contains))
        }
        switch destination {
        case .later: break
        case let .local(path):
            c.destinations = [.init(id: Self.destinationID, provider: .local, path: path, encrypted: encrypted)]
        case let .smb(url, username):
            // Pas de clé `keychain` : l'entrée du Trousseau se déduit de l'hôte de `url` et de `username`.
            c.destinations = [.init(id: Self.destinationID, provider: .smb, url: url, username: username, encrypted: encrypted)]
        }
        c.schedule.frequency = frequency
        c.schedule.time = time
        c.schedule.weekday = weekday
        c.schedule.background = background
        return c
    }

    /// Hôte d'une URL SMB (pour l'entrée du Trousseau).
    public static func smbHost(_ url: String) -> String? { URL(string: url)?.host }
}
