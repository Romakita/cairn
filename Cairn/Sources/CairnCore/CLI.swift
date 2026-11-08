import Foundation

/// Mode ligne de commande du binaire Cairn.
public enum CLI {
    /// Codes de sortie : 0 succès, 1 échec, 2 erreur d'usage ou de configuration.
    public enum Exit: Int32 { case ok = 0, failure = 1, usage = 2 }

    static let commands: Set<String> = ["analyze", "config", "tools", "ai", "git", "git-worker", "backup", "verify", "restore", "help"]

    /// Indique si les arguments demandent le mode ligne de commande (et pas l'interface).
    public static func isCommandLine(_ args: [String]) -> Bool {
        let a = args.dropFirst().filter { !$0.hasPrefix("-psn_") && !$0.hasPrefix("-NS") && !$0.hasPrefix("-Apple") }
        guard let first = a.first else { return false }
        return commands.contains(first) || ["-h", "--help", "--lang", "--config"].contains(first)
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
        // Avec --config, l'état, les journaux et le verrou vivent à côté de ce fichier.
        let store = configPath.map { p -> ConfigStore in
            let url = URL(fileURLWithPath: p)
            return ConfigStore(paths: CairnPaths(root: url.deletingLastPathComponent()), fileURL: url)
        } ?? ConfigStore()
        // `~/.cairn` en 700 avant toute écriture (journaux, état, verrou). Le dossier d'un --config n'est pas modifié.
        if configPath == nil { try? store.paths.ensure() }
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
        // Worker interne du pool git (non documenté).
        if command == "git-worker", args.count >= 3 {
            return Exit(rawValue: GitMaintenance.workerMain(repo: args[1], optionsJSON: args[2])) ?? .failure
        }
        let rest = Array(args.dropFirst())
        switch command {
        case "help", "-h", "--help":
            out(L10n.tr("cli.help")); return .ok
        case "analyze":
            return analyze(rest, store: store, out: out, err: err)
        case "config":
            return config(rest, store: store, out: out, err: err)
        case "tools":
            return tools(rest, store: store, out: out, err: err)
        case "git":
            return gitCommand(rest, store: store, out: out, err: err)
        case "ai":
            return ai(rest, store: store, out: out, err: err)
        case "restore":
            return restore(rest, store: store, out: out, err: err)
        case "backup":
            return backup(rest, store: store, out: out, err: err)
        case "verify":
            return verify(rest, store: store, out: out, err: err)
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

    /// Configuration courante, lue sans migration ni écriture (valeurs par défaut sinon).
    static func readConfig(_ store: ConfigStore) -> CairnConfig {
        guard store.exists, let text = try? String(contentsOf: store.fileURL, encoding: .utf8),
              let doc = try? TOMLDocument(parsing: text), let (c, _) = try? ConfigDecoder.decode(doc) else { return CairnConfig() }
        return c
    }

    static func tools(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.tools.help")); return .ok }
        var json = false
        var exportDir: String?
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--json": json = true
            case "--export":
                guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", "--export")); return .usage }
                exportDir = (args[i + 1] as NSString).expandingTildeInPath
                i += 1
            default: err(L10n.tr("cli.unknown_option", args[i])); return .usage
            }
            i += 1
        }
        let inv = InventoryCollector.collect(config: readConfig(store))
        if let exportDir {
            do { try InventoryExport.write(inv, to: URL(fileURLWithPath: exportDir)) } catch {
                err(String(describing: error)); return .failure
            }
            err(L10n.tr("cli.tools.exported", inv.retained.count, exportDir))
        }
        if json {
            // Codes stables (`{"code":"history","uses":5}`) : la langue ne change que la sortie texte.
            out(InventoryExport.json(inv))
        } else if exportDir == nil {
            for status in [InventoryEntry.Status.missing, .used, .unused] {
                let group = inv.entries.filter { $0.status == status }
                guard !group.isEmpty else { continue }
                out(L10n.tr("inventory.status.\(status.rawValue)") + " (\(group.count))")
                for e in group {
                    let src = e.tool?.source.rawValue ?? "—"
                    let ver = e.tool?.version ?? ""
                    let mark = e.excluded ? " ✗" : ""
                    out("  " + e.name.padding(toLength: 28, withPad: " ", startingAt: 0) + " "
                        + src.padding(toLength: 10, withPad: " ", startingAt: 0) + " "
                        + ver.padding(toLength: 12, withPad: " ", startingAt: 0) + " " + e.reasonTexts.joined(separator: ", ") + mark)
                }
            }
        }
        return .ok
    }

