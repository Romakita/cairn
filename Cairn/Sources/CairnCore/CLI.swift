import Foundation

/// Mode ligne de commande du binaire Cairn.
public enum CLI {
    /// Codes de sortie : 0 succès, 1 échec, 2 erreur d'usage ou de configuration.
    public enum Exit: Int32 { case ok = 0, failure = 1, usage = 2 }

    static let commands: Set<String> = ["analyze", "config", "help"]

    /// Indique si les arguments demandent le mode ligne de commande (et pas l'interface).
    public static func isCommandLine(_ args: [String]) -> Bool {
        let a = args.dropFirst().filter { !$0.hasPrefix("-psn_") && !$0.hasPrefix("-NS") && !$0.hasPrefix("-Apple") }
        guard let first = a.first else { return false }
        return commands.contains(first) || ["-h", "--help", "--report", "--lang", "--config"].contains(first)
    }

    /// Exécute la commande et renvoie le code de sortie.
    public static func run(_ arguments: [String], out: (String) -> Void = { print($0) },
                           err: (String) -> Void = { FileHandle.standardError.write(($0 + "\n").data(using: .utf8)!) }) -> Exit {
        var args = Array(arguments.dropFirst())

        // Options globales : --config et --lang (qui prime sur la langue de config.toml pour cette exécution).
        var configPath: String?
        if let i = args.firstIndex(of: "--config") {
            guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", "--config")); return .usage }
            configPath = (args[i + 1] as NSString).expandingTildeInPath
            args.removeSubrange(i...(i + 1))
        }
        let store = ConfigStore(fileURL: configPath.map { URL(fileURLWithPath: $0) })
        var lang: String?
        if let i = args.firstIndex(of: "--lang") {
            guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", "--lang")); return .usage }
            lang = args[i + 1]
            args.removeSubrange(i...(i + 1))
            guard AppLanguage.parse(lang) != nil || lang == "auto" else {
                L10n.configure(explicit: nil)
                err(L10n.tr("cli.invalid_lang", lang!)); return .usage
            }
        } else {
            lang = configuredLanguage(store)
        }
        L10n.configure(explicit: lang)

        guard let command = args.first else { out(L10n.tr("cli.help")); return .ok }
        let rest = Array(args.dropFirst())
        switch command {
        case "help", "-h", "--help":
            out(L10n.tr("cli.help")); return .ok
        case "analyze", "--report":
            return analyze(rest, out: out, err: err)
        case "config":
            return config(rest, store: store, out: out, err: err)
        default:
            err(L10n.tr("cli.unknown_command", command))
            err(L10n.tr("cli.help"))
            return .usage
        }
    }

    /// Langue de config.toml, lue sans migration ni écriture.
    static func configuredLanguage(_ store: ConfigStore) -> String? {
        guard let text = try? String(contentsOf: store.fileURL, encoding: .utf8),
              let doc = try? TOMLDocument(parsing: text) else { return nil }
        return try? doc.tree().value("language")?.string
    }

    static func config(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        guard let sub = args.first, !["-h", "--help"].contains(sub) else { out(L10n.tr("cli.config.help")); return .ok }
        switch sub {
        case "path":
            out(store.fileURL.path)
            return .ok
        case "show":
            var config = CairnConfig()
            if store.exists {
                do {
                    let loaded = try store.load()
                    config = loaded.config
                    loaded.issues.forEach { err($0.description) }
                } catch {
                    err(String(describing: error)); return .usage
                }
            } else {
                err(L10n.tr("cli.config.defaults"))
            }
            out(ConfigWriter.newDocument(config).render())
            return .ok
        case "validate":
            guard store.exists else { err(L10n.tr("cli.config.missing", store.fileURL.path)); return .usage }
            do {
                let loaded = try store.load()
                if loaded.migrated { err(L10n.tr("cli.config.migrated", store.fileURL.appendingPathExtension("bak").path)) }
                loaded.issues.forEach { err($0.description) }
                if loaded.hasErrors { return .usage }
                out(L10n.tr("cli.config.valid", store.fileURL.path))
                return .ok
            } catch {
                err(String(describing: error)); return .usage
            }
        default:
            err(L10n.tr("cli.unknown_command", "config " + sub))
            err(L10n.tr("cli.config.help"))
            return .usage
        }
    }

    static func analyze(_ args: [String], out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.analyze.help")); return .ok }
        var json = false
        var folders: [String] = []
        for a in args {
            if a == "--json" { json = true }
            else if a.hasPrefix("-") { err(L10n.tr("cli.unknown_option", a)); return .usage }
            else { folders.append((a as NSString).expandingTildeInPath) }
        }
        if folders.isEmpty { folders = ["/Volumes/workspaces"] }
        for f in folders where !FileManager.default.fileExists(atPath: f) {
            err(L10n.tr("cli.missing_folder", f)); return .failure
        }

        var reports: [[String: Any]] = []
        for folder in folders {
            let r = Scanner.scan(root: folder, ctx: ScanContext())
            if json {
                var breakdown: [String: Int64] = [:]
                for c in Category.allCases { breakdown[c.key] = r.root.bytes(c) }
                reports.append([
                    "path": folder, "size": r.root.size, "files": r.root.fileCount,
                    "regenerable": r.root.regenerableBytes, "breakdown": breakdown,
                    "errors": r.errors, "duration_seconds": r.duration,
                ])
            } else {
                out(L10n.tr("cli.report.summary", folder, Fmt.bytes(r.root.size), Fmt.count(r.root.fileCount),
                            Fmt.duration(r.duration), r.errors))
                for c in Category.allCases where r.root.bytes(c) > 0 {
                    out("  " + c.label.padding(toLength: 34, withPad: " ", startingAt: 0) + " " + Fmt.bytes(r.root.bytes(c)))
                }
                out(L10n.tr("cli.report.folders"))
                for n in r.root.children.prefix(20) {
                    out("  " + n.name.padding(toLength: 22, withPad: " ", startingAt: 0) + " "
                        + Fmt.bytes(n.size).padding(toLength: 10, withPad: " ", startingAt: 0) + " "
                        + L10n.tr("cli.report.of_regenerable", Fmt.bytes(n.regenerableBytes)))
                }
            }
        }
        if json {
            let total = reports.reduce(Int64(0)) { $0 + (($1["size"] as? Int64) ?? 0) }
            let obj: [String: Any] = ["folders": reports, "total": total]
            if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
               let s = String(data: data, encoding: .utf8) { out(s) }
        }
        return .ok
    }
}
