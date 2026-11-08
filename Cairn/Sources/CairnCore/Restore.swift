import Foundation

/// Une sauvegarde à restaurer : version Cairn ou sauvegarde héritée de scripts/backup.sh.
public struct RestoreSource: Sendable {
    public enum Kind: String, Sendable { case cairn, legacy }
    public struct Folder: Sendable, Equatable { public let name: String; public let originalPath: String; public let dir: URL }

    public let kind: Kind
    public let root: URL
    public let date: Date?
    public let machine: String
    public let arch: String
    public let folders: [Folder]
    public let home: URL?
    public let aiTools: [String]
    /// Dossier contenant l'inventaire (tools.toml, ou manifest/ hérité).
    public let toolsDir: URL?
    public let originalHome: String?

    public var archMatches: Bool { arch.isEmpty || arch == BackupEngine.arch() }

    /// Reconnaît une version Cairn (`manifest.json`) ou une sauvegarde héritée (`manifest/system.txt` + `home/`).
    public static func open(_ dir: URL) -> RestoreSource? {
        let fm = FileManager.default
        if let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
           let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let parts = m["parts"] as? [[String: String]] ?? []
            let folders = parts.filter { $0["kind"] == "folder" }.compactMap { p -> Folder? in
                guard let t = p["target"], let src = p["source"] else { return nil }
                return Folder(name: (t as NSString).lastPathComponent, originalPath: src, dir: dir.appendingPathComponent(t))
            }
            let ai = Set(parts.filter { $0["kind"] == "ai" }.compactMap { $0["target"]?.split(separator: "/").dropFirst().first.map(String.init) })
            let home = parts.first { $0["kind"] == "home" }
            return RestoreSource(kind: .cairn, root: dir, date: (m["date"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) },
                                 machine: m["machine"] as? String ?? "", arch: m["arch"] as? String ?? "",
                                 folders: folders, home: home.map { _ in dir.appendingPathComponent("home") },
                                 aiTools: ai.sorted(), toolsDir: fm.fileExists(atPath: dir.appendingPathComponent("tools").path) ? dir.appendingPathComponent("tools") : nil,
                                 originalHome: home?["source"])
        }
        let system = dir.appendingPathComponent("manifest/system.txt")
        guard let text = try? String(contentsOf: system, encoding: .utf8) else { return nil }
        var info: [String: String] = [:]
        for line in text.split(separator: "\n") {
            let kv = line.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { info[kv[0]] = kv[1] }
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let ws = dir.appendingPathComponent("workspaces")
        var ai: [String] = []
        if fm.fileExists(atPath: dir.appendingPathComponent("home/.claude").path) { ai.append("claude-code") }
        if fm.fileExists(atPath: dir.appendingPathComponent("ai/claude-desktop").path) { ai.append("claude-desktop") }
        if fm.fileExists(atPath: dir.appendingPathComponent("home/.codex").path) { ai.append("codex") }
        return RestoreSource(kind: .legacy, root: dir, date: info["date"].flatMap { f.date(from: $0) }, machine: info["host"] ?? "",
                             arch: info["arch"] ?? "",
                             folders: fm.fileExists(atPath: ws.path) ? [Folder(name: "workspaces", originalPath: info["workspace"] ?? "/Volumes/workspaces", dir: ws)] : [],
                             home: fm.fileExists(atPath: dir.appendingPathComponent("home").path) ? dir.appendingPathComponent("home") : nil,
                             aiTools: ai, toolsDir: dir.appendingPathComponent("manifest"), originalHome: info["home"])
    }

