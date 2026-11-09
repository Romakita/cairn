import CairnCore
import Foundation
import Testing

/// Exécuteur factice qui note les commandes lancées.
private final class RecordingRunner: CommandRunner, @unchecked Sendable {
    let outputs: [String: String]
    var commands: [String] = []
    init(_ outputs: [String: String]) { self.outputs = outputs }
    func run(_ command: [String]) -> (status: Int32, output: Data) {
        let key = command.joined(separator: " ")
        commands.append(key)
        for (k, v) in outputs where key.hasPrefix(k) { return (0, Data(v.utf8)) }
        return (127, Data())
    }
}

private func permissions(_ url: URL) throws -> Int {
    (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

private func withLanguage(_ lang: AppLanguage, _ body: () throws -> Void) rethrows {
    let saved = L10n.current
    defer { L10n.current = saved }
    L10n.current = lang
    try body()
}

extension CairnTests {
    @Suite struct ConfigWarningTests {
        // 1. ~/.cairn en 700, quel que soit le premier à le créer.
        @Test func cairn_dir_created_700_by_runlog_and_watcher() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                let log = RunLog(paths: paths, type: "app")
                log.write("x")
                log.close()
                let rootPerms = try permissions(paths.root)
                #expect(rootPerms == 0o700)
                #expect(FileManager.default.fileExists(atPath: log.url.path))

                let other = CairnPaths(root: dir.appendingPathComponent("other"))
                let watcher = ConfigStore(paths: other).watch { }
                watcher.cancel()
                let otherPerms = try permissions(other.root)
                #expect(otherPerms == 0o700)
            }
        }

        @Test func runlog_keeps_existing_root_permissions() throws {
            // Avec --config, la racine est le dossier choisi par l'utilisateur : on n'y touche pas.
            try withTempDir { dir in
                let root = dir.appendingPathComponent("mine")
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o755])
                RunLog(paths: CairnPaths(root: root), type: "backup").close()
                let perms = try permissions(root)
                #expect(perms == 0o755)
            }
        }

        // 2. Une erreur de syntaxe devient une erreur bloquante, avec sa ligne.
        @Test(.globalState) func syntax_error_becomes_blocking_issue_with_line() throws {
            try withTempDir { dir in
                let store = ConfigStore(paths: CairnPaths(root: dir))
                try "version = 1\nlanguage = \"fr-FR\"\n[schedule\nfrequency = \"daily\"\n"
                    .write(to: store.fileURL, atomically: true, encoding: .utf8)
                do {
                    _ = try store.load()
                    Issue.record("chargement accepté")
                    return
                } catch let e as ConfigStore.LoadError {
                    let issues = ConfigStore.issues(for: e)
                    try #require(issues.count == 1)
                    #expect(issues[0].severity == .error)
                    #expect(issues[0].line == 3)
                    withLanguage(.frFR) {
                        #expect(issues[0].description.hasPrefix("erreur ligne 3 : "), "\(issues[0].description)")
                    }
                }
            }
        }

        // 3. Enregistrer depuis l'app n'écrase pas un fichier invalide.
        @Test func save_refuses_to_overwrite_invalid_file() throws {
            try withTempDir { dir in
                let store = ConfigStore(paths: CairnPaths(root: dir))
                var c = CairnConfig()
                c.folders = [.init(path: dir.path)]
                try store.save(c)
                for broken in ["# à corriger\nversion = 1\n[schedule\n", "version = 1\n[schedule]\ntime = \"25:00\"\n"] {
                    try broken.write(to: store.fileURL, atomically: true, encoding: .utf8)
                    var newer = c
                    newer.git.gc = false
                    do {
                        try store.save(newer)
                        Issue.record("enregistrement accepté")
                        return
                    } catch let e as ConfigStore.SaveError {
                        guard case let .invalidFile(issues) = e else { return }
                        #expect(!issues.isEmpty && issues.allSatisfy { $0.severity == .error })
                    }
                    #expect(try String(contentsOf: store.fileURL, encoding: .utf8) == broken, "fichier modifié")
                }
                // Fichier absent : l'assistant peut toujours l'écrire.
                try FileManager.default.removeItem(at: store.fileURL)
                try store.save(c)
                #expect(try store.load().config.folders == c.folders)
            }
        }

        // 4. Pas de clé `keychain` écrite ; l'ancienne reste lue sans erreur.
        @Test func smb_destination_has_no_keychain_key() throws {
            var d = OnboardingDraft()
            d.destination = .smb(url: "smb://nas.local/backups", username: "romain")
            let text = ConfigWriter.newDocument(d.makeConfig()).render()
            #expect(!text.contains("keychain ="), "\(text)")
            let legacy = """
            version = 1
            [[destinations]]
            id = "main"
            provider = "smb"
            url = "smb://nas.local/backups"
            username = "romain"
            keychain = "main"

            """
            var doc = try TOMLDocument(parsing: legacy)
            let (c, issues) = try ConfigDecoder.decode(doc)
            #expect(issues.isEmpty, "\(issues)")
            #expect(c.destinations.first?.keychain == "main")
            ConfigWriter.apply(c, to: &doc)
            #expect(doc.render().contains("keychain = \"main\""), "ancienne clé conservée")
        }

        // 5. Désélectionner un outil IA retire sa table, sans toucher aux commentaires.
        @Test func deselected_ai_tool_table_is_removed() throws {
            var doc = try TOMLDocument(parsing: """
            # Mon fichier
            version = 1

            # Outils IA suivis
            [ai.claude-code]
            categories = ["config"]

            [ai.codex]
            categories = ["conversations", "config"]

            # Planification
            [schedule]
            frequency = "daily"

            """)
            var c = try ConfigDecoder.decode(doc).0
            #expect(c.ai.map(\.id) == ["claude-code", "codex"])
            c.ai.removeAll { $0.id == "codex" }
            ConfigWriter.apply(c, to: &doc)
            let text = doc.render()
            #expect(!text.contains("codex"), "\(text)")
            for comment in ["# Mon fichier", "# Outils IA suivis", "# Planification"] {
                #expect(text.contains(comment), "\(text)")
            }
            let back = try ConfigDecoder.decode(try TOMLDocument(parsing: text)).0
            #expect(back.ai.map(\.id) == ["claude-code"])
            #expect(!text.contains("\n\n\n"), "\(text)")

            // Forme pointée sous [ai] : removeTable retire aussi les clés `codex.…`.
            var dotted = try TOMLDocument(parsing: "[ai]\ncodex.categories = [\"config\"]\nclaude-code.categories = [\"config\"]\n")
            dotted.removeTable(["ai", "codex"])
            #expect(dotted.render() == "[ai]\nclaude-code.categories = [\"config\"]\n")
        }

        // 6. `cairn tools --json` ne dépend pas de la langue.
        @Test(.globalState) func tools_json_is_language_independent() throws {
            let inv = InventoryCollector.classify(
                tools: [CLITool(name: "ripgrep", source: .brew, version: "15", commands: ["rg"]),
                        CLITool(name: "kubectl", source: .brew, version: "1.31", commands: ["kubectl"])],
                taps: [], homeMarkers: [".kube"], projectMarkers: [], history: ["rg": 5], excluded: [],
                rules: .bundled, available: { _ in true })
            var en = "", fr = ""
            withLanguage(.enUS) { en = InventoryExport.json(inv) }
            withLanguage(.frFR) { fr = InventoryExport.json(inv) }
            #expect(en == fr)
            #expect(en.contains("\"code\" : \"history\"") && en.contains("\"uses\" : 5"), "\(en)")
            #expect(en.contains("\"code\" : \"home\"") && en.contains("\"file\" : \".kube\""), "\(en)")
            // Le texte, lui, est traduit.
            let rg = try #require(inv.entries.first { $0.name == "ripgrep" })
            withLanguage(.frFR) { fr = rg.reasonTexts.joined() }
            withLanguage(.enUS) { en = rg.reasonTexts.joined() }
            #expect(fr != en && fr.contains("5"), "\(fr) / \(en)")
        }

        // 7. Versions : uv (dist-info), go (`go version -m`), liens de ~/.local/bin.
        @Test func uv_version_from_dist_info() throws {
            try withTempDir { home in
                let tool = home.appendingPathComponent(".local/share/uv/tools/serena-agent")
                try writeFile(tool.appendingPathComponent("uv-receipt.toml"), size: 0)
                try """
                [tool]
                requirements = [{ name = "serena-agent" }]
                entrypoints = [{ name = "serena", install-path = "/x/serena", from = "serena-agent" }]
                """.write(to: tool.appendingPathComponent("uv-receipt.toml"), atomically: true, encoding: .utf8)
                let site = tool.appendingPathComponent("lib/python3.13/site-packages")
                for d in ["serena_agent-1.5.3.dist-info", "serena_agent_extra-9.9.dist-info", "anyio-4.13.0.dist-info"] {
                    try FileManager.default.createDirectory(at: site.appendingPathComponent(d),
                                                            withIntermediateDirectories: true)
                }
                #expect(InventoryParsers.uvVersion(name: "serena-agent", toolDir: tool) == "1.5.3")
                #expect(InventoryParsers.uvVersion(name: "Serena.Agent", toolDir: tool) == "1.5.3")
                #expect(InventoryParsers.uvVersion(name: "absent", toolDir: tool) == nil)
                let (tools, _) = InventoryCollector.installed(home: home, runner: RecordingRunner([:]), rules: .bundled)
                let uv = tools.first { $0.source == .uv }
                #expect(uv?.name == "serena-agent")
                #expect(uv?.version == "1.5.3")
                #expect(uv?.commands == ["serena"])
            }
        }

        @Test func go_version_from_build_info() throws {
            let out = "/Users/x/go/bin/gopls: go1.22.0\n\tpath\tgolang.org/x/tools/gopls\n"
                + "\tmod\tgolang.org/x/tools/gopls\tv0.15.0\th1:abc=\n\tdep\tgolang.org/x/mod\tv0.15.0\n"
            #expect(InventoryParsers.goVersion(out) == "v0.15.0")
            #expect(InventoryParsers.goVersion("x: go1.22\n\tmod\texample.com/x\t(devel)\t\n") == nil)
            try withTempDir { home in
                try writeFile(home.appendingPathComponent("go/bin/gopls"), size: 1)
                try writeFile(home.appendingPathComponent("go/bin/other"), size: 1)
                let runner = RecordingRunner(["go version -m \(home.path)/go/bin/gopls": out])
                let (tools, _) = InventoryCollector.installed(home: home, runner: runner, rules: .bundled)
                let go = Dictionary(uniqueKeysWithValues: tools.filter { $0.source == .go }.map { ($0.name, $0.version) })
                #expect(go["gopls"] == .some("v0.15.0"))
                #expect(go["other"] == .some(nil), "go absent ou sans info : version inconnue")
            }
        }

        @Test func local_bin_version_from_link_target() {
            let tools = InventoryParsers.localBin(entries: [
                (name: "claude", linkTarget: "/Users/x/.local/share/claude/versions/2.1.3"),
                (name: "codex", linkTarget: "/Users/x/.codex/packages/standalone/current/bin/codex"),
                (name: "tool", linkTarget: "/opt/tool-v1.2.0/v1.2.0/bin/tool"),
            ])
            #expect(tools.map(\.version) == ["2.1.3", nil, "v1.2.0"])
        }

        @Test func brew_leaves_installed_on_request_only() throws {
            try withTempDir { home in
                let runner = RecordingRunner(["brew leaves --installed-on-request": "gh\n",
                                              "brew list --versions gh": "gh 2.93.0\n"])
                let (tools, _) = InventoryCollector.installed(home: home, runner: runner, rules: .bundled)
                #expect(tools.filter { $0.source == .brew }.map(\.name) == ["gh"])
                #expect(runner.commands.contains("brew leaves --installed-on-request"), "\(runner.commands)")
            }
        }

        // 8. Pluriels (.stringsdict).
        @Test(.globalState) func plurals_from_stringsdict() {
            withLanguage(.frFR) {
                #expect(L10n.tr("list.repos", 1) == "1 dépôt")
                #expect(L10n.tr("list.repos", 2) == "2 dépôts")
                let one = L10n.tr("cli.git.summary", 1, "3 Go", 1, 0, "0 o")
                #expect(one.contains("1 dépôt,") && one.contains("1 branche et 0 worktree à"), "\(one)")
                let two = L10n.tr("cli.git.summary", 2, "3 Go", 2, 3, "0 o")
                #expect(two.contains("2 dépôts,") && two.contains("2 branches et 3 worktrees"), "\(two)")
                #expect(L10n.tr("cli.git.repo_line", "app", "1 Go", "0 o", 1, "2 Mo", 2)
                        == "app  .git 1 Go  non compressé 0 o  1 branche à supprimer (2 Mo)  2 gardées")
            }
            withLanguage(.enUS) {
                #expect(L10n.tr("list.repos", 1) == "1 repository")
                #expect(L10n.tr("list.repos", 2) == "2 repositories")
                let one = L10n.tr("cli.git.summary", 1, "3 GB", 1, 1, "0 bytes")
                #expect(one.contains("1 repository,") && one.contains("1 branch and 1 worktree to"), "\(one)")
                #expect(L10n.tr("git.done", 2, 1) == "2 branches and 1 worktree deleted.")
            }
        }

        @Test func stringsdict_keys_match_and_have_fallback() {
            let en = L10n.pluralKeys(.enUS), fr = L10n.pluralKeys(.frFR)
            #expect(!en.isEmpty, "Localizable.stringsdict absent du bundle")
            #expect(en == fr)
            // Chaque pluriel garde un texte de repli dans les .strings (parité et formats contrôlés par L10n).
            for k in en { #expect(L10n.table(.enUS)[k] != nil && L10n.table(.frFR)[k] != nil, "\(k) absent des .strings") }
        }

        // 9. Suggestions.
        @Test func onboarding_preselects_by_path_not_rank() {
            let home = URL(fileURLWithPath: "/Users/test")
            let existing: Set<String> = ["/Volumes/workspaces", "/Users/test/Projects", "/Users/test/code"]
            let d = OnboardingDraft.detect(home: home, legacyRootPath: nil, exists: existing.contains)
            #expect(d.folders.map(\.path) == ["/Volumes/workspaces", "/Users/test/Projects", "/Users/test/code"])
            #expect(d.folders.map(\.selected) == [true, false, false])
            let legacy = OnboardingDraft.detect(home: home, legacyRootPath: "/Users/test/code", exists: existing.contains)
            #expect(legacy.folders.map(\.selected) == [true, true, false])
        }

        @Test(.globalState) func duration_is_localized() {
            withLanguage(.frFR) {
                #expect(Fmt.duration(12.34) == "12,3 s")
                let long = Fmt.duration(125)
                #expect(long.contains("2") && long.contains("min") && long.contains("5"), "\(long)")
            }
            withLanguage(.enUS) {
                #expect(Fmt.duration(12.34) == "12.3 s")
                #expect(Fmt.duration(3_725).contains("1 hr") || Fmt.duration(3_725).contains("1h"),
                        "\(Fmt.duration(3_725))")
            }
        }

        @Test func french_falls_back_to_english_then_key() {
            let lookup: (String, AppLanguage) -> String? = { key, lang in
                [AppLanguage.enUS: ["only.en": "English only"], .frFR: ["both": "Les deux"]][lang]?[key]
            }
            #expect(L10n.resolve("only.en", in: .frFR, lookup: lookup) == "English only")
            #expect(L10n.resolve("both", in: .frFR, lookup: lookup) == "Les deux")
            #expect(L10n.resolve("nowhere", in: .frFR, lookup: lookup) == "nowhere")
        }
    }
}
