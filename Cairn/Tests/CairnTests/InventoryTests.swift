import CairnCore
import Foundation
import Testing

private let rules = InventoryRules.bundled

/// Exécuteur factice : sorties enregistrées par commande.
private struct FakeRunner: CommandRunner {
    let outputs: [String: String]
    func run(_ command: [String]) -> (status: Int32, output: Data) {
        let key = command.joined(separator: " ")
        for (k, v) in outputs where key.hasPrefix(k) { return (0, Data(v.utf8)) }
        return (127, Data())
    }
}

extension CairnTests {
    @Suite struct InventoryTests {
        @Test func rules_resource_loads() {
            #expect(!rules.home.isEmpty && !rules.projects.isEmpty, "rules.json introuvable")
            #expect(rules.commands(for: "ripgrep") == ["rg"])
            #expect(rules.commands(for: "@acme/cli") == ["acme"])
            #expect(rules.commands(for: "php@8.4") == ["php"])
        }

        @Test func parses_brew_mise_npm() throws {
            let brew = InventoryParsers.brewVersions("gh 2.93.0\nripgrep 15.1.0\nphp@8.4 8.4.21\n", rules: rules)
            try #require(brew.map(\.name) == ["gh", "ripgrep", "php@8.4"])
            #expect(brew[1].commands == ["rg"])
            #expect(brew[2].version == "8.4.21")
            let mise = InventoryParsers.mise(Data("""
            {"node":[{"version":"24.18.0","requested_version":"24.18.0","active":true}],
             "npm:@fission-ai/openspec":[{"version":"1.16.1","requested_version":"latest","active":true}]}
            """.utf8), rules: rules)
            try #require(mise.map(\.name) == ["node", "npm:@fission-ai/openspec"])
            #expect(mise[1].commands == ["openspec"])
            let npm = InventoryParsers.npmGlobals(Data("""
            {"name":"lib","dependencies":{"npm":{"version":"10"},"corepack":{"version":"0.3"},
             "@anthropic-ai/claude-code":{"version":"2.1.317"}}}
            """.utf8), rules: rules)
            try #require(npm.map(\.name) == ["@anthropic-ai/claude-code"])
            #expect(npm[0].commands == ["claude"])
        }

        @Test func parses_uv_receipt_with_extras_and_python() {
            let t = InventoryParsers.uvReceipt("""
            [tool]
            requirements = [{ name = "ruff", extras = ["lsp"] }]
            python = "3.12"
            entrypoints = [
                { name = "ruff", install-path = "/Users/x/.local/bin/ruff", from = "ruff" },
            ]
            """)
            #expect(t?.name == "ruff")
            #expect(t?.source == .uv)
            #expect(t?.details["python"] == "3.12")
            #expect(t?.details["extras"] == "lsp")
            #expect(t?.commands == ["ruff"])
        }

        @Test func local_bin_links_attached_to_their_source() {
            let tools = InventoryParsers.localBin(entries: [
                (name: "ruff", linkTarget: "/Users/x/.local/share/uv/tools/ruff/bin/ruff"),
                (name: "cocoindex", linkTarget: "/Users/x/.local/pipx/venvs/cocoindex/bin/cocoindex"),
                (name: "coderabbit", linkTarget: nil),
                (name: "cr", linkTarget: "/Users/x/.local/bin/coderabbit"),
                (name: "mise", linkTarget: nil),
            ])
            #expect(tools.map(\.name) == ["coderabbit", "mise"])
        }

        @Test func history_counts_commands() {
            let h = InventoryParsers.history(
                ": 1700000000:0;rg foo\n: 1700000001:0;sudo rg bar\nrtk rg baz\ngit status\n./script.sh\n")
            #expect(h["rg"] == 3)
            #expect(h["git"] == 1)
            #expect(h["./script.sh"] == nil)
        }