    /// Versions disponibles sur une destination montée (toutes machines).
    public static func versions(onDestinationRoot root: URL) -> [(machine: String, version: String, url: URL, partial: Bool)] {
        let base = root.appendingPathComponent("cairn")
        var out: [(String, String, URL, Bool)] = []
        for machine in ((try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? []).sorted() where !machine.hasPrefix(".") {
            let dir = base.appendingPathComponent(machine).appendingPathComponent("versions")
            for v in BackupEngine.versions(in: dir) {
                let url = dir.appendingPathComponent(v)
                out.append((machine, v, url, BackupEngine.isPartial(url)))
            }
        }
        return out
    }

    /// Version proposée par défaut : la plus récente version complète de ce Mac, sinon de n'importe quelle machine.
    public static func defaultVersion(_ all: [(machine: String, version: String, url: URL, partial: Bool)],
                                      machine: String = BackupEngine.machineName()) -> URL? {
        let complete = all.filter { !$0.partial }
        return (complete.last { $0.machine == machine } ?? complete.last ?? all.last)?.url
    }
}

/// Outil à réinstaller (lu depuis tools.toml ou les listes héritées).
public struct ToolToInstall: Equatable, Sendable {
    public let source: ToolSource
    public let name: String
    public let details: [String: String]
    public let commands: [String]
}

public enum ToolPlan {
    /// Ordre de réinstallation du design : Homebrew, mise, npm, uv, pipx, cargo, go.
    public static let order: [ToolSource] = [.brew, .mise, .npm, .uv, .pipx, .cargo, .go, .localBin]

    /// Lit `tools.toml` (Cairn) ou `Brewfile`, `npm-globals.txt`, `uv-tools.txt`, `pipx.json` (hérité).
    public static func read(_ dir: URL) -> (tools: [ToolToInstall], taps: [String], brewfile: URL?) {
        let fm = FileManager.default
        var tools: [ToolToInstall] = []
        var taps: [String] = []
        let brewfile = fm.fileExists(atPath: dir.appendingPathComponent("Brewfile").path) ? dir.appendingPathComponent("Brewfile") : nil
        if let text = try? String(contentsOf: dir.appendingPathComponent("tools.toml"), encoding: .utf8),
           let t = try? TOMLDocument(parsing: text).tree() {
            taps = t.value("taps")?.array?.compactMap(\.string) ?? []
            for src in order {
                for e in t.tables(src.rawValue) {
                    guard let name = e.value("name")?.string else { continue }
                    var details: [String: String] = [:]
                    for k in e.keys where !["name", "commands"].contains(k) { if let v = e.value(k)?.string { details[k] = v } }
                    tools.append(ToolToInstall(source: src, name: name, details: details,
                                               commands: e.value("commands")?.array?.compactMap(\.string) ?? [name]))
                }
            }
            return (tools, taps, brewfile)
        }
        // Sauvegarde héritée.
        if let bf = brewfile, let text = try? String(contentsOf: bf, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                let parts = line.split(separator: "\"")
                guard parts.count >= 2 else { continue }
                if line.hasPrefix("tap ") { taps.append(String(parts[1])) }
                if line.hasPrefix("brew ") {
                    let n = String(parts[1])
                    tools.append(ToolToInstall(source: .brew, name: n, details: [:], commands: InventoryRules.bundled.commands(for: n)))
                }
            }
        }
        if let text = try? String(contentsOf: dir.appendingPathComponent("npm-globals.txt"), encoding: .utf8) {
            for n in text.split(separator: "\n") where !n.isEmpty {
                tools.append(ToolToInstall(source: .npm, name: String(n), details: [:], commands: InventoryRules.bundled.commands(for: String(n))))
            }
        }
        if let text = try? String(contentsOf: dir.appendingPathComponent("uv-tools.txt"), encoding: .utf8) {
            for l in text.split(separator: "\n") {
                let p = l.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
                guard let spec = p.first, !spec.isEmpty else { continue }
                let name = String(spec.split(separator: "[").first ?? Substring(spec))
                var d: [String: String] = [:]
                if spec.contains("[") { d["extras"] = String(spec.split(separator: "[").last?.dropLast() ?? "") }
                if p.count > 1, !p[1].isEmpty { d["python"] = p[1] }
                tools.append(ToolToInstall(source: .uv, name: name, details: d, commands: [name]))
            }
        }
        // Outils de mise : section [tools] de la configuration globale sauvegardée.
        if let text = try? String(contentsOf: dir.appendingPathComponent("mise-config.toml"), encoding: .utf8),
           let t = (try? TOMLDocument(parsing: text).tree())?.table("tools") {
            for name in t.keys {
                let v = t.value(name)
                let requested = v?.string ?? v?.array?.compactMap(\.string).first ?? v?.inlineTable?.first { $0.0 == "version" }?.1.string
                let short = String(name.split(whereSeparator: { $0 == ":" || $0 == "/" }).last ?? Substring(name))
                tools.append(ToolToInstall(source: .mise, name: name, details: requested.map { ["requested": $0] } ?? [:],
                                           commands: InventoryRules.bundled.commands(for: short)))
            }
        }
        if let data = try? Data(contentsOf: dir.appendingPathComponent("pipx.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let venvs = obj["venvs"] as? [String: Any] {
            for n in venvs.keys.sorted() { tools.append(ToolToInstall(source: .pipx, name: n, details: [:], commands: [n])) }
        }
        return (tools, taps, brewfile)
    }

