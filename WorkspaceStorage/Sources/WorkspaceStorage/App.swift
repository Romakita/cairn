import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct WorkspaceStorageApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    /// `WorkspaceStorage --report [dossier]` : analyse en ligne de commande, sans interface.
    init() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--report") else { return }
        let root = args.count > i + 1 ? args[i + 1] : "/Volumes/workspaces"
        let r = Scanner.scan(root: root, ctx: ScanContext())
        print("\(root) — \(Fmt.bytes(r.root.size)) (\(r.root.size) o), \(Fmt.count(r.root.fileCount)) fichiers, "
              + "\(String(format: "%.1f", r.duration)) s, \(r.errors) erreurs")
        for c in Category.allCases where r.root.bytes(c) > 0 {
            print("  \(c.label.padding(toLength: 34, withPad: " ", startingAt: 0)) \(Fmt.bytes(r.root.bytes(c)))")
        }
        print("Dossiers :")
        for n in r.root.children.prefix(20) {
            print("  \(n.name.padding(toLength: 22, withPad: " ", startingAt: 0)) \(Fmt.bytes(n.size).padding(toLength: 10, withPad: " ", startingAt: 0)) dont régénérable \(Fmt.bytes(n.regenerableBytes))")
        }
        exit(0)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .onAppear {
                    if model.root == nil && !model.isScanning && FileManager.default.fileExists(atPath: model.rootPath) {
                        model.scan()
                    }
                }
        }
        .defaultSize(width: 1240, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Choisir un dossier…") { model.chooseFolder() }.keyboardShortcut("o")
                Button("Analyser à nouveau") { model.scan() }.keyboardShortcut("r")
            }
        }
    }
}
