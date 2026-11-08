import AppKit
import CairnCore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static weak var model: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                // Après la fermeture, plus aucune fenêtre principale visible : l'app passe en barre des menus.
                DispatchQueue.main.async {
                    if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeMain }) {
                        AppDelegate.model?.background.windowsClosed()
                    }
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        MainActor.assumeIsolated { !(AppDelegate.model?.background.enabled ?? false) }
    }
}

struct CairnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    init() {
        L10n.configure(explicit: nil)
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            RootView()
                .environmentObject(model)
                .environment(\.locale, L10n.locale)
                .onAppear {
                    if AppDelegate.model == nil {
                        model.backups.start(model: model)
                        model.storage.start(model: model)
                    }
                    AppDelegate.model = model
                    model.background.windowOpened()
                    if !model.showOnboarding && model.root == nil && !model.isScanning
                        && FileManager.default.fileExists(atPath: model.rootPath) {
                        model.scan()
                    }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button(T("action.choose_folder")) { model.addFolder() }.keyboardShortcut("o")
                Button(T("action.rescan")) { model.scan() }.keyboardShortcut("r")
            }
            CommandGroup(replacing: .appSettings) {
                Button(T("section.settings")) { model.section = .settings }.keyboardShortcut(",")
            }
        }

        // Icône dans la barre des menus (seulement avec l'accord pour la tâche de fond).
        MenuBarExtra(isInserted: Binding(get: { model.config?.schedule.background ?? false }, set: { _ in })) {
            MenuBarPanel().environmentObject(model)
        } label: {
            Image(systemName: model.isBackingUp ? "arrow.triangle.2.circlepath"
                  : (model.globalStatus == .ok ? "square.stack.3d.up" : "exclamationmark.triangle"))
        }
        .menuBarExtraStyle(.window)
    }
}