    /// Commande d'installation d'un outil (nil : réinstallation manuelle).
    public static func installCommand(_ t: ToolToInstall) -> [String]? {
        switch t.source {
        case .brew: return ["brew", "install", t.name]
        case .mise:
            let v = t.details["requested"] ?? "latest"
            return ["mise", "use", "-g", "\(t.name)@\(v)"]
        case .npm: return ["mise", "exec", "--", "npm", "install", "-g", t.name]
        case .uv:
            var spec = t.name
            if let e = t.details["extras"], !e.isEmpty { spec += "[\(e)]" }
            return ["uv", "tool", "install", "--force"] + (t.details["python"].map { ["--python", $0] } ?? []) + [spec]
        case .pipx: return ["pipx", "install", t.name]
        case .cargo: return ["cargo", "install", t.name]
        case .go, .localBin: return nil
        }
    }
}

/// Restauration sélective. Simulation par défaut : `apply` écrit réellement.
public final class RestoreService: @unchecked Sendable {
    public struct Plan: Sendable {
        public var tools = true
        public var home = true
        public var ai: [String] = []
        public var replaceDatabases = false
        /// Dossier de la sauvegarde → dossier cible.
        public var folders: [String: String] = [:]
        public init() {}
    }

    public struct StepResult: Sendable {
        public let step: String
        public let ok: Bool
        public let detail: String
        public init(step: String, ok: Bool, detail: String) { self.step = step; self.ok = ok; self.detail = detail }
    }

    public let source: RestoreSource
    public let runner: CommandRunner
    public let home: String
    public private(set) var log: [StepResult] = []
    /// Outil IA ouvert ? (remplaçable dans les tests)
    public var isRunning: (AIProfile) -> Bool = { RestoreService.running($0) }

    public init(source: RestoreSource, runner: CommandRunner = SystemRunner(), home: String = NSHomeDirectory()) {
        self.source = source
        self.runner = runner
        self.home = home
    }

    /// Taille à copier par partie (récapitulatif avant confirmation).
    public func sizes(_ plan: Plan) -> [String: Int64] {
        var s: [String: Int64] = [:]
        if plan.home, let h = source.home { s["home"] = Scanner.measure(h.path).size }
        for f in source.folders where plan.folders[f.name] != nil { s["folders/" + f.name] = Scanner.measure(f.dir.path).size }
        for t in plan.ai { s["ai/" + t] = Scanner.measure(source.root.appendingPathComponent("ai/\(t)").path).size }
        return s
    }

    /// Copie avec rsync ; les fichiers remplacés sont gardés avec le suffixe .pre-restore.
    func copy(_ from: URL, to: String, dryRun: Bool, excludes: [String] = []) -> (Bool, String) {
        try? FileManager.default.createDirectory(atPath: to, withIntermediateDirectories: true)
        let r = runner.run(["/usr/bin/rsync", "-a", "--backup", "--suffix=.pre-restore"] + (dryRun ? ["-n"] : [])
                           + excludes.map { "--exclude=/" + $0 }
                           + [from.path + "/", to.hasSuffix("/") ? to : to + "/"])
        return (r.status == 0 || r.status == 23 || r.status == 24, "rsync \(r.status)")
    }

