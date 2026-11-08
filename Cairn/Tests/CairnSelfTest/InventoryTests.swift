import CairnCore
import Foundation

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

let inventoryTests: [TestCase] = [
    TestCase("rules_resource_loads") {
        try expect(!rules.home.isEmpty && !rules.projects.isEmpty, "rules.json introuvable")
        try expectEqual(rules.commands(for: "ripgrep"), ["rg"])
        try expectEqual(rules.commands(for: "@acme/cli"), ["acme"])
        try expectEqual(rules.commands(for: "php@8.4"), ["php"])
    },
    TestCase("parses_brew_mise_npm") {
        let brew = InventoryParsers.brewVersions("gh 2.93.0\nripgrep 15.1.0\nphp@8.4 8.4.21\n", rules: rules)
        try expectEqual(brew.map(\.name), ["gh", "ripgrep", "php@8.4"])
        try expectEqual(brew[1].commands, ["rg"])
        try expectEqual(brew[2].version, "8.4.21")
        let mise = InventoryParsers.mise(Data("""
        {"node":[{"version":"24.18.0","requested_version":"24.18.0","active":true}],
         "npm:@fission-ai/openspec":[{"version":"1.16.1","requested_version":"latest","active":true}]}
        """.utf8), rules: rules)
        try expectEqual(mise.map(\.name), ["node", "npm:@fission-ai/openspec"])
        try expectEqual(mise[1].commands, ["openspec"])
        let npm = InventoryParsers.npmGlobals(Data("""
        {"name":"lib","dependencies":{"npm":{"version":"10"},"corepack":{"version":"0.3"},
         "@anthropic-ai/claude-code":{"version":"2.1.317"}}}
        """.utf8), rules: rules)
        try expectEqual(npm.map(\.name), ["@anthropic-ai/claude-code"])
        try expectEqual(npm[0].commands, ["claude"])
    },
    TestCase("parses_uv_receipt_with_extras_and_python") {
        let t = InventoryParsers.uvReceipt("""
        [tool]
        requirements = [{ name = "ruff", extras = ["lsp"] }]
        python = "3.12"
        entrypoints = [
            { name = "ruff", install-path = "/Users/x/.local/bin/ruff", from = "ruff" },
        ]
        """)
        try expectEqual(t?.name, "ruff")
        try expectEqual(t?.source, .uv)
        try expectEqual(t?.details["python"], "3.12")
        try expectEqual(t?.details["extras"], "lsp")
        try expectEqual(t?.commands, ["ruff"])
    },
    TestCase("local_bin_links_attached_to_their_source") {
        let tools = InventoryParsers.localBin(entries: [
            (name: "ruff", linkTarget: "/Users/x/.local/share/uv/tools/ruff/bin/ruff"),
            (name: "cocoindex", linkTarget: "/Users/x/.local/pipx/venvs/cocoindex/bin/cocoindex"),
            (name: "coderabbit", linkTarget: nil),
            (name: "cr", linkTarget: "/Users/x/.local/bin/coderabbit"),
            (name: "mise", linkTarget: nil),
        ])
        try expectEqual(tools.map(\.name), ["coderabbit", "mise"])
    },
    TestCase("history_counts_commands") {
        let h = InventoryParsers.history(": 1700000000:0;rg foo\n: 1700000001:0;sudo rg bar\nrtk rg baz\ngit status\n./script.sh\n")
        try expectEqual(h["rg"], 3)
        try expectEqual(h["git"], 1)
        try expectEqual(h["./script.sh"], nil)
    },
    TestCase("statuses_used_unused_missing") {
        let tools = [CLITool(name: "gh", source: .brew, version: "2", commands: ["gh"]),
                     CLITool(name: "ripgrep", source: .brew, version: "15", commands: ["rg"]),
                     CLITool(name: "cowsay", source: .brew, version: "3", commands: ["cowsay"]),
                     CLITool(name: "visual-studio-code", source: .brew, version: nil, commands: ["code"])]
        let inv = InventoryCollector.classify(tools: tools, taps: [], homeMarkers: [".config/gh", ".kube"],
                                              projectMarkers: ["justfile"], history: ["rg": 5, "cowsay": 1],
                                              excluded: ["cowsay"], rules: rules, available: { _ in false })
        let byName = Dictionary(uniqueKeysWithValues: inv.entries.map { ($0.name, $0) })
        try expectEqual(byName["gh"]?.status, .used)
        try expectEqual(byName["ripgrep"]?.status, .used)
        try expectEqual(byName["cowsay"]?.status, .unused)
        try expectEqual(byName["cowsay"]?.excluded, true)
        try expectEqual(byName["kubectl"]?.status, .missing)
        try expectEqual(byName["kubectl"]?.reasons, ["~/.kube"])
        try expectEqual(byName["just"]?.status, .missing)
        try expectEqual(inv.entries.first?.status, .missing, "les manquants d'abord")
    },
    TestCase("collect_never_includes_casks") {
        try withTempDir { home in
            let runner = FakeRunner(outputs: ["brew leaves": "gh\n", "brew list --versions gh": "gh 2.93.0\n",
                                              "brew tap": "hashicorp/tap\n"])
            let (tools, taps) = InventoryCollector.installed(home: home, runner: runner, rules: rules)
            try expectEqual(tools.map(\.name), ["gh"])
            try expectEqual(taps, ["hashicorp/tap"])
        }
    },
    TestCase("export_tools_toml_and_brewfile") {
        try withTempDir { dir in
            let inv = Inventory(entries: [
                InventoryEntry(name: "gh", tool: CLITool(name: "gh", source: .brew, version: "2.93.0", commands: ["gh"]), status: .used, reasons: [], excluded: false),
                InventoryEntry(name: "cowsay", tool: CLITool(name: "cowsay", source: .brew, version: "3", commands: ["cowsay"]), status: .unused, reasons: [], excluded: true),
                InventoryEntry(name: "ruff", tool: CLITool(name: "ruff", source: .uv, version: nil, commands: ["ruff"], details: ["python": "3.12"]), status: .used, reasons: [], excluded: false),
            ], taps: ["hashicorp/tap"])
            try InventoryExport.write(inv, to: dir)
            let brewfile = try String(contentsOf: dir.appendingPathComponent("Brewfile"), encoding: .utf8)
            try expectEqual(brewfile, "tap \"hashicorp/tap\"\nbrew \"gh\"\n")
            try expect(!brewfile.contains("cask") && !brewfile.contains("mas"))
            let toml = try TOMLDocument(parsing: String(contentsOf: dir.appendingPathComponent("tools.toml"), encoding: .utf8)).tree()
            try expectEqual(toml.value("version")?.integer, 1)
            try expectEqual(toml.tables("brew").map { $0.value("name")?.string }, ["gh"])
            try expectEqual(toml.tables("uv").first?.value("python")?.string, "3.12")
        }
    },
    TestCase("excluded_tool_stays_excluded") {
        try withTempDir { dir in
            let store = ConfigStore(paths: CairnPaths(root: dir))
            var c = CairnConfig()
            c.excludedTools = ["cowsay"]
            try store.save(c)
            let reloaded = try store.load().config
            let inv = InventoryCollector.classify(tools: [CLITool(name: "cowsay", source: .brew, version: nil, commands: ["cowsay"])],
                                                  taps: [], homeMarkers: [], projectMarkers: [], history: [:],
                                                  excluded: Set(reloaded.excludedTools), rules: rules)
            try expectEqual(inv.entries.first?.excluded, true)
        }
    },
]
