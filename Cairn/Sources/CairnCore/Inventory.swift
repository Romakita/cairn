import Foundation

/// Source d'installation d'un outil en ligne de commande (les applications graphiques ne sont jamais inventoriées).
public enum ToolSource: String, CaseIterable, Sendable, Codable {
    case brew, mise, npm, uv, pipx, cargo, go, localBin = "local-bin"
}

public struct CLITool: Identifiable, Hashable, Sendable {
    public let name: String
    public let source: ToolSource
    public let version: String?
    /// Commandes fournies (pour l'historique et les règles).
    public let commands: [String]
    /// Paramètres d'installation (extras, version de Python…).
    public let details: [String: String]
    public var id: String { "\(source.rawValue):\(name)" }

    public init(name: String, source: ToolSource, version: String?, commands: [String], details: [String: String] = [:]) {
        self.name = name; self.source = source; self.version = version; self.commands = commands; self.details = details
    }
}

/// Raison pour laquelle un outil est considéré comme utilisé (ou requis). Codes stables en JSON, texte traduit à l'affichage.
public enum InventoryReason: Hashable, Sendable {
    /// Fichier de configuration du home (`.kube` → « ~/.kube »).
    case home(String)
    /// Fichier de projet dans un dossier suivi (`justfile`).
    case project(String)
    /// Commandes de l'outil lancées `uses` fois dans l'historique du shell.
    case history(uses: Int)

    /// Texte affiché, dans la langue active.
    public var text: String {
        switch self {
        case let .home(marker): "~/" + marker
        case let .project(marker): marker
        case let .history(uses): L10n.tr("inventory.reason.history", uses)
        }
    }

    /// Forme JSON, indépendante de la langue : `{"code":"history","uses":5}`, `{"code":"home","file":".kube"}`…
    public var json: [String: Any] {
        switch self {
        case let .home(marker): ["code": "home", "file": marker]
        case let .project(marker): ["code": "project", "file": marker]
        case let .history(uses): ["code": "history", "uses": uses]
        }
    }
}

public struct InventoryEntry: Identifiable, Hashable, Sendable {
    public enum Status: String, Sendable { case used, unused, missing }
    public let name: String
    public let tool: CLITool?
    public let status: Status
    public let reasons: [InventoryReason]
    public var excluded: Bool
    public var id: String { tool?.id ?? "missing:\(name)" }
    /// Raisons affichées, dans la langue active.
    public var reasonTexts: [String] { reasons.map(\.text) }

    public init(name: String, tool: CLITool?, status: Status, reasons: [InventoryReason], excluded: Bool) {
        self.name = name; self.tool = tool; self.status = status; self.reasons = reasons; self.excluded = excluded
    }
}

public struct Inventory: Sendable {
    public var entries: [InventoryEntry]
    public var taps: [String]

    public init(entries: [InventoryEntry], taps: [String]) { self.entries = entries; self.taps = taps }

    public var retained: [CLITool] { entries.filter { !$0.excluded }.compactMap(\.tool) }
}

// MARK: - Règles

public struct InventoryRules: Sendable {
    public let home: [String: [String]]
    public let projects: [String: [String]]
    public let aliases: [String: [String]]
    public let historyMinUses: Int

    public static let bundled: InventoryRules = {
        guard let url = Bundle.module.url(forResource: "rules", withExtension: "json", subdirectory: "rules")
                ?? Bundle.module.url(forResource: "rules", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            return InventoryRules(home: [:], projects: [:], aliases: [:], historyMinUses: 3)
        }
        return (try? parse(data)) ?? InventoryRules(home: [:], projects: [:], aliases: [:], historyMinUses: 3)
    }()

    public static func parse(_ data: Data) throws -> InventoryRules {
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return InventoryRules(home: obj["home"] as? [String: [String]] ?? [:],
                              projects: obj["projects"] as? [String: [String]] ?? [:],
                              aliases: obj["aliases"] as? [String: [String]] ?? [:],
                              historyMinUses: obj["history_min_uses"] as? Int ?? 3)
    }