    /// Confirmation interactive (sautée avec --yes).
    /// Mot de passe lu sans écho sur le terminal (nil si annulé). Remplaçable dans les tests.
    nonisolated(unsafe) static var askPassword: (String) -> String? = { prompt in
        var buf = [CChar](repeating: 0, count: 512)
        guard let r = readpassphrase(prompt + " ", &buf, buf.count, 0) else { return nil }
        let pw = String(cString: r)
        return pw.isEmpty ? nil : pw
    }

    nonisolated(unsafe) static var confirm: (String) -> Bool = { question in
        FileHandle.standardError.write(Data((question + " [o/N] ").utf8))
        guard let answer = readLine()?.lowercased() else { return false }
        return ["o", "oui", "y", "yes"].contains(answer)
    }

    static func gitCommand(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.git.help")); return .ok }
        let config = readConfig(store)
        var o = GitOptions()
        o.gc = config.git.gc
        o.fetch = config.git.fetchBefore
        o.staleDays = config.git.worktreeStaleDays
        var apply = false, yes = false, json = false
        var roots: [String] = []
        var reportPath: String?
        var i = 0
        func value(_ name: String) -> String? {
            guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", name)); return nil }
            i += 1
            return args[i]
        }
        while i < args.count {
            switch args[i] {
            case "--apply": apply = true
            case "--yes", "-y": yes = true
            case "--json": json = true
            case "--fetch": o.fetch = true
            case "--include-unmerged": o.includeUnmerged = true
            case "--prune-now": o.pruneNow = true
            case "--no-gc": o.gc = false
            case "--worktrees-only": o.worktreesOnly = true
            case "--include-at-risk": o.includeAtRisk = true
            case "--only": guard let v = value("--only") else { return .usage }; o.only = v
            case "--root": guard let v = value("--root") else { return .usage }; roots.append((v as NSString).expandingTildeInPath)
            case "--report": guard let v = value("--report") else { return .usage }; reportPath = (v as NSString).expandingTildeInPath
            case "--stale-days":
                guard let v = value("--stale-days"), let n = Int(v), n > 0 else { err(L10n.tr("cli.missing_value", "--stale-days")); return .usage }
                o.staleDays = n
            default: err(L10n.tr("cli.unknown_option", args[i])); return .usage
            }
            i += 1
        }
        if roots.isEmpty { roots = config.folders.map(\.expandedPath) }
        if roots.isEmpty { roots = ["/Volumes/workspaces"] }

        let showProgress = !json && isatty(STDERR_FILENO) != 0
        let reports = GitMaintenance.analyzeAll(folders: roots, options: o) { p in
            if showProgress, p.total > 0 {
                FileHandle.standardError.write(Data((L10n.tr("git.worker.progress", p.done, p.total, p.running.count,
                                                             Fmt.bytes(p.running.values.max() ?? 0)) + "\r").utf8))
            }
        }
        if showProgress { FileHandle.standardError.write(Data("\n".utf8)) }
        let root = roots.count == 1 ? roots[0] : ""
        func rel(_ p: String) -> String { !root.isEmpty && p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p }

        // Sélection : branches et worktrees proposés par défaut.
        let plan: [(RepoReport, [GoneBranch], [WorktreeInfo])] = reports.map { r in
            let wts = r.worktrees.filter { GitMaintenance.selectedByDefault($0, options: o) }
            let removedBranches = Set(wts.compactMap(\.branch))
            let branches = o.worktreesOnly ? [] : r.branches.filter {
                GitMaintenance.selectedByDefault($0, options: o)
                    || ($0.checkedOutInWorktree != nil && removedBranches.contains($0.name) && $0.status != .unmerged)
            }
            return (r, branches, wts)
        }

        if let reportPath {
            do { try GitMaintenance.tsv(reports, root: root).write(toFile: reportPath, atomically: true, encoding: .utf8) }
            catch { err(String(describing: error)); return .failure }
        }

        if json {
            let obj: [String: Any] = ["repos": plan.map { (r, branches, wts) -> [String: Any] in
                [
                    "path": r.path, "git_bytes": r.gitBytes, "loose_bytes": r.looseBytes, "main": r.mainRef ?? NSNull(),
                    "reclaimable_bytes": r.reclaimableBytes,
                    "branches": r.branches.map { b in ["name": b.name, "status": b.status.rawValue, "sha": b.sha, "date": b.date,
                                                       "subject": b.subject, "selected": branches.contains(b),
                                                       "worktree": b.checkedOutInWorktree ?? NSNull()] as [String: Any] },
                    "worktrees": r.worktrees.map { w in ["path": w.path, "branch": w.branch ?? NSNull(), "status": w.status.rawValue,
                                                         "stale_reason": w.staleReason?.rawValue ?? NSNull(), "size": w.size,
                                                         "modified": w.modifiedFiles, "untracked": w.untrackedFiles,
                                                         "unpushed": w.unpushedCommits, "selected": wts.contains(w)] as [String: Any] },
                ]
            }]
            if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
               let s = String(data: data, encoding: .utf8) { out(s) }
        } else {
            out(L10n.tr(apply ? "cli.git.mode_apply" : "cli.git.mode_simulation", roots.joined(separator: ", ")))
            for (r, branches, wts) in plan where !r.branches.isEmpty || !r.worktrees.isEmpty || r.looseBytes > 50_000_000 {
                out(L10n.tr("cli.git.repo_line", rel(r.path), Fmt.bytes(r.gitBytes), Fmt.bytes(r.looseBytes), branches.count,
                            Fmt.bytes(r.reclaimableBytes), r.branches.count - branches.count))
                for w in r.worktrees {
                    out("    " + L10n.tr("cli.git.worktree_line", rel(w.path), w.branch ?? "-", L10n.tr("worktree.status.\(w.status.rawValue)"),
                                     Fmt.bytes(w.size)) + (wts.contains(w) ? " ✓" : ""))
                }
            }
            let totalGit = reports.reduce(Int64(0)) { $0 + $1.gitBytes }
            out(L10n.tr("cli.git.summary", reports.count, Fmt.bytes(totalGit), plan.reduce(0) { $0 + $1.1.count },
                        plan.reduce(0) { $0 + $1.2.count }, Fmt.bytes(plan.reduce(Int64(0)) { $0 + $1.0.reclaimableBytes })))
            if !apply { out(L10n.tr("cli.git.simulation_note")) }
        }

        guard apply else { return .ok }
        let nb = plan.reduce(0) { $0 + $1.1.count }, nw = plan.reduce(0) { $0 + $1.2.count }
        guard nb + nw > 0 else { return .ok }
        if !yes && !confirm(L10n.tr("cli.git.confirm", nb, nw, o.pruneNow ? L10n.tr("cli.git.prune_warning") : "")) {
            err(L10n.tr("cli.cancelled")); return .failure
        }
        var failures = 0
        for (r, branches, wts) in plan where !branches.isEmpty || !wts.isEmpty || o.gc {
            let res = GitMaintenance.apply(repo: r.path, branches: branches.map(\.name), worktrees: wts, options: o)
            failures += res.failures.count
            res.failures.forEach { err(L10n.tr("cli.git.failed", $0)) }
        }
        return failures == 0 ? .ok : .failure
    }