    /// Droits des secrets restaurés : ~/.ssh 700, clés privées 600, fichiers d'authentification 600.
    public static func fixSecretPermissions(home: String) {
        let fm = FileManager.default
        let ssh = home + "/.ssh"
        if fm.fileExists(atPath: ssh) {
            try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: ssh)
            for f in (try? fm.contentsOfDirectory(atPath: ssh)) ?? [] {
                let p = ssh + "/" + f
                let perm = f.hasSuffix(".pub") || f == "known_hosts" || f == "config" ? 0o644 : 0o600
                try? fm.setAttributes([.posixPermissions: perm], ofItemAtPath: p)
            }
        }
        for f in [".netrc", ".codex/auth.json", ".codex/.credentials.json", ".aws/credentials"] where fm.fileExists(atPath: home + "/" + f) {
            try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: home + "/" + f)
        }
    }

    /// Exécute la restauration choisie. `waitForAdmin` est appelé pour une étape qui demande un mot de passe
    /// administrateur (installation de Homebrew) : elle s'ouvre dans Terminal, jamais dans Cairn.
    /// `waitForQuit` est appelé quand un outil IA à restaurer est ouvert : il demande de le quitter et renvoie
    /// `true` une fois l'outil fermé (sinon l'outil est passé).
    public func run(_ plan: Plan, apply: Bool, waitForAdmin: (String) -> Bool = { _ in false },
                    waitForQuit: (AIProfile) -> Bool = { _ in false },
                    progress: (String) -> Void = { _ in }) -> [StepResult] {
        log = []
        func record(_ step: String, _ ok: Bool, _ detail: String = "") { log.append(StepResult(step: step, ok: ok, detail: detail)); progress(step) }

        if plan.home, let h = source.home {
            // Sauvegarde héritée : les dossiers des outils IA sont dans home/ ; ils passent par la fusion IA,
            // jamais par la copie du home.
            let (ok, d) = copy(h, to: home, dryRun: !apply, excludes: source.kind == .legacy ? BackupExclusions.aiManaged : [])
            if apply { Self.fixSecretPermissions(home: home) }
            record("home", ok, d)
        }
        var prefixes: [(String, String)] = []
        if let oh = source.originalHome, oh != home { prefixes.append((oh, home)) }
        for f in source.folders {
            guard let target = plan.folders[f.name] else { continue }
            let (ok, d) = copy(f.dir, to: target, dryRun: !apply)
            record("folders/" + f.name, ok, d)
            if f.originalPath != target { prefixes.append((f.originalPath, target)) }
        }
        if !plan.ai.isEmpty {
            // Un outil ouvert réécrirait ses fichiers par-dessus la restauration : il doit être quitté avant.
            var tools: [String] = []
            for id in plan.ai {
                guard let p = AIProfiles.bundled.first(where: { $0.id == id }) else { tools.append(id); continue }
                if apply && isRunning(p) && !waitForQuit(p) {
                    record("ai/\(id)", false, L10n.tr("restore.ai.skipped_open"))
                } else {
                    tools.append(id)
                }
            }
            do {
                var report = AIRestore.Report()
                if apply && !tools.isEmpty {
                    if source.kind == .legacy {
                        report = try AIRestore.restoreLegacy(backup: source.root, tools: Set(tools), home: home,
                                                             replaceDatabases: plan.replaceDatabases, prefixes: prefixes)
                    } else {
                        for id in tools {
                            guard let p = AIProfiles.bundled.first(where: { $0.id == id }) else { continue }
                            let r = try AIRestore.restore(toolDir: source.root.appendingPathComponent("ai/\(id)"), profile: p, home: home,
                                                          replaceDatabases: plan.replaceDatabases, prefixes: prefixes)
                            report.renamedProjects += r.renamedProjects
                            report.notRewritten += r.notRewritten
                        }
                    }
                    Self.fixSecretPermissions(home: home)
                } else if !apply {
                    // Simulation : les données qui garderont leurs anciens chemins sont annoncées dès maintenant.
                    for id in tools { report.notRewritten += AIRestore.notRewritten(tool: id, home: home, prefixes: prefixes) }
                }
                if !tools.isEmpty {
                    var detail = tools.joined(separator: ", ")
                    if !report.renamedProjects.isEmpty { detail += " — " + L10n.tr("restore.ai.renamed", report.renamedProjects.count) }
                    record("ai", true, detail)
                }
                for note in report.notRewritten { record("ai:paths", true, note) }
            } catch {
                record("ai", false, String(describing: error))
            }
        }
        if plan.tools, let dir = source.toolsDir {
            reinstallTools(dir, apply: apply, waitForAdmin: waitForAdmin, record: record)
        }
        return log
    }

    func available(_ cmd: String) -> Bool {
        runner.run(["/bin/sh", "-c", "command -v \(cmd)"]).status == 0
    }

    /// Réinstalle dans l'ordre du design ; les outils présents sont ignorés, chaque échec est noté sans arrêter la suite.
    func reinstallTools(_ dir: URL, apply: Bool, waitForAdmin: (String) -> Bool, record: (String, Bool, String) -> Void) {
        let (tools, taps, _) = ToolPlan.read(dir)
        if !available("brew") && tools.contains(where: { $0.source == .brew }) {
            let cmd = "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            let ok = apply ? waitForAdmin(cmd) : false
            record("brew-install", ok || !apply, apply ? "" : "simulation")
        }
        if apply { for tap in taps { _ = runner.run(["brew", "tap", tap]) } }
        for src in ToolPlan.order {
            for t in tools where t.source == src {
                let present = t.commands.contains { available($0) }
                if present { record("tool:\(t.name)", true, "present"); continue }
                guard let cmd = ToolPlan.installCommand(t) else { record("tool:\(t.name)", false, "manual"); continue }
                guard apply else { record("tool:\(t.name)", true, "would install: " + cmd.joined(separator: " ")); continue }
                let r = runner.run(cmd)
                record("tool:\(t.name)", r.status == 0, r.status == 0 ? "installed" : "failed (\(r.status))")
            }
        }
    }

    /// Vérification finale : outils de l'inventaire disponibles ou manquants (aucune modification).
    public func check() -> (present: [String], missing: [String]) {
        guard let dir = source.toolsDir else { return ([], []) }
        let (tools, _, _) = ToolPlan.read(dir)
        var present: [String] = [], missing: [String] = []
        for t in tools { (t.commands.contains { available($0) } ? { present.append(t.name) } : { missing.append(t.name) })() }
        return (present, missing)
    }

    /// Un processus de l'outil tourne-t-il ?
    public static func running(_ p: AIProfile) -> Bool {
        let names = Set(p.processes ?? [])
        guard !names.isEmpty else { return false }
        return !names.isDisjoint(with: AIBackup.runningApps())
    }

    /// Attend que l'outil soit quitté (vérification toutes les 2 s, 10 minutes au plus).
    public static func waitUntilQuit(_ p: AIProfile, timeout: TimeInterval = 600) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !running(p) { return true }
            Thread.sleep(forTimeInterval: 2)
        }
        return false
    }

    /// Ouvre une commande dans Terminal (étapes qui demandent le mot de passe administrateur).
    public static func openInTerminal(_ command: String) {
        let escaped = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "tell application \"Terminal\" to do script \"\(escaped)\"", "-e", "tell application \"Terminal\" to activate"]
        try? p.run()
    }

    /// Attend qu'une commande devienne disponible (vérification toutes les 5 s).
    public static func waitFor(_ command: String, timeout: TimeInterval = 1800) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/\(command)")
                || FileManager.default.isExecutableFile(atPath: "/usr/local/bin/\(command)") { return true }
            Thread.sleep(forTimeInterval: 5)
        }
        return false
    }

    /// Crée le volume APFS « workspaces » dans le conteneur du disque de démarrage.
    public static func createWorkspacesVolume() -> (Bool, String) {
        let info = SystemRunner().run(["/usr/sbin/diskutil", "info", "/"])
        let text = String(decoding: info.output, as: UTF8.self)
        guard let line = text.split(separator: "\n").first(where: { $0.contains("Part of Whole") }),
              let container = line.split(separator: ":").last?.trimmingCharacters(in: .whitespaces) else { return (false, text) }
        let r = SystemRunner().run(["/usr/sbin/diskutil", "apfs", "addVolume", container, "APFS", "workspaces"])
        return (r.status == 0, String(decoding: r.output, as: UTF8.self))
    }
}