    /// Commandes d'un paquet : alias connus, sinon dernier segment du nom (« @scope/cli » → « scope »).
    public func commands(for package: String) -> [String] {
        if let a = aliases[package] { return a }
        var base = package.split(separator: "/").last.map(String.init) ?? package
        if let at = base.firstIndex(of: "@"), at != base.startIndex { base = String(base[..<at]) }
        if base == "python" { return ["python3"] }
        if base == "cli", package.hasPrefix("@"), let scope = package.split(separator: "/").first {
            return [String(scope.dropFirst())]
        }
        return [base]
    }
}

// MARK: - Lecteurs (fonctions pures, testées sur des sorties enregistrées)

public enum InventoryParsers {
    /// `brew list --versions <formules>` : « nom version [version…] ».
    public static func brewVersions(_ text: String, rules: InventoryRules) -> [CLITool] {
        text.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: " ").map(String.init)
            guard let name = parts.first else { return nil }
            return CLITool(name: name, source: .brew, version: parts.last == name ? nil : parts.last,
                           commands: rules.commands(for: name))
        }
    }

    /// `brew tap`.
    public static func brewTaps(_ text: String) -> [String] {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// `mise ls --current --json`.
    public static func mise(_ data: Data, rules: InventoryRules) -> [CLITool] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [[String: Any]]] else { return [] }
        return obj.keys.sorted().compactMap { key in
            let versions = obj[key] ?? []
            let active = versions.first { ($0["active"] as? Bool) == true } ?? versions.first
            let version = active?["version"] as? String
            // « npm:@scope/pkg », « cargo:x », « ubi:owner/repo » : la commande vient du nom du paquet.
            let pkg = key.split(separator: ":", maxSplits: 1).last.map(String.init) ?? key
            var details: [String: String] = [:]
            if let req = active?["requested_version"] as? String { details["requested"] = req }
            return CLITool(name: key, source: .mise, version: version, commands: rules.commands(for: pkg), details: details)
        }
    }

    /// `npm ls -g --depth=0 --json` (npm et corepack exclus : ils viennent avec Node).
    public static func npmGlobals(_ data: Data, rules: InventoryRules) -> [CLITool] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let deps = obj["dependencies"] as? [String: [String: Any]] else { return [] }
        return deps.keys.sorted().filter { !["npm", "corepack"].contains($0) }.map { name in
            CLITool(name: name, source: .npm, version: deps[name]?["version"] as? String, commands: rules.commands(for: name))
        }
    }

    /// Reçu `uv-receipt.toml` d'un outil uv.
    public static func uvReceipt(_ text: String) -> CLITool? {
        guard let doc = try? TOMLDocument(parsing: text), let tool = try? doc.tree().table("tool"),
              let req = tool.value("requirements")?.array?.first?.inlineTable else { return nil }
        let d = Dictionary(req, uniquingKeysWith: { a, _ in a })
        guard let name = d["name"]?.string else { return nil }
        var details: [String: String] = [:]
        if let extras = d["extras"]?.array?.compactMap(\.string), !extras.isEmpty { details["extras"] = extras.joined(separator: ",") }
        if let py = tool.value("python")?.string { details["python"] = py }
        let commands = tool.value("entrypoints")?.array?.compactMap { e in
            e.inlineTable.flatMap { Dictionary($0, uniquingKeysWith: { a, _ in a })["name"]?.string }
        } ?? [name]
        return CLITool(name: name, source: .uv, version: nil, commands: commands, details: details)
    }

    /// Version d'un outil uv lue dans son environnement : `lib/python*/site-packages/<nom>-<version>.dist-info`.
    /// Les noms sont comparés normalisés (casse, `-`, `_` et `.` équivalents) : `serena-agent` → `serena_agent-1.5.3`.
    public static func uvVersion(name: String, toolDir: URL) -> String? {
        func norm(_ s: String) -> String {
            s.lowercased().replacingOccurrences(of: #"[-_.]+"#, with: "_", options: .regularExpression)
        }
        let fm = FileManager.default
        let lib = toolDir.appendingPathComponent("lib")
        for py in ((try? fm.contentsOfDirectory(atPath: lib.path)) ?? []).sorted() where py.hasPrefix("python") {
            let site = lib.appendingPathComponent("\(py)/site-packages")
            for entry in (try? fm.contentsOfDirectory(atPath: site.path)) ?? [] where entry.hasSuffix(".dist-info") {
                let stem = String(entry.dropLast(".dist-info".count))
                // La version ne contient jamais de tiret : le dernier sépare le nom de la version.
                guard let dash = stem.lastIndex(of: "-") else { continue }
                if norm(String(stem[..<dash])) == norm(name) { return String(stem[stem.index(after: dash)...]) }
            }
        }
        return nil
    }

    /// `go version -m <binaire>` : la ligne `mod <module> <version>` donne la version (rien pour `(devel)`).
    public static func goVersion(_ text: String) -> String? {
        for line in text.split(separator: "\n") {
            let f = line.split(whereSeparator: { $0 == "\t" || $0 == " " })
            if f.count >= 3, f[0] == "mod" { return f[2] == "(devel)" ? nil : String(f[2]) }
        }
        return nil
    }

    /// Version présente dans le chemin d'un lien (`~/.local/share/claude/versions/2.1.3` → « 2.1.3 »), sinon nil.
    public static func versionInPath(_ path: String) -> String? {
        path.split(separator: "/").reversed().map(String.init).first {
            $0.range(of: #"^v?\d+(\.\d+)+([-+][0-9A-Za-z.]+)?$"#, options: .regularExpression) != nil
        }
    }

    /// `pipx list --short` : « nom version ».
    public static func pipx(_ text: String) -> [CLITool] {
        text.split(separator: "\n").compactMap { line in
            let p = line.split(separator: " ").map(String.init)
            guard let name = p.first else { return nil }
            return CLITool(name: name, source: .pipx, version: p.count > 1 ? p[1] : nil, commands: [name])
        }
    }

    /// `~/.cargo/.crates2.json`.
    public static func cargo(_ data: Data) -> [CLITool] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let installs = obj["installs"] as? [String: [String: Any]] else { return [] }
        return installs.keys.sorted().compactMap { key in
            let p = key.split(separator: " ").map(String.init)
            guard let name = p.first else { return nil }
            let bins = installs[key]?["bins"] as? [String] ?? [name]
            return CLITool(name: name, source: .cargo, version: p.count > 1 ? p[1] : nil, commands: bins)
        }
    }

    /// Exécutables de `~/.local/bin` : les liens vers un environnement uv ou pipx sont rattachés à leur source.
    public static func localBin(entries: [(name: String, linkTarget: String?)]) -> [CLITool] {
        let names = Set(entries.map(\.name))
        return entries.compactMap { e in
            if let t = e.linkTarget {
                if t.contains("/uv/tools/") || t.contains("/pipx/venvs/") { return nil }
                // Alias vers un autre exécutable du même dossier (cr → coderabbit).
                if t.contains("/.local/bin/"), names.contains((t as NSString).lastPathComponent) { return nil }
            }
            var details: [String: String] = [:]
            if let t = e.linkTarget { details["link"] = t }
            // Pas d'exécution de `--version` sur un binaire inconnu : seule la cible du lien peut donner la version.
            return CLITool(name: e.name, source: .localBin, version: e.linkTarget.flatMap(versionInPath),
                           commands: [e.name], details: details)
        }
    }

    /// Nombre d'utilisations de chaque commande dans un historique zsh (format étendu) ou bash.
    public static func history(_ text: String) -> [String: Int] {
        var counts: [String: Int] = [:]
        for raw in text.split(separator: "\n") {
            var line = Substring(raw)
            if line.hasPrefix(": "), let semi = line.firstIndex(of: ";") { line = line[line.index(after: semi)...] }
            var words = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            if let f = words.first, ["sudo", "rtk", "time", "exec", "nohup"].contains(String(f)) { words.removeFirst() }
            guard let cmd = words.first.map(String.init),
                  cmd.range(of: #"^[A-Za-z][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil else { continue }
            counts[cmd, default: 0] += 1
        }
        return counts
    }
}

// MARK: - Collecte

/// Lance une commande ; injectable pour les tests.
public protocol CommandRunner: Sendable {
    func run(_ command: [String]) -> (status: Int32, output: Data)
}

public struct SystemRunner: CommandRunner {
    public init() {}

    /// PATH élargi (Homebrew, mise, ~/.local/bin) pour une app lancée depuis le Finder.
    public static var path: String {
        let home = NSHomeDirectory()
        return ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/share/mise/shims",
                "\(home)/.cargo/bin", "\(home)/go/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
    }

    public func run(_ command: [String]) -> (status: Int32, output: Data) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = command
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Self.path
        env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return (127, Data()) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, data)
    }
}