    /// Parties IA fournies par la capacité ai-tools (branchées au démarrage).
    nonisolated(unsafe) public static var aiParts: ((CairnConfig, URL) throws -> [BackupPart])? = { c, staging in
        try AIBackup.parts(config: c, staging: staging)
    }

    static func ai(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.ai.help")); return .ok }
        let json = args.contains("--json")
        let config = readConfig(store)
        let stats = AIProfiles.bundled.map { AIBackup.stats($0) }
        if json {
            let list: [[String: Any]] = stats.map { s in
                ["id": s.profile.id, "detected": s.detected, "bytes_by_category": s.bytesByCategory, "not_copied_bytes": s.notCopiedBytes,
                 "total_bytes": s.totalBytes, "conversations": s.conversations,
                 "latest_conversation": s.latestConversation.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(),
                 "selected_categories": config.ai.first { $0.id == s.profile.id }?.categories ?? [],
                 "credentials_in_keychain": s.profile.credentialsInKeychain]
            }
            if let data = try? JSONSerialization.data(withJSONObject: ["tools": list], options: [.prettyPrinted, .sortedKeys]),
               let t = String(data: data, encoding: .utf8) { out(t) }
            return .ok
        }
        for s in stats {
            let selected = config.ai.first { $0.id == s.profile.id }?.categories ?? []
            out(L10n.tr("ai.\(s.profile.id)") + " — " + (s.detected ? Fmt.bytes(s.totalBytes) : L10n.tr("onboarding.ai.not_detected")))
            guard s.detected else { continue }
            for cat in CairnConfig.AITool.categories where !(s.profile.categories[cat] ?? []).isEmpty {
                out("  " + (selected.contains(cat) ? "✓ " : "  ") + L10n.tr("ai.category.\(cat)").padding(toLength: 18, withPad: " ", startingAt: 0)
                    + Fmt.bytes(s.bytesByCategory[cat] ?? 0))
            }
            if s.conversations > 0 {
                out("  " + L10n.tr("cli.ai.conversations", s.conversations, s.latestConversation.map(Fmt.date) ?? "—"))
            }
            if s.notCopiedBytes > 0 { out("  " + L10n.tr("cli.ai.not_copied", Fmt.bytes(s.notCopiedBytes))) }
            if s.profile.credentialsInKeychain { out("  " + L10n.tr("cli.ai.keychain")) }
        }
        return .ok
    }