        @Test func statuses_used_unused_missing() {
            let tools = [CLITool(name: "gh", source: .brew, version: "2", commands: ["gh"]),
                         CLITool(name: "ripgrep", source: .brew, version: "15", commands: ["rg"]),
                         CLITool(name: "cowsay", source: .brew, version: "3", commands: ["cowsay"]),
                         CLITool(name: "visual-studio-code", source: .brew, version: nil, commands: ["code"])]
            let inv = InventoryCollector.classify(tools: tools, taps: [], homeMarkers: [".config/gh", ".kube"],
                                                  projectMarkers: ["justfile"], history: ["rg": 5, "cowsay": 1],
                                                  excluded: ["cowsay"], rules: rules, available: { _ in false })
            let byName = Dictionary(uniqueKeysWithValues: inv.entries.map { ($0.name, $0) })
            #expect(byName["gh"]?.status == .used)
            #expect(byName["ripgrep"]?.status == .used)
            #expect(byName["cowsay"]?.status == .unused)
            #expect(byName["cowsay"]?.excluded == true)
            #expect(byName["kubectl"]?.status == .missing)
            #expect(byName["kubectl"]?.reasons == [.home(".kube")])
            #expect(byName["kubectl"]?.reasonTexts == ["~/.kube"])
            #expect(byName["just"]?.status == .missing)
            #expect(inv.entries.first?.status == .missing, "les manquants d'abord")
        }

        @Test func collect_never_includes_casks() throws {
            try withTempDir { home in
                let runner = FakeRunner(outputs: ["brew leaves": "gh\n", "brew list --versions gh": "gh 2.93.0\n",
                                                  "brew tap": "hashicorp/tap\n"])
                let (tools, taps) = InventoryCollector.installed(home: home, runner: runner, rules: rules)
                #expect(tools.map(\.name) == ["gh"])
                #expect(taps == ["hashicorp/tap"])
            }
        }

        @Test func export_tools_toml_and_brewfile() throws {
            try withTempDir { dir in
                let inv = Inventory(entries: [
                    InventoryEntry(name: "gh", tool: CLITool(name: "gh", source: .brew, version: "2.93.0",
                                                             commands: ["gh"]),
                                   status: .used, reasons: [], excluded: false),
                    InventoryEntry(name: "cowsay", tool: CLITool(name: "cowsay", source: .brew, version: "3",
                                                                 commands: ["cowsay"]),
                                   status: .unused, reasons: [], excluded: true),
                    InventoryEntry(name: "ruff", tool: CLITool(name: "ruff", source: .uv, version: nil,
                                                               commands: ["ruff"], details: ["python": "3.12"]),
                                   status: .used, reasons: [], excluded: false),
                ], taps: ["hashicorp/tap"])
                try InventoryExport.write(inv, to: dir)
                let brewfile = try String(contentsOf: dir.appendingPathComponent("Brewfile"), encoding: .utf8)
                #expect(brewfile == "tap \"hashicorp/tap\"\nbrew \"gh\"\n")
                #expect(!brewfile.contains("cask") && !brewfile.contains("mas"))
                let toml = try TOMLDocument(parsing: String(contentsOf: dir.appendingPathComponent("tools.toml"),
                                                            encoding: .utf8)).tree()
                #expect(toml.value("version")?.integer == 1)
                #expect(toml.tables("brew").map { $0.value("name")?.string } == ["gh"])
                #expect(toml.tables("uv").first?.value("python")?.string == "3.12")
            }
        }

        @Test func excluded_tool_stays_excluded() throws {
            try withTempDir { dir in
                let store = ConfigStore(paths: CairnPaths(root: dir))
                var c = CairnConfig()
                c.excludedTools = ["cowsay"]
                try store.save(c)
                let reloaded = try store.load().config
                let inv = InventoryCollector.classify(
                    tools: [CLITool(name: "cowsay", source: .brew, version: nil, commands: ["cowsay"])],
                    taps: [], homeMarkers: [], projectMarkers: [], history: [:],
                    excluded: Set(reloaded.excludedTools), rules: rules)
                #expect(inv.entries.first?.excluded == true)
            }
        }
    }
}
