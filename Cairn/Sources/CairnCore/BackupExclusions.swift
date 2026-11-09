import Foundation

/// Listes d'exclusion rsync de la sauvegarde (reprend scripts/backup.sh et la table « régénérable » de l'analyse).
public enum BackupExclusions {
    /// Métadonnées de volume (à la racine d'un dossier suivi).
    static let volumeMetadata = ["/.Spotlight-V100/", "/.fseventsd/", "/.Trashes/", "/.TemporaryItems/", "/.DocumentRevisions-V100/"]

    /// Dossiers et fichiers régénérables exclus partout.
    public static var staticPatterns: [String] {
        let regenerable = Scanner.alwaysRegenerable.filter { $0.value.isRegenerable }.keys.sorted().map { "\($0)/" }
        let extra = [".nyc_output/", ".stylelintcache", ".eslintcache", "*.tsbuildinfo", ".terraform/", ".DS_Store"]
        return volumeMetadata + regenerable + extra
    }

    /// Noms génériques exclus seulement s'ils sont générés.
    static let generic: Set<String> = ["lib", "build", "out", "target", "tmp", "temp", ".tmp", "vendor", ".build", ".gradle"]
    static let walkSkip: Set<String> = Set(Scanner.alwaysRegenerable.keys).union([".git"])

    /// Un dossier générique est-il généré ? Dans un dépôt git : seulement s'il est ignoré par le `.gitignore`.
    static func isGenerated(name: String, parent: String, inRepo: Bool) -> Bool {
        if inRepo {
            let r = Git(parent).run(["check-ignore", "-q", name + "/"])
            return r.status == 0
        }
        let fm = FileManager.default
        func has(_ f: String) -> Bool { fm.fileExists(atPath: parent + "/" + f) }
        switch name {
        case "lib": return has("package.json") && has("src")
        case "build", "out": return has("package.json") || has("build.gradle") || has("build.gradle.kts") || has("CMakeLists.txt")
        case "target": return has("Cargo.toml") || has("pom.xml")
        case "vendor": return has("composer.lock") || has("composer.json") || has("Gemfile") || has("go.mod")
        case ".build": return has("Package.swift")
        case ".gradle": return has("build.gradle") || has("build.gradle.kts") || has("settings.gradle") || has("gradlew")
        default: return true // tmp, temp, .tmp
        }
    }

    /// Dossiers génériques générés trouvés dans `root`, en chemins ancrés pour rsync (`/a/b/build/`).
    /// `visiting` reçoit chaque dossier parcouru (relatif à `root`), pour afficher l'avancement.
    /// `isCancelled` : parcours abandonné dès qu'il devient vrai (« Arrêter » pendant la préparation d'une sauvegarde).
    public static func detectGenerated(in root: String, isCancelled: () -> Bool = { false },
                                       visiting: (String) -> Void = { _ in }) -> [String] {
        var found: [String] = []
        let fm = FileManager.default
        func walk(_ dir: String, inRepo: Bool) {
            if isCancelled() { return }
            visiting(dir == root ? "" : String(dir.dropFirst(root.count + 1)))
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { return }
            let repoHere = inRepo || items.contains(".git")
            for item in items.sorted() {
                let p = dir + "/" + item
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue,
                      (try? fm.destinationOfSymbolicLink(atPath: p)) == nil else { continue }
                if walkSkip.contains(item) || volumeMetadata.contains("/\(item)/") { continue }
                if generic.contains(item) {
                    if isGenerated(name: item, parent: dir, inRepo: repoHere) {
                        found.append("/" + String(p.dropFirst(root.count + 1)) + "/")
                        continue
                    }
                }
                walk(p, inRepo: repoHere)
            }
        }
        walk(root, inRepo: false)
        return found
    }

    /// Liste complète pour un dossier suivi : statique, générée, motifs de l'utilisateur, destination incluse dans la source.
    public static func forFolder(_ root: String, userPatterns: [String], destinations: [String],
                                 isCancelled: () -> Bool = { false }, visiting: (String) -> Void = { _ in }) -> [String] {
        var list = staticPatterns + detectGenerated(in: root, isCancelled: isCancelled, visiting: visiting) + userPatterns
        for d in destinations where d.hasPrefix(root + "/") { list.append("/" + String(d.dropFirst(root.count + 1)) + "/") }
        return list
    }

    // MARK: Home

    /// Dossiers des outils IA (racines et marqueurs des profils) : sauvegardés par la partie IA,
    /// jamais par la sélection du home.
    public static func aiManaged(profiles: [AIProfile]) -> [String] {
        var out: [String] = []
        for p in profiles { for path in p.homePaths where !out.contains(path) { out.append(path) } }
        return out
    }

    public static var aiManaged: [String] { aiManaged(profiles: AIProfiles.bundled) }

    /// Caches et installations reconstructibles, exclus même dans un élément sélectionné.
    public static let homeExcludes = [
        ".cache/", "cache/", "Cache/", "Caches/", "logs/", "*.log", "node_modules/", ".DS_Store",
        ".npm/", ".bun/install/cache/", ".yarn/berry/cache/", ".pnpm-store/", ".local/share/pnpm/store/",
        ".local/share/mise/installs/", ".local/share/mise/downloads/", ".local/share/uv/tools/", ".local/share/uv/python/",
        ".local/pipx/venvs/", ".local/pipx/shared/", ".local/pipx/.cache/", ".ollama/models/", ".gradle/caches/",
        ".m2/repository/", ".cargo/registry/", ".rustup/toolchains/", ".composer/cache/", ".node-gyp/", ".zcompdump*",
    ]

    /// Éléments du home à copier (chemins relatifs), sans les dossiers des outils IA ni les éléments absents.
    public static func homeItems(_ include: [String], home: String, profiles: [AIProfile] = AIProfiles.bundled) -> [String] {
        let aiManaged = aiManaged(profiles: profiles)
        return include.map { $0.hasPrefix("~/") ? String($0.dropFirst(2)) : $0 }
            .filter { item in !aiManaged.contains { item == $0 || item.hasPrefix($0 + "/") } }
            .filter { FileManager.default.fileExists(atPath: home + "/" + $0) }
    }
}
