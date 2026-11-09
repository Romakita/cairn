import AppKit
import CairnCore
import CairnUI
import SwiftUI

/// Catalogue des composants, lancé par `cairn --gallery` : une seule fenêtre, sans modèle, services ni barre des
/// menus de l'app. Rien n'est lu dans `~/.cairn`.
struct GalleryApp: App {
    @NSApplicationDelegateAdaptor(GalleryDelegate.self) var delegate

    init() {
        L10n.configure(explicit: nil)
    }

    var body: some Scene {
        WindowGroup(T("gallery.window.title")) {
            GalleryView()
                .frame(minWidth: 1100, minHeight: 680)
        }
        .defaultSize(width: 1280, height: 800)
    }
}

final class GalleryDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// Export statique du catalogue (`cairn --gallery-export <dossier>`) ; renvoie le code de sortie.
@MainActor
enum GalleryCommand {
    static func export(_ args: [String]) -> Int32 {
        guard let path = args.first, !path.hasPrefix("-") else {
            FileHandle.standardError.write(Data((T("gallery.export.usage") + "\n").utf8))
            return 2
        }
        L10n.configure(explicit: nil)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let dir = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        do {
            let count = try GalleryExport.run(outDir: dir)
            print(T("gallery.export.done", count, dir.standardizedFileURL.path))
            return 0
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            return 1
        }
    }
}
