import AppKit
import CairnCore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct CairnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    init() {
        L10n.configure(explicit: nil)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .environment(\.locale, L10n.locale)
                .onAppear {
                    if model.root == nil && !model.isScanning && FileManager.default.fileExists(atPath: model.rootPath) {
                        model.scan()
                    }
                }
        }
        .defaultSize(width: 1240, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button(L10n.tr("action.choose_folder")) { model.chooseFolder() }.keyboardShortcut("o")
                Button(L10n.tr("action.rescan")) { model.scan() }.keyboardShortcut("r")
            }
        }
    }
}