    static func restore(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.restore.help")); return .ok }
        var from: String?, destID: String?, version: String?
        var parts: Set<String>?
        var targets: [String: String] = [:]
        var apply = false, yes = false, check = false, replaceDB = false
        var i = 0
        func value() -> String? { i += 1; return i < args.count ? args[i] : nil }
        while i < args.count {
            switch args[i] {
            case "--from": guard let v = value() else { return .usage }; from = (v as NSString).expandingTildeInPath
            case "--destination": guard let v = value() else { return .usage }; destID = v
            case "--version": guard let v = value() else { return .usage }; version = v
            case "--parts": guard let v = value() else { return .usage }; parts = Set(v.split(separator: ",").map(String.init))
            case "--target":
                guard let v = value(), let eq = v.firstIndex(of: "=") else { return .usage }
                targets[String(v[..<eq])] = (String(v[v.index(after: eq)...]) as NSString).expandingTildeInPath
            case "--replace-databases": replaceDB = true
            case "--apply": apply = true
            case "--yes", "-y": yes = true
            case "--check": check = true
            default: err(L10n.tr("cli.unknown_option", args[i])); return .usage
            }
            i += 1
        }
        // Source : dossier donné, ou version d'une destination configurée.
        var session: DestinationSession?
        defer { session?.close() }
        var sourceURL: URL
        if let from {
            sourceURL = URL(fileURLWithPath: from)
        } else {
            let config = readConfig(store)
            guard let d = config.destinations.first(where: { destID == nil || $0.id == destID }) else {
                err(L10n.tr("cli.backup.no_destination")); return .usage
            }
            let s = DestinationSession(d)
            session = s
            do {
                // Mac neuf : le Trousseau est vide, les mots de passe sont demandés.
                var root: URL?
                while root == nil {
                    do {
                        root = try s.open(createIfMissing: false)
                    } catch ProviderError.missingPassword where s.sharePassword == nil {
                        guard let pw = askPassword(L10n.tr("cli.restore.share_password", d.url ?? d.id)) else { return .failure }
                        s.sharePassword = pw
                    } catch ProviderError.missingImagePassword where s.imagePassword == nil {
                        s.close()
                        guard let pw = askPassword(L10n.tr("cli.restore.image_password")) else { return .failure }
                        s.imagePassword = pw
                    }
                }
                let all = RestoreSource.versions(onDestinationRoot: root!)
                guard let pick = version.flatMap({ v in all.first { $0.version == v }?.url }) ?? RestoreSource.defaultVersion(all) else {
                    err(L10n.tr("cli.restore.no_version")); return .failure
                }
                sourceURL = pick
            } catch { err(String(describing: error)); return .failure }
        }
        guard let source = RestoreSource.open(sourceURL) else { err(L10n.tr("cli.restore.unknown_format", sourceURL.path)); return .failure }
        let service = RestoreService(source: source)
        out(L10n.tr("cli.restore.source", source.kind == .legacy ? L10n.tr("cli.restore.legacy") : "Cairn",
                    source.date.map(Fmt.date) ?? "—", source.machine, source.arch))
        if !source.archMatches { err(L10n.tr("cli.restore.arch_warning", source.arch, BackupEngine.arch())) }

        if check {
            let (present, missing) = service.check()
            out(L10n.tr("cli.restore.check", present.count, missing.count))
            missing.forEach { out("  ✗ " + $0) }
            out(L10n.tr("cli.restore.manual"))
            return .ok
        }

        var plan = RestoreService.Plan()
        let want = { (p: String) in parts?.contains(p) ?? true }
        plan.tools = want("tools")
        plan.home = want("home") && source.home != nil
        plan.ai = want("ai") ? source.aiTools : []
        plan.replaceDatabases = replaceDB
        if want("folders") {
            for f in source.folders { plan.folders[f.name] = targets[f.name] ?? f.originalPath }
        }
        for (name, target) in plan.folders {
            if RestoreService.targetIsMissing(target) {
                err(L10n.tr("cli.restore.missing_target", name, target))
            }
        }
        for (part, bytes) in service.sizes(plan).sorted(by: { $0.key < $1.key }) {
            out("  " + part.padding(toLength: 28, withPad: " ", startingAt: 0) + " " + Fmt.bytes(bytes))
        }
        if apply && !yes && !confirm(L10n.tr("cli.restore.confirm")) { err(L10n.tr("cli.cancelled")); return .failure }
        let lock = OperationLock(url: store.paths.operationLock)
        if apply {
            do { try lock.acquire(operation: "restore") } catch { err(L10n.tr("cli.busy")); return .failure }
        }
        defer { lock.release() }
        let results = service.run(plan, apply: apply, waitForAdmin: { cmd in
            err(L10n.tr("cli.restore.terminal"))
            RestoreService.openInTerminal(cmd)
            return RestoreService.waitAfterAdmin(cmd)
        }, waitForQuit: { tool in
            err(L10n.tr("restore.quit_tool", L10n.tr("ai.\(tool.id)")))
            return RestoreService.waitUntilQuit(tool)
        })
        for r in results { (r.ok ? out : err)("  " + (r.ok ? "✓ " : "✗ ") + r.step + (r.detail.isEmpty ? "" : " — " + r.detail)) }
        if !apply { out(L10n.tr("cli.restore.simulation")) } else { out(L10n.tr("cli.restore.manual")) }
        return results.allSatisfy(\.ok) ? .ok : .failure
    }