public enum InventoryCollector {
    /// Outils installés, toutes sources confondues.
    public static func installed(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                                 runner: CommandRunner = SystemRunner(), rules: InventoryRules = .bundled) -> (tools: [CLITool], taps: [String]) {
        var tools: [CLITool] = []
        var taps: [String] = []
        // Seules les formules installées à la demande : pas les dépendances devenues orphelines.
        let leaves = runner.run(["brew", "leaves", "--installed-on-request"])
        if leaves.status == 0 {
            let names = String(decoding: leaves.output, as: UTF8.self).split(separator: "\n").map(String.init)
            if !names.isEmpty {
                let v = runner.run(["brew", "list", "--versions"] + names)
                tools += InventoryParsers.brewVersions(String(decoding: v.output, as: UTF8.self), rules: rules)
            }
            taps = InventoryParsers.brewTaps(String(decoding: runner.run(["brew", "tap"]).output, as: UTF8.self))
        }
        let mise = runner.run(["mise", "ls", "--current", "--json"])
        if mise.status == 0 { tools += InventoryParsers.mise(mise.output, rules: rules) }
        let npm = runner.run(["mise", "exec", "--", "npm", "ls", "-g", "--depth=0", "--json"])
        if npm.status == 0 { tools += InventoryParsers.npmGlobals(npm.output, rules: rules) }

        let fm = FileManager.default
        let uvDir = home.appendingPathComponent(".local/share/uv/tools")
        for d in ((try? fm.contentsOfDirectory(atPath: uvDir.path)) ?? []).sorted() {
            let toolDir = uvDir.appendingPathComponent(d)
            if let text = try? String(contentsOf: toolDir.appendingPathComponent("uv-receipt.toml"), encoding: .utf8),
               let t = InventoryParsers.uvReceipt(text) {
                tools.append(CLITool(name: t.name, source: t.source, version: InventoryParsers.uvVersion(name: t.name, toolDir: toolDir),
                                     commands: t.commands, details: t.details))
            }
        }
        let pipx = runner.run(["pipx", "list", "--short"])
        if pipx.status == 0 { tools += InventoryParsers.pipx(String(decoding: pipx.output, as: UTF8.self)) }
        if let data = try? Data(contentsOf: home.appendingPathComponent(".cargo/.crates2.json")) { tools += InventoryParsers.cargo(data) }
        let goBin = home.appendingPathComponent("go/bin")
        for name in ((try? fm.contentsOfDirectory(atPath: goBin.path)) ?? []).sorted() where !name.hasPrefix(".") {
            // `go version -m` lit les informations de build sans lancer le binaire (nil si go est absent).
            let info = runner.run(["go", "version", "-m", goBin.appendingPathComponent(name).path])
            let version = info.status == 0 ? InventoryParsers.goVersion(String(decoding: info.output, as: UTF8.self)) : nil
            tools.append(CLITool(name: name, source: .go, version: version, commands: [name]))
        }
        let localDir = home.appendingPathComponent(".local/bin")
        let local = ((try? fm.contentsOfDirectory(atPath: localDir.path)) ?? []).sorted().compactMap { name -> (String, String?)? in
            let path = localDir.appendingPathComponent(name).path
            var isDir: ObjCBool = false
            guard !name.hasPrefix("."), fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue,
                  fm.isExecutableFile(atPath: path) else { return nil }
            return (name, try? fm.destinationOfSymbolicLink(atPath: path))
        }
        tools += InventoryParsers.localBin(entries: local.map { (name: $0.0, linkTarget: $0.1) })
        return (tools, taps)
    }

