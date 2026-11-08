import CairnCore
import Foundation

let scannerTests: [TestCase] = [
    TestCase("classifies_regenerable_folders") {
        try withTempDir { dir in
            try writeFile(dir.appendingPathComponent("proj/src/main.ts"), size: 50_000)
            try writeFile(dir.appendingPathComponent("proj/node_modules/x/index.js"), size: 300_000)
            try writeFile(dir.appendingPathComponent("proj/package.json"), size: 100)
            try writeFile(dir.appendingPathComponent("proj/build/out.js"), size: 120_000)
            try writeFile(dir.appendingPathComponent("other/build/keep.txt"), size: 80_000) // pas de projet : sources
            let r = Scanner.scan(root: dir.path, ctx: ScanContext())
            try expect(r.root.bytes(.deps) >= 300_000, "node_modules non classé")
            try expect(r.root.bytes(.build) >= 120_000, "build/ à côté de package.json non classé")
            try expect(r.root.bytes(.source) >= 130_000, "sources sous-évaluées")
            try expect(r.root.bytes(.build) < 200_000, "build/ sans projet classé à tort")
        }
    },
    TestCase("hard_links_counted_once") {
        try withTempDir { dir in
            let a = dir.appendingPathComponent("x/a.bin")
            try writeFile(a, size: 1_000_000)
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("y"), withIntermediateDirectories: true)
            try FileManager.default.linkItem(at: a, to: dir.appendingPathComponent("y/a.bin"))
            let r = Scanner.scan(root: dir.path, ctx: ScanContext())
            try expect(r.root.size < 1_500_000, "fichier lié compté deux fois : \(r.root.size)")
        }
    },
    TestCase("swiftpm_build_is_regenerable") {
        try withTempDir { dir in
            try writeFile(dir.appendingPathComponent("pkg/Package.swift"), size: 100)
            try writeFile(dir.appendingPathComponent("pkg/.build/debug/bin"), size: 200_000)
            let r = Scanner.scan(root: dir.path, ctx: ScanContext())
            try expect(r.root.bytes(.build) >= 200_000)
        }
    },
]
