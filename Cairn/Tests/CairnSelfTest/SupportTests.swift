import CairnCore
import Foundation

let supportTests: [TestCase] = [
    TestCase("paths_created_with_700") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir.appendingPathComponent(".cairn"))
            try paths.ensure()
            let perms = try FileManager.default.attributesOfItem(atPath: paths.root.path)[.posixPermissions] as? Int
            try expectEqual(perms, 0o700)
            try expect(FileManager.default.fileExists(atPath: paths.logs.path))
            try expect(FileManager.default.fileExists(atPath: paths.state.path))
        }
    },
    TestCase("second_lock_refused") {
        try withTempDir { dir in
            let url = dir.appendingPathComponent("operation.lock")
            let a = OperationLock(url: url), b = OperationLock(url: url)
            try a.acquire(operation: "backup")
            try expectThrows(OperationLock.Failure.alreadyHeld) { try b.acquire(operation: "restore") }
            a.release()
            try b.acquire(operation: "restore")
            try expect(b.isHeld)
        }
    },
    TestCase("lock_held_by_other_process_then_freed_on_exit") {
        try withTempDir { dir in
            let url = dir.appendingPathComponent("operation.lock")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            p.arguments = ["--hold-lock", url.path, "1.5"]
            let pipe = Pipe()
            p.standardOutput = pipe
            try p.run()
            // Attendre que le processus annonce le verrou.
            let line = String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? ""
            try expect(line.contains("held"), "le processus auxiliaire n'a pas pris le verrou")
            let mine = OperationLock(url: url)
            try expectThrows(OperationLock.Failure.alreadyHeld) { try mine.acquire(operation: "backup") }
            p.waitUntilExit()
            try mine.acquire(operation: "backup")
            try expect(mine.isHeld, "le verrou aurait dû être libéré à la fin du processus")
        }
    },
    TestCase("run_log_written") {
        try withTempDir { dir in
            let paths = CairnPaths(root: dir)
            let log = RunLog(paths: paths, type: "analyze")
            log.write("début")
            log.close()
            let text = try String(contentsOf: log.url, encoding: .utf8)
            try expect(text.contains("début"))
            try expect(log.url.lastPathComponent.hasPrefix("analyze-"))
        }
    },
]