    /// Fichiers de projet présents dans les dossiers suivis (profondeur limitée, dossiers régénérables ignorés).
    public static func projectMarkers(in folders: [String], names: Set<String>, maxDepth: Int = 5) -> [String: String] {
        var found: [String: String] = [:]
        let skip: Set<String> = ["node_modules", ".git", ".pnpm-store", "vendor", "Pods", "DerivedData", ".venv", "dist", "build",
                                 ".Trashes", ".Spotlight-V100", ".fseventsd"]
        let fm = FileManager.default
        func walk(_ dir: String, depth: Int) {
            guard depth <= maxDepth, found.count < names.count,
                  let items = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for item in items {
                if names.contains(item), found[item] == nil { found[item] = dir + "/" + item }
            }
            for item in items where !skip.contains(item) && !item.hasPrefix(".") {
                var isDir: ObjCBool = false
                let p = dir + "/" + item
                if fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue {
                    if (try? fm.destinationOfSymbolicLink(atPath: p)) != nil { continue }
                    walk(p, depth: depth + 1)
                }
            }
        }
        for f in folders { walk((f as NSString).expandingTildeInPath, depth: 0) }
        return found
    }

    /// Une commande est-elle disponible dans le PATH élargi ?
    public static func isAvailable(_ command: String) -> Bool {
        SystemRunner.path.split(separator: ":").contains { FileManager.default.isExecutableFile(atPath: "\($0)/\(command)") }
    }

