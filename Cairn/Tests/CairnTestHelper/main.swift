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

// Test de mémoire : hache le fichier hors du fil principal, comme pendant une sauvegarde (aucun pool n'y vide les
// blocs lus), puis affiche l'empreinte et l'augmentation de mémoire du processus. Un processus à part : les tests
// qui tournent en parallèle fausseraient la mesure.
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--hash-footprint" {
    let file = URL(fileURLWithPath: CommandLine.arguments[2])
    var growth: Int64 = 0
    var hash = ""
    let done = DispatchSemaphore(value: 0)
    Thread {
        let before = footprint()
        hash = (try? Integrity.sha256(of: file)) ?? ""
        growth = footprint() - before
        done.signal()
    }.start()
    done.wait()
    print("\(hash) \(growth)")
    exit(0)
}

/// Empreinte mémoire du processus (celle que suit le noyau), en octets.
func footprint() -> Int64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
}

FileHandle.standardError.write(Data("""
    usage: CairnTestHelper --hold-lock <fichier> [secondes] | --append-activity <dossier> <n> | --hash-footprint <fichier>

    """.utf8))
exit(2)
