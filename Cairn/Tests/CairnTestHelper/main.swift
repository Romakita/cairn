import CairnCore
import Foundation

// Processus auxiliaire des tests : `swift test` ne peut pas relancer son propre binaire, les tests lancent celui-ci.

// Test de verrou : prend le verrou, l'annonce, attend puis se termine sans le libérer.
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--hold-lock" {
    let lock = OperationLock(url: URL(fileURLWithPath: CommandLine.arguments[2]))
    do { try lock.acquire(operation: "test") } catch { exit(3) }
    print("held"); fflush(stdout)
    let seconds = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0 : 0
    Thread.sleep(forTimeInterval: seconds)
    _exit(0) // fin brutale : le système doit libérer le verrou
}

// Test du journal d'activité : ajoute N événements dans le dossier CAIRN donné.
if CommandLine.arguments.count >= 4 && CommandLine.arguments[1] == "--append-activity" {
    let log = ActivityLog(paths: CairnPaths(root: URL(fileURLWithPath: CommandLine.arguments[2])))
    for n in 0..<(Int(CommandLine.arguments[3]) ?? 0) { log.append(.init(kind: .check, count: n)) }
    exit(0)
}

FileHandle.standardError.write(Data("usage: CairnTestHelper --hold-lock <fichier> [secondes] | --append-activity <dossier> <n>\n".utf8))
exit(2)
