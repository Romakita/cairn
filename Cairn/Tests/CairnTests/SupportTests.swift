import CairnCore
import Foundation
import Testing

extension CairnTests {
    @Suite struct SupportTests {
        @Test func paths_created_with_700() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
                try paths.ensure()
                let perms = try FileManager.default.attributesOfItem(atPath: paths.root.path)[.posixPermissions] as? Int
                #expect(perms == 0o700)
                #expect(FileManager.default.fileExists(atPath: paths.logs.path))
                #expect(FileManager.default.fileExists(atPath: paths.state.path))
            }
        }

        @Test func second_lock_refused() throws {
            try withTempDir { dir in
                let url = dir.appendingPathComponent("operation.lock")
                let a = OperationLock(url: url), b = OperationLock(url: url)
                try a.acquire(operation: "backup")
                #expect(throws: OperationLock.Failure.alreadyHeld) { try b.acquire(operation: "restore") }
                a.release()
                try b.acquire(operation: "restore")
                #expect(b.isHeld)
            }
        }

        @Test func lock_held_by_other_process_then_freed_on_exit() throws {
            try withTempDir { dir in
                let url = dir.appendingPathComponent("operation.lock")
                let helper = try #require(builtExecutable("CairnTestHelper"))
                let p = Process()
                p.executableURL = helper
                p.arguments = ["--hold-lock", url.path, "1.5"]
                let pipe = Pipe()
                p.standardOutput = pipe
                try p.run()
                // Attendre que le processus annonce le verrou.
                let line = String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? ""
                try #require(line.contains("held"), "le processus auxiliaire n'a pas pris le verrou")
                let mine = OperationLock(url: url)
                #expect(throws: OperationLock.Failure.alreadyHeld) { try mine.acquire(operation: "backup") }
                p.waitUntilExit()
                try mine.acquire(operation: "backup")
                #expect(mine.isHeld, "le verrou aurait dû être libéré à la fin du processus")
            }
        }

        @Test func run_log_written() throws {
            try withTempDir { dir in
                let paths = CairnPaths(root: dir)
                let log = RunLog(paths: paths, type: "analyze")
                log.write("début")
                log.close()
                let text = try String(contentsOf: log.url, encoding: .utf8)
                #expect(text.contains("début"))
                #expect(log.url.lastPathComponent.hasPrefix("analyze-"))
            }
        }

        @Test func resources_missing_bundle_does_not_crash() throws {
            // L'app 0.1.0 plantait au lancement (assertion de Bundle.module) quand le bundle de ressources était
            // introuvable.
            try withTempDir { dir in
                let b = CairnResources.resolve([dir.appendingPathComponent("absent/Cairn_CairnCore.bundle")])
                #expect(b === Bundle.main)
            }
        }

        @Test func resources_bundle_has_catalogs() {
            let b = CairnResources.bundle
            #expect(b !== Bundle.main, "bundle de ressources introuvable")
            for lang in ["en", "fr"] {
                #expect(b.url(forResource: "Localizable", withExtension: "strings", subdirectory: nil,
                              localization: lang) != nil)
            }
        }
    }
}