    /// Statuts : utilisé (configuration du home, projet, historique), non utilisé, requis manquant.
    public static func classify(tools: [CLITool], taps: [String], homeMarkers: Set<String>, projectMarkers: Set<String>,
                                history: [String: Int], excluded: Set<String>, rules: InventoryRules = .bundled,
                                available: (String) -> Bool = isAvailable) -> Inventory {
        var reasonsByCommand: [String: [InventoryReason]] = [:]
        for (marker, cmds) in rules.home where homeMarkers.contains(marker) {
            for c in cmds { reasonsByCommand[c, default: []].append(.home(marker)) }
        }
        for (marker, cmds) in rules.projects where projectMarkers.contains(marker) {
            for c in cmds { reasonsByCommand[c, default: []].append(.project(marker)) }
        }
        var entries: [InventoryEntry] = []
        var provided = Set<String>()
        for t in tools {
            var reasons: [InventoryReason] = []
            var uses = 0
            for c in t.commands {
                provided.insert(c)
                for r in reasonsByCommand[c] ?? [] where !reasons.contains(r) { reasons.append(r) }
                uses += history[c] ?? 0
            }
            // Une seule raison « historique » par outil, toutes commandes confondues.
            if uses >= rules.historyMinUses { reasons.append(.history(uses: uses)) }
            entries.append(InventoryEntry(name: t.name, tool: t, status: reasons.isEmpty ? .unused : .used, reasons: reasons,
                                          excluded: excluded.contains(t.name)))
        }
        for (cmd, reasons) in reasonsByCommand.sorted(by: { $0.key < $1.key })
        where !provided.contains(cmd) && !available(cmd) {
            entries.append(InventoryEntry(name: cmd, tool: nil, status: .missing, reasons: reasons, excluded: false))
        }
        let order: [InventoryEntry.Status: Int] = [.missing: 0, .used: 1, .unused: 2]
        entries.sort { (order[$0.status]!, $0.tool?.source.rawValue ?? "", $0.name) < (order[$1.status]!, $1.tool?.source.rawValue ?? "", $1.name) }
        return Inventory(entries: entries, taps: taps)
    }