    static func backup(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.backup.help")); return .ok }
        var req = BackupService.Request()
        var json = false
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--dry-run": req.dryRun = true
            case "--json": json = true
            case "--destination":
                guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", "--destination")); return .usage }
                i += 1; req.destinationIDs = (req.destinationIDs ?? []) + [args[i]]
            case "--only":
                guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", "--only")); return .usage }
                i += 1
                let map: [String: BackupPart.Kind] = ["folders": .folder, "home": .home, "tools": .tools, "ai": .ai]
                guard let k = map[args[i]] else { err(L10n.tr("cli.unknown_option", args[i])); return .usage }
                req.only = (req.only ?? []).union([k])
            case "--tool":
                guard i + 1 < args.count else { err(L10n.tr("cli.missing_value", "--tool")); return .usage }
                i += 1; req.aiTools = (req.aiTools ?? []) + [args[i]]
            default: err(L10n.tr("cli.unknown_option", args[i])); return .usage
            }
            i += 1
        }
        guard store.exists else { err(L10n.tr("cli.config.missing", store.fileURL.path)); return .usage }
        let loaded: ConfigStore.Loaded
        do { loaded = try store.load() } catch { err(String(describing: error)); return .usage }
        if loaded.hasErrors { loaded.issues.forEach { err($0.description) }; return .usage }
        if loaded.config.destinations.isEmpty { err(L10n.tr("cli.backup.no_destination")); return .usage }
        if let ids = req.destinationIDs, let bad = ids.first(where: { id in !loaded.config.destinations.contains { $0.id == id } }) {
            err(L10n.tr("cli.backup.unknown_destination", bad)); return .usage
        }
        let service = BackupService(paths: store.paths, config: loaded.config)
        service.extraParts = aiParts.map { f in { c, staging in try f(c, staging) } }
        if let tools = req.aiTools {
            var c = loaded.config
            c.ai = c.ai.filter { tools.contains($0.id) }
            let s2 = BackupService(paths: store.paths, config: c)
            s2.extraParts = service.extraParts
            return runBackup(s2, req, json: json, out: out, err: err)
        }
        return runBackup(service, req, json: json, out: out, err: err)
    }

    static func runBackup(_ service: BackupService, _ req: BackupService.Request, json: Bool,
                          out: (String) -> Void, err: (String) -> Void) -> Exit {
        let results: [BackupService.Result]
        do {
            results = try service.run(req) { dest, p in
                if !p.current.isEmpty, p.files % 1000 == 0 {
                    FileHandle.standardError.write(Data((L10n.tr("cli.backup.progress", dest, p.part, Fmt.count(p.files)) + "\n").utf8))
                }
            }
        } catch OperationLock.Failure.alreadyHeld {
            err(L10n.tr("cli.busy")); return .failure
        } catch {
            err(String(describing: error)); return .failure
        }
        if json {
            let list: [[String: Any]] = results.map { r in
                var d: [String: Any] = ["destination": r.destination, "waiting": r.waiting, "error": r.error ?? NSNull()]
                if let o = r.outcome {
                    d["version"] = o.version ?? NSNull()
                    d["dry_run"] = o.dryRun
                    d["bytes_by_part"] = o.bytesByPart
                    d["files_transferred"] = o.filesTransferred
                    d["bytes_transferred"] = o.bytesTransferred
                    d["deleted_versions"] = o.deletedVersions
                    d["warnings"] = o.warnings
                }
                return d
            }
            if let data = try? JSONSerialization.data(withJSONObject: ["results": list], options: [.prettyPrinted, .sortedKeys]),
               let s = String(data: data, encoding: .utf8) { out(s) }
        } else {
            for r in results {
                if let o = r.outcome {
                    out(o.dryRun ? L10n.tr("cli.backup.dry_result", r.destination, Fmt.count(o.filesTransferred), Fmt.bytes(o.bytesTransferred))
                                 : L10n.tr("cli.backup.result", r.destination, o.version ?? "-", Fmt.count(o.filesTransferred),
                                           Fmt.bytes(o.bytesTransferred), Fmt.duration(o.duration)))
                    for (part, b) in o.bytesByPart.sorted(by: { $0.key < $1.key }) { out("  " + part.padding(toLength: 30, withPad: " ", startingAt: 0) + " " + Fmt.bytes(b)) }
                    o.warnings.forEach { err("  " + $0) }
                    if !o.deletedVersions.isEmpty { out(L10n.tr("cli.backup.deleted", o.deletedVersions.count)) }
                } else if r.waiting {
                    err(L10n.tr("cli.backup.waiting", r.destination))
                } else {
                    err(L10n.tr("cli.backup.failed", r.destination, r.error ?? ""))
                }
                if let pw = r.newImagePassword { out(L10n.tr("cli.backup.image_password", r.destination, pw)) }
            }
        }
        return results.allSatisfy { $0.outcome != nil } ? .ok : .failure
    }

    static func verify(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.verify.help")); return .ok }
        var full = false
        var destID: String?
        var version: String?
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--full": full = true
            case "--destination": guard i + 1 < args.count else { return .usage }; i += 1; destID = args[i]
            case "--version": guard i + 1 < args.count else { return .usage }; i += 1; version = args[i]
            default: err(L10n.tr("cli.unknown_option", args[i])); return .usage
            }
            i += 1
        }
        let config = readConfig(store)
        let dests = config.destinations.filter { destID == nil || $0.id == destID }
        guard !dests.isEmpty else { err(L10n.tr("cli.backup.no_destination")); return .usage }
        var damaged = 0
        for d in dests {
            let session = DestinationSession(d)
            do {
                let root = try session.open(createIfMissing: false)
                defer { session.close() }
                let dir = BackupEngine.versionsDir(root: root)
                let all = BackupEngine.versions(in: dir)
                let targets = version.map { [$0] } ?? (full ? all : Array(all.suffix(1)))
                for v in targets {
                    let r = Integrity.verify(version: dir.appendingPathComponent(v), full: full)
                    damaged += r.damaged.count
                    out(r.missingChecksums ? L10n.tr("cli.verify.pending", d.id, v)
                                           : L10n.tr("cli.verify.result", d.id, v, Fmt.count(r.checked), r.damaged.count))
                    r.damaged.prefix(20).forEach { err("  ✗ " + $0) }
                }
            } catch {
                err(String(describing: error)); damaged += 1
            }
        }
        return damaged == 0 ? .ok : .failure
    }

    static func analyze(_ args: [String], store: ConfigStore, out: (String) -> Void, err: (String) -> Void) -> Exit {
        if args.contains("-h") || args.contains("--help") { out(L10n.tr("cli.analyze.help")); return .ok }
        var json = false
        var folders: [String] = []
        for a in args {
            if a == "--json" { json = true }
            else if a.hasPrefix("-") { err(L10n.tr("cli.unknown_option", a)); return .usage }
            else { folders.append((a as NSString).expandingTildeInPath) }
        }
        // Par défaut : les dossiers suivis de config.toml (sans modifier le fichier), sinon /Volumes/workspaces.
        var config = CairnConfig()
        if store.exists, let text = try? String(contentsOf: store.fileURL, encoding: .utf8),
           let doc = try? TOMLDocument(parsing: text), let (c, _) = try? ConfigDecoder.decode(doc) {
            config = c
        }
        let explicit = !folders.isEmpty
        if !explicit { folders = config.folders.map(\.expandedPath) }
        if folders.isEmpty { folders = ["/Volumes/workspaces"] }
        if explicit {
            for f in folders where !FileManager.default.fileExists(atPath: f) {
                err(L10n.tr("cli.missing_folder", f)); return .failure
            }
        }

        let ctx = ScanContext(bigFileThreshold: Int64(config.analysis.bigFileThresholdMB) * 1_000_000)
        let folderThreshold = Int64(config.analysis.bigFolderThresholdGB * 1_000_000_000)
        let scans = Scanner.scanFolders(folders, ctx: ctx)
        var reports: [[String: Any]] = []
        var total: Int64 = 0
        for scan in scans {
            guard let r = scan.result else {
                if json { reports.append(["path": scan.folder, "available": false]) }
                else { err(L10n.tr("config.issue.folder_unavailable", scan.folder)) }
                continue
            }
            total += r.root.size
            let big = BigObjects.find(in: r.root, bigFiles: r.bigFiles, folderThreshold: folderThreshold)
            let projects = Projects.find(in: r.root)
            if json {
                var breakdown: [String: Int64] = [:]
                for c in Category.allCases { breakdown[c.key] = r.root.bytes(c) }
                reports.append([
                    "path": scan.folder, "available": true, "size": r.root.size, "files": r.root.fileCount,
                    "regenerable": r.root.regenerableBytes, "breakdown": breakdown,
                    "errors": r.errors, "duration_seconds": r.duration,
                    "big_objects": big.prefix(50).map { ["kind": $0.kind.rawValue, "path": $0.path, "size": $0.size,
                                                         "category": $0.category.key] as [String: Any] },
                    "projects": projects.prefix(50).map { ["path": $0.path, "size": $0.totalSize, "git": $0.git,
                                                           "regenerable": $0.regenerable, "worktrees": $0.worktrees.count,
                                                           "worktree_bytes": $0.worktreeBytes] as [String: Any] },
                ])
            } else {
                out(L10n.tr("cli.report.summary", scan.folder, Fmt.bytes(r.root.size), Fmt.count(r.root.fileCount),
                            Fmt.duration(r.duration), r.errors))
                for c in Category.allCases where r.root.bytes(c) > 0 {
                    out("  " + c.label.padding(toLength: 34, withPad: " ", startingAt: 0) + " " + Fmt.bytes(r.root.bytes(c)))
                }
                out(L10n.tr("cli.report.folders"))
                for n in r.root.children.prefix(15) {
                    out("  " + n.name.padding(toLength: 22, withPad: " ", startingAt: 0) + " "
                        + Fmt.bytes(n.size).padding(toLength: 10, withPad: " ", startingAt: 0) + " "
                        + L10n.tr("cli.report.of_regenerable", Fmt.bytes(n.regenerableBytes)))
                }
                out(L10n.tr("cli.report.big_objects"))
                for o in big.prefix(10) {
                    out("  " + Fmt.bytes(o.size).padding(toLength: 10, withPad: " ", startingAt: 0) + " "
                        + L10n.tr(o.kind == .file ? "cli.report.kind_file" : "cli.report.kind_folder") + " " + o.path)
                }
            }
        }
        if json {
            let obj: [String: Any] = ["folders": reports, "total": total]
            if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
               let s = String(data: data, encoding: .utf8) { out(s) }
        } else if scans.count > 1 {
            out(L10n.tr("cli.report.total", Fmt.bytes(total)))
        }
        return scans.contains(where: \.isAvailable) ? .ok : .failure
    }
}
