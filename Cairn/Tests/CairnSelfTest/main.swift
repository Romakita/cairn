import CairnCore
import Foundation

// Les tests ne touchent jamais au vrai ~/.cairn (CLI.run crée et protège ce dossier).
setenv("CAIRN_HOME", FileManager.default.temporaryDirectory.appendingPathComponent("cairn-selftest-home-\(getpid())").path, 1)
atexit { try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("cairn-selftest-home-\(getpid())")) }

// Processus auxiliaire du test de verrou : prend le verrou, l'annonce, attend puis se termine sans le libérer.
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--hold-lock" {
    let lock = OperationLock(url: URL(fileURLWithPath: CommandLine.arguments[2]))
    do { try lock.acquire(operation: "test") } catch { exit(3) }
    print("held"); fflush(stdout)
    let seconds = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0 : 0
    Thread.sleep(forTimeInterval: seconds)
    _exit(0) // fin brutale : le système doit libérer le verrou
}

// Processus auxiliaire du test du journal d'activité : ajoute N événements dans le dossier CAIRN donné.
if CommandLine.arguments.count >= 4 && CommandLine.arguments[1] == "--append-activity" {
    let log = ActivityLog(paths: CairnPaths(root: URL(fileURLWithPath: CommandLine.arguments[2])))
    for n in 0..<(Int(CommandLine.arguments[3]) ?? 0) { log.append(.init(kind: .check, count: n)) }
    exit(0)
}

// Outil de comparaison avec scripts/backup.sh : liste d'exclusions de Cairn pour un dossier.
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--excludes" {
    for line in BackupExclusions.forFolder(CommandLine.arguments[2], userPatterns: [], destinations: []) { print(line) }
    exit(0)
}

var suites: [(String, [TestCase])] = [
    ("Harness", harnessTests),
    ("L10n", localizationTests),
    ("Support", supportTests),
    ("CLI", cliTests),
    ("Scanner", scannerTests),
    ("TOML", tomlTests),
    ("Config", configTests),
    ("Onboarding", onboardingTests),
    ("DestinationProbe", destinationProbeTests),
    ("PathCompletion", pathCompletionTests),
    ("ConfigWarnings", configWarningTests),
    ("Analysis", analysisTests),
    ("Inventory", inventoryTests),
    ("Git", gitTests),
    ("Backup", backupTests),
    ("Alerts", alertTests),
    ("StorageWarnings", storageWarningTests),
    ("AI", aiTests),
    ("RestoreWarnings", restoreWarningTests),
    ("Restore", restoreTests),
    ("BackupWarnings", backupWarningTests),
    ("Updater", updaterTests),
    ("Hub", hubTests),
    ("Icons", iconTests),
]

let filter = CommandLine.arguments.dropFirst().first { !$0.hasPrefix("-") }
var passed = 0, failed = 0
for (suite, tests) in suites {
    for t in tests {
        let name = "\(suite).\(t.name)"
        if let filter, !name.localizedCaseInsensitiveContains(filter) { continue }
        do {
            try t.body()
            passed += 1
            print("✓ \(name)")
        } catch {
            failed += 1
            print("✗ \(name)\n    \(error)")
        }
    }
}
print("\n\(passed) réussi(s), \(failed) échoué(s)")
exit(failed == 0 ? 0 : 1)