    /// Inventaire complet de la machine.
    public static func collect(config: CairnConfig, home: URL = FileManager.default.homeDirectoryForCurrentUser,
                               runner: CommandRunner = SystemRunner(), rules: InventoryRules = .bundled) -> Inventory {
        let (tools, taps) = installed(home: home, runner: runner, rules: rules)
        let homeMarkers = Set(rules.home.keys.filter { FileManager.default.fileExists(atPath: home.appendingPathComponent($0).path) })
        let projects = Set(projectMarkers(in: config.folders.map(\.expandedPath), names: Set(rules.projects.keys)).keys)
        var history: [String: Int] = [:]
        for f in [".zsh_history", ".bash_history"] {
            if let data = try? Data(contentsOf: home.appendingPathComponent(f)) {
                // L'historique zsh n'est pas toujours de l'UTF-8 valide.
                let text = String(decoding: data, as: UTF8.self)
                history.merge(InventoryParsers.history(text), uniquingKeysWith: +)
            }
        }
        return classify(tools: tools, taps: taps, homeMarkers: homeMarkers, projectMarkers: projects, history: history,
                        excluded: Set(config.excludedTools), rules: rules)
    }
}

// MARK: - Export

public enum InventoryExport {
    /// `tools.toml` : outils retenus regroupés par source, avec leurs paramètres d'installation.
    public static func toolsTOML(_ inv: Inventory) -> String {
        var doc = try! TOMLDocument(parsing: "# Outils CLI exportés par Cairn — relus par `cairn restore` pour la réinstallation.\n\n")
        doc.set(.integer(1), key: ["version"])
        doc.set(.array(inv.taps.map { .string($0) }), key: ["taps"])
        for t in inv.retained.sorted(by: { ($0.source.rawValue, $0.name) < ($1.source.rawValue, $1.name) }) {
            var values: [(String, TOMLValue)] = [("name", .string(t.name))]
            if let v = t.version { values.append(("version", .string(v))) }
            for (k, v) in t.details.sorted(by: { $0.key < $1.key }) { values.append((k, .string(v))) }
            values.append(("commands", .array(t.commands.map { .string($0) })))
            doc.appendArrayTable([t.source.rawValue], values: values)
        }
        return doc.render()
    }

    /// Brewfile compatible `brew bundle` : taps et formules seulement (jamais de cask ni de mas).
    public static func brewfile(_ inv: Inventory) -> String {
        var lines = inv.taps.map { "tap \"\($0)\"" }
        lines += inv.retained.filter { $0.source == .brew }.map { "brew \"\($0.name)\"" }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Sortie de `cairn tools --json` : identifiants et codes stables, identique quelle que soit la langue.
    public static func json(_ inv: Inventory) -> String {
        let list: [[String: Any]] = inv.entries.map { e in
            var d: [String: Any] = ["name": e.name, "status": e.status.rawValue, "reasons": e.reasons.map(\.json), "excluded": e.excluded]
            if let t = e.tool {
                d["source"] = t.source.rawValue
                d["version"] = t.version ?? NSNull()
                d["commands"] = t.commands
                d["details"] = t.details
            }
            return d
        }
        let obj: [String: Any] = ["tools": list, "taps": inv.taps]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    public static func write(_ inv: Inventory, to dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try toolsTOML(inv).write(to: dir.appendingPathComponent("tools.toml"), atomically: true, encoding: .utf8)
        try brewfile(inv).write(to: dir.appendingPathComponent("Brewfile"), atomically: true, encoding: .utf8)
    }
}
