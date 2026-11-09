import CairnCore
import Foundation
import Testing

/// Suite racine : toutes les suites de Cairn sont déclarées dans une extension de `CairnTests`.
/// Les tests tournent en parallèle, dans un `CAIRN_HOME` temporaire (jamais le vrai `~/.cairn`) et avec un
/// inventaire des outils vide (pas de brew, mise, npm… de la machine). Un test qui touche à l'état global du
/// processus porte le trait `.globalState`.
@Suite(.testEnvironment)
struct CairnTests {}

/// Environnement de toute la suite : `CAIRN_HOME` temporaire et inventaire des outils vide.
struct TestEnvironment: SuiteTrait, TestScoping {
    func provideScope(for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-tests-home-\(UUID().uuidString)")
        let previous = ProcessInfo.processInfo.environment["CAIRN_HOME"]
        let inventory = BackupService.collectInventory
        setenv("CAIRN_HOME", home.path, 1)
        BackupService.collectInventory = { _ in Inventory(entries: [], taps: []) }
        defer {
            BackupService.collectInventory = inventory
            if let previous { setenv("CAIRN_HOME", previous, 1) } else { unsetenv("CAIRN_HOME") }
            try? FileManager.default.removeItem(at: home)
        }
        try await function()
    }
}

/// Test qui touche à l'état global du processus : `CLI.run` (langue active, `CAIRN_HOME` et son verrou partagés),
/// `L10n.current`, ou qui compare un texte traduit. Ces tests passent un par un ; les autres continuent en parallèle.
/// La durée affichée pour ces tests inclut leur attente du verrou.
struct GlobalState: TestTrait, SuiteTrait, TestScoping {
    var isRecursive: Bool { true }

    func provideScope(for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
        guard testCase != nil else { return try await function() }   // une suite : chacun de ses tests prend le verrou
        await GlobalStateLock.shared.acquire()
        do {
            try await function()
        } catch {
            await GlobalStateLock.shared.release()
            throw error
        }
        await GlobalStateLock.shared.release()
    }
}

/// Verrou asynchrone (file d'attente) des tests `.globalState`.
actor GlobalStateLock {
    static let shared = GlobalStateLock()
    private var held = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        guard held else { held = true; return }
        await withCheckedContinuation { waiting.append($0) }
    }

    func release() {
        if waiting.isEmpty { held = false } else { waiting.removeFirst().resume() }
    }
}

extension Trait where Self == TestEnvironment {
    static var testEnvironment: Self { Self() }
}

extension Trait where Self == GlobalState {
    static var globalState: Self { Self() }
}

/// Dossier temporaire supprimé après le test.
func withTempDir(_ body: (URL) throws -> Void) throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    try body(dir.resolvingSymlinksInPath())
}

/// Écrit un fichier de `size` octets (contenu non compressible inutile ici : zéros).
func writeFile(_ url: URL, size: Int) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(count: size).write(to: url)
}

/// Racine du package (pour les tests qui lisent les sources).
let packageRoot: URL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

/// Lance une commande et renvoie (code, sortie standard).
@discardableResult
func shell(_ launchPath: String, _ args: [String]) throws -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    try p.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

private final class BundleMarker {}

/// Exécutable construit par SwiftPM à côté du bundle de tests (`Cairn`, `CairnTestHelper`), nil s'il est absent.
func builtExecutable(_ name: String) -> URL? {
    let url = Bundle(for: BundleMarker.self).bundleURL.deletingLastPathComponent().appendingPathComponent(name)
    return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
}
