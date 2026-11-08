import CairnCore
import Foundation

// Un seul binaire : une sous-commande lance la ligne de commande, sinon l'interface.
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--snapshot" {
    MainActor.assumeIsolated {
        Snapshot.run(outDir: CommandLine.arguments[2],
                     sample: CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "/Volumes/workspaces/exports")
    }
    exit(0)
}
if CLI.isCommandLine(CommandLine.arguments) {
    exit(CLI.run(CommandLine.arguments).rawValue)
}
CairnApp.main()
