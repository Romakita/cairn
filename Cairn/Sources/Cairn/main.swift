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
// Catalogue des composants (développement) : fenêtre en direct ou export statique.
if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--gallery-export" {
    exit(MainActor.assumeIsolated { GalleryCommand.export(Array(CommandLine.arguments.dropFirst(2))) })
}
if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--gallery" {
    GalleryApp.main()
    exit(0)
}
// Les workers git sont des sous-processus de ce même binaire.
GitMaintenance.workerExecutable = Bundle.main.executablePath ?? CommandLine.arguments[0]
if CLI.isCommandLine(CommandLine.arguments) {
    exit(CLI.run(CommandLine.arguments).rawValue)
}
CairnApp.main()
