import CairnCore
import Foundation

// Un seul binaire : une sous-commande lance la ligne de commande, sinon l'interface.
if CLI.isCommandLine(CommandLine.arguments) {
    exit(CLI.run(CommandLine.arguments).rawValue)
}
CairnApp.main()
