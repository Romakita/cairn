import Foundation

/// Mini framework de tests : les Command Line Tools n'ont ni XCTest ni swift-testing.
struct TestFailure: Error, CustomStringConvertible {
    let message: String
    let file: String
    let line: UInt
    var description: String { "\((file as NSString).lastPathComponent):\(line): \(message)" }
}

struct TestCase {
    let name: String
    let body: () throws -> Void
    init(_ name: String, _ body: @escaping () throws -> Void) {
        self.name = name
        self.body = body
    }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String = "condition fausse",
            file: String = #filePath, line: UInt = #line) throws {
    if !condition() { throw TestFailure(message: message(), file: file, line: line) }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: String = "", file: String = #filePath, line: UInt = #line) throws {
    if a != b {
        throw TestFailure(message: "\(a) ≠ \(b)" + (message.isEmpty ? "" : " — \(message)"), file: file, line: line)
    }
}

func expectThrows<E: Error & Equatable>(_ expected: E, file: String = #filePath, line: UInt = #line, _ body: () throws -> Void) throws {
    do {
        try body()
    } catch let e as E where e == expected {
        return
    } catch {
        throw TestFailure(message: "erreur inattendue : \(error)", file: file, line: line)
    }
    throw TestFailure(message: "aucune erreur levée, attendu \(expected)", file: file, line: line)
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
